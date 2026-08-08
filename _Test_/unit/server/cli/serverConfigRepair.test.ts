/**
 * Unit tests — server cli/serverConfigRepair.ts: the --password/--port/--reset
 * repair flow, and specifically Constraint 2 (fail closed) — a wrong
 * passphrase, or no saved config at all, must throw before anything is
 * prompted for or written, with no path to the forgot-passphrase reset menu.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { lockCipher } from "@loopycode/shared";
import {
  loadStartupSecrets,
  saveStartupSecrets,
  STARTUP_REL_PATH,
  unlockOrSetupStartupCipher,
} from "../../../../packages/server/src/config/startupSecrets.js";

vi.mock("../../../../packages/server/src/server/startupPrompts.js", () => ({
  promptListenPort: vi.fn(async () => 9999),
}));

import { runServerConfigRepair } from "../../../../packages/server/src/cli/serverConfigRepair.js";
import { promptListenPort } from "../../../../packages/server/src/server/startupPrompts.js";

const tempRoots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "loopy-server-repair-"),
  );
  tempRoots.push(root);
  return root;
};

/** Re-locks, then unlocks with the known passphrase, then reads back secrets — the standard "verify what actually landed on disk" step. */
const reloadSecrets = async (root: string, passphrase: string) => {
  lockCipher();
  await unlockOrSetupStartupCipher(root, async () => passphrase);
  return loadStartupSecrets(root);
};

afterEach(async () => {
  lockCipher();
  vi.clearAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("runServerConfigRepair — the gate (fail closed)", () => {
  it("refuses when no server config has been saved yet, and creates no files", async () => {
    const root = await makeRoot();
    await expect(
      runServerConfigRepair(
        root,
        { reset: false, password: false, port: 8001 },
        async () => "anything",
      ),
    ).rejects.toThrow(/no saved server config/i);
    await expect(fs.access(path.join(root, "user-data"))).rejects.toThrow();
  });

  it("wrong passphrase 3x throws, leaves startup.json byte-identical, and never reaches the reset menu or a value prompt", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "original-pw", port: 7000 });
    lockCipher();

    const startupPath = path.join(root, STARTUP_REL_PATH);
    const before = await fs.readFile(startupPath, "utf-8");

    const labels: string[] = [];
    await expect(
      runServerConfigRepair(
        root,
        { reset: false, password: true, port: 8001 },
        async (label) => {
          labels.push(label);
          return "still-wrong";
        },
      ),
    ).rejects.toThrow(/wrong passphrase.*nothing was changed/i);

    // Exactly the 3 gate attempts — never got far enough to prompt for the
    // new password, and never saw the [r]/[t]/[q] reset menu text.
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label).not.toMatch(/\[r\]/);
      expect(label).not.toMatch(/new server password/i);
    }
    expect(promptListenPort).not.toHaveBeenCalled();
    expect(await fs.readFile(startupPath, "utf-8")).toBe(before);

    // The original password survives, reachable under the correct passphrase.
    expect(await reloadSecrets(root, "correct-pass")).toEqual({
      password: "original-pw",
      port: 7000,
    });
  });
});

describe("runServerConfigRepair — --port", () => {
  it("saves an explicit port without touching the password", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "pw", port: 7000 });
    lockCipher();

    await runServerConfigRepair(
      root,
      { reset: false, password: false, port: 8001 },
      async () => "correct-pass",
    );

    expect(await reloadSecrets(root, "correct-pass")).toEqual({
      password: "pw",
      port: 8001,
    });
  });

  it("bare --port ('prompt') runs the interactive port prompt", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "pw", port: 7000 });
    lockCipher();

    await runServerConfigRepair(
      root,
      { reset: false, password: false, port: "prompt" },
      async () => "correct-pass",
    );
    expect(promptListenPort).toHaveBeenCalledTimes(1);

    expect(await reloadSecrets(root, "correct-pass")).toEqual({
      password: "pw",
      port: 9999,
    });
  });
});

describe("runServerConfigRepair — --password", () => {
  it("prompts for and saves a new password without touching the port", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "old-pw", port: 7000 });
    lockCipher();

    const prompts: string[] = [];
    await runServerConfigRepair(
      root,
      { reset: false, password: true },
      async (label) => {
        prompts.push(label);
        return label === "New server password: " ? "new-pw" : "correct-pass";
      },
    );
    expect(prompts).toContain("New server password: ");

    expect(await reloadSecrets(root, "correct-pass")).toEqual({
      password: "new-pw",
      port: 7000,
    });
  });

  it("refuses to save an empty password, and changes nothing", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "old-pw", port: 7000 });
    lockCipher();

    await expect(
      runServerConfigRepair(
        root,
        { reset: false, password: true },
        async (label) =>
          label === "New server password: " ? "   " : "correct-pass",
      ),
    ).rejects.toThrow(/empty password/i);

    expect(await reloadSecrets(root, "correct-pass")).toEqual({
      password: "old-pw",
      port: 7000,
    });
  });
});

describe("runServerConfigRepair — --reset", () => {
  it("prompts for a new password and port, then replaces the old ones", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "old-pw", port: 8001 });
    lockCipher();

    const prompts: string[] = [];
    await runServerConfigRepair(
      root,
      { reset: true, password: false },
      async (label) => {
        prompts.push(label);
        return label === "New server password: " ? "fresh-pw" : "correct-pass";
      },
    );

    expect(promptListenPort).toHaveBeenCalledTimes(1);
    expect(prompts).toContain("New server password: ");
    expect(await reloadSecrets(root, "correct-pass")).toEqual({
      password: "fresh-pw",
      port: 9999,
    });
  });

  it("leaves the old values untouched when the new-password prompt is empty", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "old-pw", port: 8001 });
    lockCipher();

    await expect(
      runServerConfigRepair(
        root,
        { reset: true, password: false },
        async (label) =>
          label === "New server password: " ? "   " : "correct-pass",
      ),
    ).rejects.toThrow(/empty password/i);

    // Port was prompted, but nothing was saved yet — old values remain.
    expect(promptListenPort).toHaveBeenCalledTimes(1);
    expect(await reloadSecrets(root, "correct-pass")).toEqual({
      password: "old-pw",
      port: 8001,
    });
  });

  it("--reset --port uses the given port and still prompts for a new password", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "old-pw", port: 8001 });
    lockCipher();

    await runServerConfigRepair(
      root,
      { reset: true, password: false, port: 9090 },
      async (label) =>
        label === "New server password: " ? "fresh-pw" : "correct-pass",
    );

    expect(promptListenPort).not.toHaveBeenCalled();
    expect(await reloadSecrets(root, "correct-pass")).toEqual({
      password: "fresh-pw",
      port: 9090,
    });
  });

  it("--reset --password is the same as --reset (still collects both)", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "old-pw", port: 8001 });
    lockCipher();

    await runServerConfigRepair(
      root,
      { reset: true, password: true },
      async (label) =>
        label === "New server password: " ? "fresh-pw" : "correct-pass",
    );

    expect(promptListenPort).toHaveBeenCalledTimes(1);
    expect(await reloadSecrets(root, "correct-pass")).toEqual({
      password: "fresh-pw",
      port: 9999,
    });
  });
});
