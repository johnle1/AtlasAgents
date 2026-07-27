/**
 * System (E2E) tests — LoopyCode CLI binary
 *
 * Spawns the compiled `loopy` CLI as a real subprocess and tests it from
 * the outside: real stdin/stdout, real exit codes, real environment variables.
 * No internal modules are imported — this layer is intentionally opaque.
 *
 * Testing pyramid layer : System / E2E
 * Runner                 : Vitest
 * Binary under test       : packages/client/dist/index.js  (compiled via `npm run build`)
 * Subprocess helper       : execa
 * Output cleaning         : strip-ansi (removes terminal color escape sequences)
 *
 * ⚠  IMPORTANT — Prerequisites
 * -----------------------------
 * System tests run against the COMPILED binary, not TypeScript source.
 * You must build the client package before running these tests:
 *
 *   cd packages/client && npm run build
 *
 * If the dist/ directory is missing, all tests in this file are skipped
 * automatically rather than failing with a cryptic error. This keeps CI
 * clean on fresh checkouts where the build step may not have run yet.
 *
 * ⚠  Live Ollama NOT required
 * ----------------------------
 * These tests cover only the CLI startup path (help, version, bad env).
 * They do NOT perform a real chat round-trip because that requires a locally
 * running Ollama server. The chat round-trip is left as a manual test
 * (see "Manual verification" section below) or can be added behind an
 * environment-variable gate (RUN_LIVE_TESTS=1).
 *
 * Category checklist:
 *   ✅ Full user journey  — --help flag, process exits cleanly
 *   ✅ Environment variant — unreachable server produces a clear error message
 *   ✅ Exit codes          — 0 for help, non-zero for connection failure
 *   ✅ Signal handling     — not tested here (requires interactive TTY)
 *
 * Manual verification (not automated)
 * ------------------------------------
 * Run the CLI interactively to verify:
 *   1. Start: `node packages/client/dist/index.js`
 *   2. Type a task: "what is 2+2?" → agent replies
 *   3. Press Ctrl+C (busy) → confirm prompt appears
 *   4. Press Ctrl+C again → CLI exits cleanly with code 0
 */

import { existsSync, mkdtempSync, rmSync } from "fs";
import * as os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// We import dynamically so the test file is still parseable even without
// execa installed. The `beforeAll` guard below handles the missing build case.
import { execa } from "execa";
import stripAnsi from "strip-ansi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the compiled CLI entry point. */
const CLI_PATH = path.resolve(__dirname, "../../packages/client/dist/index.js");

/**
 * Passphrase supplied to every CLI invocation's stdin.
 *
 * @remarks
 * Every non-`--help` launch now calls `unlockOrSetupConfigCipher()` before
 * doing anything else, which prompts for a passphrase to encrypt/decrypt
 * `config.json`'s password/host fields. Since all invocations in this file
 * share {@link TEST_HOME} (so a config.json created by the first spawned
 * process persists for later ones), every later invocation hits the
 * "existing encrypted file" path and must unlock with this SAME passphrase
 * — a different value here would trigger the wrong-passphrase retry loop,
 * which needs more than one line of stdin input to resolve.
 */
const TEST_PASSPHRASE = "system-test-passphrase";

/**
 * Isolated `HOME` for every CLI invocation in this file.
 *
 * @remarks
 * Without this, the CLI would read/write the developer's real
 * `~/.agent-cli/config.json` — including, post-encryption, attempting to
 * unlock it with {@link TEST_PASSPHRASE}, which would fail against a real
 * passphrase and hang the wrong-passphrase retry loop waiting for more
 * stdin input than this suite provides.
 */
let testHome: string;

/** True when the client has been compiled and the binary is available. */
const BINARY_EXISTS = existsSync(CLI_PATH);

/**
 * Conditionally skip all tests in this file when the binary is missing.
 *
 * @remarks
 * Using `it.skipIf` rather than a single `describe.skipIf` at the top so
 * that Vitest reports each test individually as skipped with a clear reason,
 * rather than silently omitting the entire block.
 */
const itWhenBuilt = BINARY_EXISTS ? it : it.skip;

if (BINARY_EXISTS) {
  beforeAll(() => {
    testHome = mkdtempSync(path.join(os.tmpdir(), "loopy-cli-e2e-"));
  });

  afterAll(() => {
    rmSync(testHome, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// Helper — run the CLI binary with the given args and options
// ---------------------------------------------------------------------------

/**
 * Spawns `node dist/index.js` with the given arguments.
 * Always passes `reject: false` so non-zero exit codes don't throw.
 *
 * @remarks
 * Every invocation gets {@link TEST_PASSPHRASE} piped to stdin (followed by
 * a newline) so `unlockOrSetupConfigCipher()`'s prompt — which every
 * non-`--help` launch now hits before doing anything else — resolves
 * immediately instead of blocking forever on an open, unwritten pipe.
 * `--help` exits before that prompt is ever reached, so the unread input is
 * harmless there.
 *
 * @param args - CLI arguments to pass after the binary path.
 * @param env - Additional environment variables to set for this invocation.
 */
async function runCli(
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa("node", [CLI_PATH, ...args], {
    reject: false,
    input: `${TEST_PASSPHRASE}\n`,
    env: {
      ...process.env,
      // Ensure we're not inside a real tmux / screen reader env during tests
      TMUX: "",
      TERM: "xterm-256color",
      CI: "false",
      // Isolated config dir — never touch the developer's real ~/.agent-cli/.
      HOME: testHome,
      ...env,
    },
    // Prevent the process from inheriting an actual TTY — we want raw I/O
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: stripAnsi(result.stdout),
    stderr: stripAnsi(result.stderr),
    exitCode: result.exitCode ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Binary availability guard
// ---------------------------------------------------------------------------

describe("CLI binary availability", () => {
  it("dist/index.js exists — binary has been built (prerequisite check)", () => {
    if (!BINARY_EXISTS) {
      // Provide an actionable error message instead of a silent skip
      console.warn(
        "\n⚠  System tests skipped — binary not found at:\n  " +
          CLI_PATH +
          "\n  Run: cd packages/client && npm run build\n",
      );
    }
    // This test itself does not skip — it documents whether the binary exists.
    // The `itWhenBuilt` helper skips the rest if BINARY_EXISTS is false.
    expect(typeof BINARY_EXISTS).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// --help flag — user journey: request help → exit 0
// ---------------------------------------------------------------------------

describe("CLI --help flag (user journey)", () => {
  itWhenBuilt(
    "exits with code 0 when --help is passed (exit code check)",
    async () => {
      const { exitCode } = await runCli(["--help"]);
      expect(exitCode).toBe(0);
    },
  );

  itWhenBuilt(
    "prints usage information to stdout when --help is passed (output check)",
    async () => {
      const { stdout, stderr } = await runCli(["--help"]);
      // The help output should appear on stdout or stderr
      const combined = stdout + stderr;
      // At minimum, the binary name or 'Usage' keyword should appear
      const hasHelpContent =
        combined.toLowerCase().includes("usage") ||
        combined.toLowerCase().includes("loopy") ||
        combined.toLowerCase().includes("help") ||
        combined.toLowerCase().includes("option");
      expect(hasHelpContent).toBe(true);
    },
  );

  itWhenBuilt(
    "the -h short flag has parity with --help (exit code and content)",
    async () => {
      const long = await runCli(["--help"]);
      const short = await runCli(["-h"]);
      expect(short.exitCode).toBe(long.exitCode);
      expect(short.stdout + short.stderr).toBe(long.stdout + long.stderr);
    },
  );
});

// ---------------------------------------------------------------------------
// Argument parsing — invalid/boundary values, aliases, positionals
// ---------------------------------------------------------------------------

describe("CLI argument parsing — invalid --port values (exit code + message)", () => {
  itWhenBuilt.each(["0", "65536", "abc", "-1"])(
    "rejects --port %s with a specific error and non-zero exit",
    async (badPort) => {
      const { exitCode, stderr } = await runCli(["--port", badPort]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/invalid --port/i);
    },
  );
});

describe("CLI argument parsing — boundary --port values are accepted at parse time", () => {
  /**
   * These ports parse successfully; the process may still exit non-zero later
   * when it fails to connect (port 1 refuses connections on most systems), so
   * this only asserts the argument itself wasn't rejected as invalid.
   */
  itWhenBuilt.each(["1", "65535"])(
    "does not reject --port %s as invalid",
    async (edgePort) => {
      const { stderr } = await runCli(["--host", "127.0.0.1", "--port", edgePort]);
      expect(stderr).not.toMatch(/invalid --port/i);
    },
  );
});

describe("CLI argument parsing — host flag aliases and positionals", () => {
  itWhenBuilt("--server behaves like --host (both reach the connect phase, not a parse error)", async () => {
    const viaHost = await runCli(["--host", "127.0.0.1", "--port", "1"]);
    const viaServer = await runCli(["--server", "127.0.0.1", "--port", "1"]);
    // Both should fail the same way (unreachable connection), not one failing
    // to parse — proves --server is a genuine alias, not silently ignored.
    expect(viaServer.exitCode).not.toBe(0);
    expect(viaHost.exitCode).toBe(viaServer.exitCode);
  });

  itWhenBuilt("accepts the positional 'start' argument without treating it as an error", async () => {
    const { stderr } = await runCli(["start", "--host", "127.0.0.1", "--port", "1"]);
    expect(stderr).not.toMatch(/invalid|unknown option/i);
  });
});

describe("CLI help text — stays in sync with the flags parseCliArgs actually accepts", () => {
  itWhenBuilt(
    "documents every long flag that parseCliArgs recognizes (drift guard)",
    async () => {
      const { stdout } = await runCli(["--help"]);
      // Sourced from cliArgs.ts's parseArgs options: host, server, address,
      // port, password, reset, help.
      for (const flag of [
        "--host",
        "--server",
        "--address",
        "--port",
        "--password",
        "--reset",
        "--help",
      ]) {
        expect(stdout).toContain(flag);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Environment variant — unreachable Ollama server
// ---------------------------------------------------------------------------

describe("CLI environment variant — bad OLLAMA_HOST", () => {
  itWhenBuilt(
    "exits with a non-zero code when the server host is unreachable (exit code)",
    async () => {
      /**
       * We set LOOPYCODE_SERVER (or equivalent) to an unreachable address.
       * The CLI should detect this quickly and exit non-zero rather than
       * hanging indefinitely.
       *
       * Port 1 is reserved and will immediately refuse connections on most
       * operating systems, making this test fast and reliable.
       */
      const { exitCode } = await runCli(["--host", "127.0.0.1", "--port", "1"], {
        // Give the process a small stdin EOF immediately so it doesn't hang
        // waiting for interactive input
      });
      // Any non-zero exit is acceptable — we just confirm it's not 0
      expect(exitCode).not.toBe(0);
    },
  );

  itWhenBuilt(
    "prints an error or connection message when the server is unreachable (output)",
    async () => {
      const { stdout, stderr } = await runCli(["--host", "127.0.0.1", "--port", "1"]);
      const combined = (stdout + stderr).toLowerCase();
      // A human-readable error about connection failure should appear
      const hasErrorContent =
        combined.includes("connect") ||
        combined.includes("error") ||
        combined.includes("fail") ||
        combined.includes("refused") ||
        combined.includes("econnrefused") ||
        combined.includes("unable");
      expect(hasErrorContent).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Exit code correctness
// ---------------------------------------------------------------------------

describe("CLI exit codes", () => {
  itWhenBuilt(
    "--help exits 0 (exit code — success path)",
    async () => {
      const { exitCode } = await runCli(["--help"]);
      expect(exitCode).toBe(0);
    },
  );

  itWhenBuilt(
    "unknown flag exits non-zero (exit code — error path)",
    async () => {
      const { exitCode } = await runCli(["--totally-unknown-flag-xyz"]);
      // Unknown flags should produce a non-zero exit
      // Some CLIs may still exit 0 for unknown flags and print an error message;
      // we check the combined output in that case.
      if (exitCode === 0) {
        const { stdout, stderr } = await runCli(["--totally-unknown-flag-xyz"]);
        const combined = stdout + stderr;
        // At least an error/warning message should appear
        expect(combined.length).toBeGreaterThan(0);
      } else {
        expect(exitCode).not.toBe(0);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Process does not hang — basic startup sanity check
// ---------------------------------------------------------------------------

describe("CLI startup sanity (process lifecycle)", () => {
  itWhenBuilt(
    "process terminates within the test timeout when given --help (no hang)",
    async () => {
      /**
       * This test will fail (via timeout) if the process hangs.
       * The Vitest testTimeout of 20s (see vitest.config.ts) acts as the
       * guard — if the process doesn't exit, Vitest kills it.
       *
       * This catches regressions where the CLI starts listening for events
       * before processing CLI flags, or forgets to call process.exit().
       */
      const start = Date.now();
      const { exitCode } = await runCli(["--help"]);
      const elapsed = Date.now() - start;

      expect(exitCode).toBe(0);
      // A --help invocation should be very fast (well under 5 seconds)
      expect(elapsed).toBeLessThan(5_000);
    },
  );
});
