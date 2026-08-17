/**
 * Unit tests — client config.ts encryption-at-rest: unlockOrSetupConfigCipher
 * (first run / restart-unlock / wrong-passphrase retry / legacy migration)
 * and the loadConfig/saveConfig encryption round trip.
 *
 * @remarks
 * `config.ts` computes its config directory from `os.homedir()` once at
 * module load, so `HOME` is overridden and `config.js`/`configCipher.js` are
 * imported dynamically inside `beforeAll` — after the override — rather
 * than statically at the top of this file. Vitest isolates each test file's
 * module registry by default, so this doesn't leak into other test files.
 *
 * Each scenario resets state by deleting config.json and locking the cipher
 * (module-level state that would otherwise carry over between `it()` blocks
 * sharing one imported module instance) rather than using a fresh HOME per
 * test, since `CONFIG_FILE` is fixed at first import.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("config.ts — encryption at rest", () => {
  let loadConfig: typeof import("../../../../packages/client/src/config/index.js").loadConfig;
  let saveConfig: typeof import("../../../../packages/client/src/config/index.js").saveConfig;
  let setConfig: typeof import("../../../../packages/client/src/config/index.js").setConfig;
  let unlockOrSetupConfigCipher: typeof import("../../../../packages/client/src/config/index.js").unlockOrSetupConfigCipher;
  let rotateConfigPassphrase: typeof import("../../../../packages/client/src/config/index.js").rotateConfigPassphrase;
  let lockCipher: typeof import("@atlasagents/shared").lockCipher;
  let ConfigDecryptionError: typeof import("@atlasagents/shared").ConfigDecryptionError;
  let originalHome: string | undefined;
  let tempHome: string;
  let configFile: string;

  beforeAll(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-config-unlock-test-"));
    process.env.HOME = tempHome;
    configFile = path.join(tempHome, ".atlasagents", "config.json");

    const configMod = await import("../../../../packages/client/src/config/index.js");
    loadConfig = configMod.loadConfig;
    saveConfig = configMod.saveConfig;
    setConfig = configMod.setConfig;
    unlockOrSetupConfigCipher = configMod.unlockOrSetupConfigCipher;
    rotateConfigPassphrase = configMod.rotateConfigPassphrase;

    const cipherMod = await import("@atlasagents/shared");
    lockCipher = cipherMod.lockCipher;
    ConfigDecryptionError = cipherMod.ConfigDecryptionError;
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  afterEach(() => {
    lockCipher();
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
  });

  it("first run: prompts once, initializes the cipher, and encrypts the file it creates", async () => {
    const labels: string[] = [];
    await unlockOrSetupConfigCipher(async (label) => {
      labels.push(label);
      return "first-run-pass";
    });
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/passphrase/i);

    const cfg = loadConfig();
    expect(cfg.password).toBe("");
    expect(cfg.server).toBe("localhost");

    const raw = fs.readFileSync(configFile, "utf-8");
    expect(raw).toContain("$secrets");
    expect(raw).not.toContain('"password"');
  });

  it("round-trips password/server through save and reload", async () => {
    await unlockOrSetupConfigCipher(async () => "roundtrip-pass");
    setConfig("password", "hunter2");
    setConfig("server", "10.0.0.9");
    const reloaded = loadConfig();
    expect(reloaded.password).toBe("hunter2");
    expect(reloaded.server).toBe("10.0.0.9");
  });

  it("never writes the plaintext password anywhere in the on-disk file", async () => {
    await unlockOrSetupConfigCipher(async () => "leak-check-pass");
    setConfig("password", "extremely-unique-marker-value");
    const raw = fs.readFileSync(configFile, "utf-8");
    expect(raw).not.toContain("extremely-unique-marker-value");
  });

  it("restart: unlocks an existing encrypted file with the correct passphrase on the first try", async () => {
    await unlockOrSetupConfigCipher(async () => "restart-pass");
    setConfig("password", "s3cret");
    lockCipher(); // simulate process restart — cipher forgotten, file stays on disk

    let promptCount = 0;
    await unlockOrSetupConfigCipher(async () => {
      promptCount += 1;
      return "restart-pass";
    });
    expect(promptCount).toBe(1);
    expect(loadConfig().password).toBe("s3cret");
  });

  it("restart: retries after a wrong passphrase, then succeeds", async () => {
    await unlockOrSetupConfigCipher(async () => "correct-pass");
    setConfig("password", "s3cret");
    lockCipher();

    const attempts = ["wrong-1", "wrong-2", "correct-pass"];
    let promptCount = 0;
    await unlockOrSetupConfigCipher(async () => {
      const value = attempts[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(3);
    expect(loadConfig().password).toBe("s3cret");
  });

  it("forgot passphrase: 'try again' resets the attempt counter and can still succeed", async () => {
    await unlockOrSetupConfigCipher(async () => "correct-pass");
    setConfig("password", "s3cret");
    lockCipher();

    // 3 wrong entries trigger the menu; "t" should send it back to prompting
    // for the passphrase rather than resetting anything.
    const responses = ["wrong-1", "wrong-2", "wrong-3", "t", "correct-pass"];
    let promptCount = 0;
    await unlockOrSetupConfigCipher(async () => {
      const value = responses[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(5);
    expect(loadConfig().password).toBe("s3cret");
  });

  it("forgot passphrase: 'quit' aborts and leaves the file untouched", async () => {
    await unlockOrSetupConfigCipher(async () => "correct-pass");
    setConfig("password", "s3cret");
    lockCipher();

    const before = fs.readFileSync(configFile, "utf-8");
    const responses = ["wrong-1", "wrong-2", "wrong-3", "q"];
    let promptCount = 0;
    await expect(
      unlockOrSetupConfigCipher(async () => {
        const value = responses[promptCount];
        promptCount += 1;
        return value;
      }),
    ).rejects.toThrow(/aborted/i);
    expect(promptCount).toBe(4);
    expect(fs.readFileSync(configFile, "utf-8")).toBe(before);
  });

  it("forgot passphrase: 'reset' + cancelled confirmation falls back to retry, no file change", async () => {
    await unlockOrSetupConfigCipher(async () => "correct-pass");
    setConfig("password", "s3cret");
    lockCipher();

    const before = fs.readFileSync(configFile, "utf-8");
    const responses = ["wrong-1", "wrong-2", "wrong-3", "r", "not-yes", "correct-pass"];
    let promptCount = 0;
    await unlockOrSetupConfigCipher(async () => {
      const value = responses[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(6);
    expect(loadConfig().password).toBe("s3cret");
    expect(fs.readFileSync(configFile, "utf-8")).toBe(before);
  });

  it("forgot passphrase: 'reset' + confirmed wipes the secrets but preserves everything else", async () => {
    await unlockOrSetupConfigCipher(async () => "correct-pass");
    setConfig("password", "s3cret");
    setConfig("server", "old-host");
    setConfig("port", 8123);
    lockCipher();

    const before = fs.readFileSync(configFile, "utf-8");
    const responses = ["wrong-1", "wrong-2", "wrong-3", "r", "yes", "brand-new-pass"];
    let promptCount = 0;
    await unlockOrSetupConfigCipher(async () => {
      const value = responses[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(6);

    // Cipher is unlocked with the new passphrase — no further prompt needed.
    const cfg = loadConfig();
    expect(cfg.password).toBe("");
    expect(cfg.server).toBe("localhost");
    // Everything unrelated to the secrets envelope survives the reset.
    expect(cfg.port).toBe(8123);

    // The old (still correctly encrypted, just now orphaned) file was backed up.
    const backups = fs
      .readdirSync(path.dirname(configFile))
      .filter((name) => name.startsWith("config.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(configFile), backups[0]), "utf-8")).toBe(
      before,
    );

    // The new file has a fresh envelope, not the one that was reset away.
    const after = fs.readFileSync(configFile, "utf-8");
    expect(after).not.toBe(before);
    expect(after).toContain("$secrets");
  });

  it("loadConfig throws rather than silently returning defaults when the cipher is locked", async () => {
    await unlockOrSetupConfigCipher(async () => "lock-test-pass");
    setConfig("password", "s3cret");
    lockCipher(); // simulate calling loadConfig() without unlocking first

    expect(() => loadConfig()).toThrow(/locked/i);
  });

  it("migrates a legacy plaintext config in place, preserving values", async () => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        server: "legacy-host",
        port: 7000,
        password: "legacy-plaintext-pw",
        subagentModel: "",
        subsubagentModel: "",
        agentProvider: "ollama",
        subagentProvider: "ollama",
        agentTemp: 0.1,
        subagentTemp: 0.4,
        retries: 3,
        timeout: 600000,
        shellTimeoutMs: 120000,
        maxContextBudget: 0.2,
        workspace: "",
        showThinkOutput: false,
        subagentCap: 3,
        ui: { theme: "default", showSpinner: true, useAlternateBuffer: false },
      }),
    );

    await unlockOrSetupConfigCipher(async () => "migration-pass");

    const cfg = loadConfig();
    expect(cfg.server).toBe("legacy-host");
    expect(cfg.password).toBe("legacy-plaintext-pw");

    const raw = fs.readFileSync(configFile, "utf-8");
    expect(raw).toContain("$secrets");
    expect(raw).not.toContain("legacy-plaintext-pw");

    const backups = fs
      .readdirSync(path.dirname(configFile))
      .filter((name) => name.startsWith("config.json.bak-"));
    expect(backups).toHaveLength(1);
    const backupContent = fs.readFileSync(
      path.join(path.dirname(configFile), backups[0]),
      "utf-8",
    );
    expect(backupContent).toContain("legacy-plaintext-pw");
  });

  it("corrupt JSON on disk: sets up a fresh cipher rather than crashing", async () => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "{ not valid json ][");

    await expect(
      unlockOrSetupConfigCipher(async () => "recovery-pass"),
    ).resolves.toBeUndefined();

    // loadConfig()'s own corrupt-JSON fallback fails soft to defaults
    // in-memory (pre-existing behavior, unrelated to this change) — it does
    // NOT rewrite the corrupt file. What matters here is that the cipher is
    // now unlocked, so an explicit save works and comes out encrypted.
    const cfg = loadConfig();
    expect(cfg.password).toBe("");
    expect(fs.readFileSync(configFile, "utf-8")).toBe("{ not valid json ][");

    saveConfig(cfg);
    const raw = fs.readFileSync(configFile, "utf-8");
    expect(raw).toContain("$secrets");
  });

  it("rotateConfigPassphrase: re-encrypts the server password/host under a new passphrase", async () => {
    await unlockOrSetupConfigCipher(async () => "old-pass");
    setConfig("password", "s3cret");
    setConfig("server", "10.0.0.5");

    rotateConfigPassphrase("old-pass", "new-pass");

    // Still readable in the same session, values unchanged.
    const cfg = loadConfig();
    expect(cfg.password).toBe("s3cret");
    expect(cfg.server).toBe("10.0.0.5");
  });

  it("rotateConfigPassphrase: only the new passphrase unlocks it after a simulated restart", async () => {
    await unlockOrSetupConfigCipher(async () => "old-pass");
    setConfig("password", "s3cret");
    setConfig("server", "10.0.0.5");

    rotateConfigPassphrase("old-pass", "new-pass");
    lockCipher();

    let promptCount = 0;
    await unlockOrSetupConfigCipher(async () => {
      promptCount += 1;
      return "new-pass";
    });
    expect(promptCount).toBe(1);
    const cfg = loadConfig();
    expect(cfg.password).toBe("s3cret");
    expect(cfg.server).toBe("10.0.0.5");
  });

  it("rotateConfigPassphrase: the old passphrase is rejected after a simulated restart", async () => {
    await unlockOrSetupConfigCipher(async () => "old-pass");
    setConfig("password", "s3cret");
    setConfig("server", "10.0.0.5");

    rotateConfigPassphrase("old-pass", "new-pass");
    lockCipher();

    // The old passphrase is wrong for every attempt including the
    // post-reset-menu prompt, so bound the mock with a final "q" (quit) —
    // an unbounded mock returning the same wrong value forever would spin
    // the retry loop, which resets its attempt counter on every "retry"
    // menu choice (see MAX_PASSPHRASE_ATTEMPTS in config.ts).
    const responses = ["old-pass", "old-pass", "old-pass", "q"];
    let promptCount = 0;
    await expect(
      unlockOrSetupConfigCipher(async () => {
        const value = responses[promptCount];
        promptCount += 1;
        return value;
      }),
    ).rejects.toThrow(/aborted/i);
  });

  it("rotateConfigPassphrase: throws ConfigDecryptionError and changes nothing when currentPassphrase is wrong", async () => {
    await unlockOrSetupConfigCipher(async () => "correct-pass");
    setConfig("password", "s3cret");
    setConfig("server", "10.0.0.5");
    const before = fs.readFileSync(configFile, "utf-8");

    expect(() => rotateConfigPassphrase("wrong-pass", "new-pass")).toThrow(
      ConfigDecryptionError,
    );

    expect(fs.readFileSync(configFile, "utf-8")).toBe(before);
    const cfg = loadConfig();
    expect(cfg.password).toBe("s3cret");
  });

  it("rotateConfigPassphrase: throws when there is no config file yet", async () => {
    // No unlockOrSetupConfigCipher call at all — no config file exists yet.
    expect(() => rotateConfigPassphrase("old-pass", "new-pass")).toThrow(
      /nothing to rotate/i,
    );
  });
});
