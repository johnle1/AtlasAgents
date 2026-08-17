/**
 * Unit tests — server config/startupSecrets.ts: encrypted password/port
 * persistence, the two unlock gates (`unlockOrSetupStartupCipher` for
 * `start`, with its reset menu; `unlockExistingStartupCipher` for
 * `--password`/`--port`/`--reset` repair mode, fail-closed with no reset
 * menu), and the salt-sharing contract with ConfigManager's provider cipher.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { lockCipher } from "@atlasagents/shared";
import { ConfigManager } from "../../../../packages/server/src/config/index.js";
import {
  findExistingEnvelope,
  loadStartupSecrets,
  saveStartupSecrets,
  STARTUP_REL_PATH,
  unlockExistingStartupCipher,
  unlockOrSetupStartupCipher,
} from "../../../../packages/server/src/config/startupSecrets.js";

const tempRoots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "atlas-startup-secrets-"),
  );
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  lockCipher();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("unlockOrSetupStartupCipher — first run", () => {
  it("prompts once for a new passphrase when nothing is saved yet", async () => {
    const root = await makeRoot();
    const labels: string[] = [];
    await unlockOrSetupStartupCipher(root, async (label) => {
      labels.push(label);
      return "first-pass";
    });
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/passphrase/i);
  });
});

describe("saveStartupSecrets / loadStartupSecrets — round trip", () => {
  it("encrypts on save and decrypts back the same values", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "round-trip-pass");
    await saveStartupSecrets(root, { password: "hunter2", port: 8001 });

    const raw = await fs.readFile(path.join(root, STARTUP_REL_PATH), "utf-8");
    expect(raw).toContain("$startupSecrets");
    expect(raw).not.toContain("hunter2");

    expect(await loadStartupSecrets(root)).toEqual({
      password: "hunter2",
      port: 8001,
    });
  });

  it("returns {} when nothing has been saved yet", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "empty-pass");
    expect(await loadStartupSecrets(root)).toEqual({});
  });
});

describe("unlockOrSetupStartupCipher — restart", () => {
  it("unlocks an existing file with the correct passphrase on the first try", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "restart-pass");
    await saveStartupSecrets(root, { password: "pw", port: 7000 });
    lockCipher();

    let promptCount = 0;
    await unlockOrSetupStartupCipher(root, async () => {
      promptCount += 1;
      return "restart-pass";
    });
    expect(promptCount).toBe(1);
    expect(await loadStartupSecrets(root)).toEqual({
      password: "pw",
      port: 7000,
    });
  });

  it("retries after a wrong passphrase, then succeeds", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "pw", port: 7000 });
    lockCipher();

    const attempts = ["wrong-1", "wrong-2", "correct-pass"];
    let promptCount = 0;
    await unlockOrSetupStartupCipher(root, async () => {
      const value = attempts[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(3);
  });

  it("wrong passphrase attempts never mutate the saved password", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "original-pw", port: 7000 });
    lockCipher();

    const attempts = ["wrong-1", "wrong-2", "correct-pass"];
    let promptCount = 0;
    await unlockOrSetupStartupCipher(root, async () => {
      const value = attempts[promptCount];
      promptCount += 1;
      return value;
    });
    expect(await loadStartupSecrets(root)).toEqual({
      password: "original-pw",
      port: 7000,
    });
  });

  it("forgot passphrase: 'quit' aborts and leaves the file untouched", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "pw", port: 7000 });
    lockCipher();

    const startupPath = path.join(root, STARTUP_REL_PATH);
    const before = await fs.readFile(startupPath, "utf-8");

    const responses = ["wrong-1", "wrong-2", "wrong-3", "q"];
    let promptCount = 0;
    await expect(
      unlockOrSetupStartupCipher(root, async () => {
        const value = responses[promptCount];
        promptCount += 1;
        return value;
      }),
    ).rejects.toThrow(/aborted/i);
    expect(await fs.readFile(startupPath, "utf-8")).toBe(before);
  });

  it("forgot passphrase: 'reset' clears BOTH startup.json and config.json, and the new passphrase reads both", async () => {
    const root = await makeRoot();

    // Set up startup secrets AND provider secrets under the same passphrase.
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "pw", port: 7000 });

    const manager = new ConfigManager({ rootDir: root });
    // Cipher is already unlocked (shared with startup secrets) — no prompt.
    await manager.unlockOrSetupProvidersCipher(async () => {
      throw new Error("should not prompt — cipher already unlocked");
    });
    await manager.addProvider("openai", {
      baseUrl: "https://api.openai.com",
      apiKey: "sk-secret",
    });
    await manager.setModel("agent", "gemma3:27b");

    lockCipher();

    const startupPath = path.join(root, STARTUP_REL_PATH);
    const configPath = path.join(root, "user-data", "config.json");
    const startupBefore = await fs.readFile(startupPath, "utf-8");
    const configBefore = await fs.readFile(configPath, "utf-8");

    const responses = [
      "wrong-1",
      "wrong-2",
      "wrong-3",
      "r",
      "yes",
      "brand-new-pass",
    ];
    let promptCount = 0;
    await unlockOrSetupStartupCipher(root, async () => {
      const value = responses[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(6);

    // startup.json's envelope is gone entirely.
    await expect(fs.access(startupPath)).rejects.toThrow();
    expect(await loadStartupSecrets(root)).toEqual({});

    // config.json's $providersSecrets is gone but everything else preserved,
    // and the cipher is already unlocked with the new passphrase.
    const manager2 = new ConfigManager({ rootDir: root });
    await manager2.unlockOrSetupProvidersCipher(async () => {
      throw new Error("should not prompt — cipher already unlocked");
    });
    expect(await manager2.getProviders()).toEqual({});
    expect(await manager2.getAgentModel()).toBe("gemma3:27b");

    // Backups exist for both files.
    const startupDir = path.dirname(startupPath);
    const startupBackups = (await fs.readdir(startupDir)).filter((name) =>
      name.startsWith("startup.json.bak-"),
    );
    expect(startupBackups).toHaveLength(1);
    expect(
      await fs.readFile(path.join(startupDir, startupBackups[0]), "utf-8"),
    ).toBe(startupBefore);

    const configDir = path.dirname(configPath);
    const configBackups = (await fs.readdir(configDir)).filter((name) =>
      name.startsWith("config.json.bak-"),
    );
    expect(configBackups).toHaveLength(1);
    expect(
      await fs.readFile(path.join(configDir, configBackups[0]), "utf-8"),
    ).toBe(configBefore);
  });
});

describe("findExistingEnvelope — legacy config.json-only upgrade path", () => {
  it("unlocks against config.json's $providersSecrets when startup.json doesn't exist yet", async () => {
    const root = await makeRoot();

    // Simulate a pre-existing install: only config.json has an envelope.
    const manager = new ConfigManager({ rootDir: root });
    await manager.unlockOrSetupProvidersCipher(async () => "legacy-pass");
    await manager.addProvider("vllm", { baseUrl: "http://10.0.0.9:8000" });
    lockCipher();

    let promptCount = 0;
    await unlockOrSetupStartupCipher(root, async () => {
      promptCount += 1;
      return "legacy-pass";
    });
    expect(promptCount).toBe(1);

    // startup.json didn't exist, so there's nothing saved there yet.
    expect(await loadStartupSecrets(root)).toEqual({});

    // A newly-saved startup envelope shares the salt already used by config.json.
    await saveStartupSecrets(root, { password: "pw", port: 7000 });
    const envelope = await findExistingEnvelope(root);
    const configEnvelope = JSON.parse(
      await fs.readFile(path.join(root, "user-data", "config.json"), "utf-8"),
    ).$providersSecrets;
    expect(envelope?.salt).toBe(configEnvelope.salt);
  });
});

describe("cross-module: ConfigManager.unlockOrSetupProvidersCipher skips prompting once the shared cipher is unlocked", () => {
  it("brand-new install: neither file exists yet — no second prompt", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "shared-pass");

    const manager = new ConfigManager({ rootDir: root });
    await manager.unlockOrSetupProvidersCipher(async () => {
      throw new Error("should not prompt — cipher already unlocked");
    });

    await manager.addProvider("openai", {
      baseUrl: "https://api.openai.com",
      apiKey: "sk-1",
    });
    expect(await manager.getProviders()).toEqual({
      openai: { baseUrl: "https://api.openai.com", apiKey: "sk-1" },
    });
  });

});

describe("unlockExistingStartupCipher — fail-closed repair gate", () => {
  it("refuses when nothing has been saved yet, and creates no files", async () => {
    const root = await makeRoot();
    await expect(
      unlockExistingStartupCipher(root, async () => "anything"),
    ).rejects.toThrow(/no saved server config/i);
    await expect(fs.access(path.join(root, "user-data"))).rejects.toThrow();
  });

  it("throws after 3 wrong attempts, changes nothing, and never offers the reset menu", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "pw", port: 7000 });
    lockCipher();

    const startupPath = path.join(root, STARTUP_REL_PATH);
    const before = await fs.readFile(startupPath, "utf-8");

    const labels: string[] = [];
    await expect(
      unlockExistingStartupCipher(root, async (label) => {
        labels.push(label);
        return "still-wrong";
      }),
    ).rejects.toThrow(/wrong passphrase.*nothing was changed/i);

    // Exactly 3 attempts, every one the plain passphrase label — the
    // [r]/[t]/[q] reset menu text never appears.
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label).not.toMatch(/\[r\]/);
    }

    // Byte-identical — nothing was written, not even a failed attempt marker.
    expect(await fs.readFile(startupPath, "utf-8")).toBe(before);
  });

  it("succeeds on the correct passphrase without mutating anything", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "pw", port: 7000 });
    lockCipher();

    await unlockExistingStartupCipher(root, async () => "correct-pass");
    expect(await loadStartupSecrets(root)).toEqual({
      password: "pw",
      port: 7000,
    });
  });

  it("retries within the attempt budget before succeeding", async () => {
    const root = await makeRoot();
    await unlockOrSetupStartupCipher(root, async () => "correct-pass");
    await saveStartupSecrets(root, { password: "pw", port: 7000 });
    lockCipher();

    const attempts = ["wrong-1", "correct-pass"];
    let promptCount = 0;
    await unlockExistingStartupCipher(root, async () => {
      const value = attempts[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(2);
  });
});
