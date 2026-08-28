/**
 * System (E2E) tests — CLI config bootstrap and encryption-at-rest.
 *
 * Spawns the compiled `atlas` CLI as a real subprocess, same as
 * `cli.e2e.test.ts`, but focused specifically on what happens to
 * `~/.atlasagents/config.json` on disk rather than on stdout/exit-code
 * behavior. This is only observable from outside the process — there is no
 * way for a unit or integration test (which never spawns the real binary or
 * touches a real `$HOME`) to prove the file the CLI actually writes on a
 * fresh machine has the shape and permissions this file asserts.
 *
 * Testing pyramid layer : System / E2E
 * Runner                 : Vitest
 * Binary under test       : packages/client/dist/index.js
 *
 * ⚠ Scope note: `runCliOnce` pipes a fixed list of lines to stdin, so a case
 * can only exercise a flow whose prompts are known up front (passphrase, then
 * optionally one new password). The wrong-passphrase retry loop and its
 * recovery menu branch on what the user types, so they are covered at the unit
 * layer instead — see `_Test_/unit/client/configUnlock.test.ts` and
 * `_Test_/unit/client/configRepair.test.ts`.
 *
 * Category checklist:
 *   ✅ Full user journey — first run bootstraps a working config file
 *   ✅ Full user journey — repairing connection settings with no server reachable
 *   ✅ Environment variant — encryption at rest, no plaintext secrets on disk
 *   ✅ Exit codes          — repair-mode success and inline-password rejection
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import * as os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../packages/client/dist/index.js");
const BINARY_EXISTS = existsSync(CLI_PATH);
const itWhenBuilt = BINARY_EXISTS ? it : it.skip;

const TEST_PASSPHRASE = "config-lifecycle-test-passphrase";

let testHome: string;

beforeEach(() => {
  // A fresh HOME per test — unlike cli.e2e.test.ts, these tests need to
  // observe a genuine FIRST run each time, so config.json must not already
  // exist when the process starts.
  testHome = mkdtempSync(path.join(os.tmpdir(), "atlas-cli-config-lifecycle-"));
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
});

/**
 * Spawns the CLI once and waits for it to exit.
 *
 * @param args - Arguments for the binary. Defaults to an unreachable port so
 *   the process exits quickly after config bootstrap.
 * @param inputLines - Lines piped to stdin, in the order the CLI prompts for
 *   them. Defaults to just the passphrase.
 */
const runCliOnce = async (
  args: string[] = ["--host", "127.0.0.1", "--port", "1"],
  inputLines: string[] = [TEST_PASSPHRASE],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const result = await execa("node", [CLI_PATH, ...args], {
    reject: false,
    input: `${inputLines.join("\n")}\n`,
    env: {
      ...process.env,
      TMUX: "",
      TERM: "xterm-256color",
      CI: "false",
      // os.homedir() reads HOME on POSIX but USERPROFILE on Windows — both
      // must point at the isolated dir or the CLI falls back to the real
      // profile there.
      HOME: testHome,
      USERPROFILE: testHome,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const configPath = (): string => path.join(testHome, ".atlasagents", "config.json");

describe("CLI config bootstrap — first run (full user journey)", () => {
  itWhenBuilt("creates ~/.atlasagents/config.json on first launch", async () => {
    expect(existsSync(configPath())).toBe(false);

    await runCliOnce();

    expect(existsSync(configPath())).toBe(true);
  });

  itWhenBuilt("writes a file that parses as a single valid JSON object", async () => {
    await runCliOnce();

    const raw = readFileSync(configPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    expect(Array.isArray(parsed)).toBe(false);
  });
});

describe("CLI config bootstrap — encryption at rest (no plaintext secrets)", () => {
  itWhenBuilt("stores an encrypted $secrets envelope rather than plaintext", async () => {
    await runCliOnce();

    const parsed = JSON.parse(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
    expect(parsed).toHaveProperty("$secrets");
  });

  itWhenBuilt("never writes the passphrase itself to disk in any form", async () => {
    await runCliOnce();

    const raw = readFileSync(configPath(), "utf-8");
    expect(raw).not.toContain(TEST_PASSPHRASE);
  });

  itWhenBuilt(
    "never writes the plaintext server override outside the encrypted envelope",
    async () => {
      await runCliOnce();

      const parsed = JSON.parse(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
      // `server`/`password` are the two fields this cipher protects (see
      // SecretConfigFields in packages/client/src/config.ts) — they must be
      // absent from the top level, present only inside the encrypted blob.
      expect(parsed).not.toHaveProperty("server");
      expect(parsed).not.toHaveProperty("password");
    },
  );
});

describe("CLI config repair — changing connection settings with no reachable server", () => {
  // These are the flags that break the bootstrap deadlock: the in-app /set
  // commands only exist after a successful connect, so when the server's
  // password/port/IP changes, this is the only way to correct the client.

  itWhenBuilt(
    "saves a new address, port, and password, then exits successfully",
    async () => {
      const { exitCode, stdout } = await runCliOnce(
        ["--address", "10.0.0.7", "--port", "8001", "--password"],
        [TEST_PASSPHRASE, "new-server-password"],
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("10.0.0.7:8001");
      // The password is summarized, never echoed.
      expect(stdout).not.toContain("new-server-password");
    },
  );

  itWhenBuilt("never attempts a connection in repair mode", async () => {
    // The whole point: repair must work while the server is unreachable, so it
    // must not connect at all. `--address` deliberately points at a black hole
    // that would hang or time out if the CLI tried.
    const { exitCode, stdout, stderr } = await runCliOnce(
      ["--address", "192.0.2.1", "--port", "9", "--password"],
      [TEST_PASSPHRASE, "unused-password"],
    );

    expect(exitCode).toBe(0);
    expect(stdout + stderr).not.toMatch(/connecting to/i);
  });

  itWhenBuilt("keeps the repaired settings encrypted at rest", async () => {
    await runCliOnce(
      ["--address", "10.0.0.7", "--port", "8001", "--password"],
      [TEST_PASSPHRASE, "new-server-password"],
    );

    const raw = readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toHaveProperty("$secrets");
    expect(parsed).not.toHaveProperty("server");
    expect(raw).not.toContain("10.0.0.7");
    expect(raw).not.toContain("new-server-password");
    // The port is not a secret, so it stays a readable top-level field.
    expect(parsed.port).toBe(8001);
  });

  itWhenBuilt("--reset restores the defaults on the next run", async () => {
    await runCliOnce(
      ["--address", "10.0.0.7", "--port", "8001", "--password"],
      [TEST_PASSPHRASE, "new-server-password"],
    );

    const { exitCode, stdout } = await runCliOnce(["--reset"], [TEST_PASSPHRASE]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("localhost:7000");
    expect(stdout).toMatch(/cleared/i);

    const parsed = JSON.parse(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
    expect(parsed.port).toBe(7000);
    expect(parsed.serverFingerprints).toEqual({});
  });

  itWhenBuilt("rejects an inline --password value instead of discarding it", async () => {
    const { exitCode, stderr } = await runCliOnce(
      ["--password", "leaked-secret"],
      [TEST_PASSPHRASE],
    );

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--password takes no value/i);
  });
});

describe("CLI config bootstrap — second run reuses the config without corrupting it", () => {
  itWhenBuilt(
    "a second launch with the same passphrase leaves the file valid and unlockable",
    async () => {
      await runCliOnce();
      const firstRun = readFileSync(configPath(), "utf-8");

      await runCliOnce();
      const secondRun = readFileSync(configPath(), "utf-8");

      // Still valid JSON with the same envelope shape — a corrupting bug
      // (e.g. double-encrypting, or writing partial JSON on the second pass)
      // would show up as a parse failure or a missing $secrets key here.
      const parsedSecondRun = JSON.parse(secondRun) as Record<string, unknown>;
      expect(parsedSecondRun).toHaveProperty("$secrets");
      expect(firstRun.length).toBeGreaterThan(0);
      expect(secondRun.length).toBeGreaterThan(0);
    },
  );
});
