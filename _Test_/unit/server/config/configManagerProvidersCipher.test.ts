/**
 * Unit tests — server config/configManager.ts provider-secrets encryption:
 * unlockOrSetupProvidersCipher (first run / restart-unlock / wrong-passphrase
 * retry / legacy migration) and the getProviders/addProvider encryption
 * round trip.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigManager } from "../../../../packages/server/src/config/index.js";
import { ConfigDecryptionError, lockCipher } from "@loopycode/shared";
import * as sharedCipher from "@loopycode/shared";

const tempRoots: string[] = [];

const makeManager = async (): Promise<{
  manager: ConfigManager;
  root: string;
}> => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "loopy-providers-cipher-"),
  );
  tempRoots.push(root);
  return { manager: new ConfigManager({ rootDir: root }), root };
};

afterEach(async () => {
  lockCipher();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("ConfigManager.unlockOrSetupProvidersCipher — first run", () => {
  it("prompts once and initializes the cipher when no config file exists", async () => {
    const { manager } = await makeManager();
    const labels: string[] = [];
    await manager.unlockOrSetupProvidersCipher(async (label) => {
      labels.push(label);
      return "first-run-pass";
    });
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/passphrase/i);
  });

  it("encrypts providers on the first addProvider call", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "first-run-pass");
    await manager.addProvider("openai", {
      baseUrl: "https://api.openai.com",
      apiKey: "sk-secret",
    });

    const raw = await fs.readFile(
      path.join(root, "user-data", "config.json"),
      "utf-8",
    );
    expect(raw).toContain("$providersSecrets");
    expect(raw).not.toContain("sk-secret");

    expect(await manager.getProviders()).toEqual({
      openai: { baseUrl: "https://api.openai.com", apiKey: "sk-secret" },
    });
  });
});

describe("ConfigManager.unlockCipher (via unlockOrSetupProvidersCipher)", () => {
  it("calls shared unlockCipher with the user passphrase and envelope", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "spy-pass");
    await manager.addProvider("openai", { baseUrl: "https://api.openai.com" });
    lockCipher();

    const unlockSpy = vi.spyOn(sharedCipher, "unlockCipher");
    const manager2 = new ConfigManager({ rootDir: root });
    await manager2.unlockOrSetupProvidersCipher(async () => "spy-pass");

    expect(unlockSpy).toHaveBeenCalled();
    const [passphrase, envelope] = unlockSpy.mock.calls[0] ?? [];
    expect(passphrase).toBe("spy-pass");
    expect(envelope).toBeDefined();
    unlockSpy.mockRestore();
  });
});

describe("ConfigManager.unlockOrSetupProvidersCipher — restart", () => {
  it("unlocks an existing encrypted file with the correct passphrase on the first try", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "restart-pass");
    await manager.addProvider("vllm", { baseUrl: "http://10.0.0.9:8000" });
    lockCipher(); // simulate process restart

    const manager2 = new ConfigManager({ rootDir: root });
    let promptCount = 0;
    await manager2.unlockOrSetupProvidersCipher(async () => {
      promptCount += 1;
      return "restart-pass";
    });
    expect(promptCount).toBe(1);
    expect(await manager2.getProviders()).toEqual({
      vllm: { baseUrl: "http://10.0.0.9:8000" },
    });
  });

  it("retries after a wrong passphrase, then succeeds", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "correct-pass");
    await manager.addProvider("vllm", { baseUrl: "http://10.0.0.9:8000" });
    lockCipher();

    const manager2 = new ConfigManager({ rootDir: root });
    const attempts = ["wrong-1", "wrong-2", "correct-pass"];
    let promptCount = 0;
    await manager2.unlockOrSetupProvidersCipher(async () => {
      const value = attempts[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(3);
    expect(await manager2.getProviders()).toEqual({
      vllm: { baseUrl: "http://10.0.0.9:8000" },
    });
  });

  it("forgot passphrase: 'try again' resets the attempt counter and can still succeed", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "correct-pass");
    await manager.addProvider("vllm", { baseUrl: "http://10.0.0.9:8000" });
    lockCipher();

    const manager2 = new ConfigManager({ rootDir: root });
    const responses = ["wrong-1", "wrong-2", "wrong-3", "t", "correct-pass"];
    let promptCount = 0;
    await manager2.unlockOrSetupProvidersCipher(async () => {
      const value = responses[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(5);
    expect(await manager2.getProviders()).toEqual({
      vllm: { baseUrl: "http://10.0.0.9:8000" },
    });
  });

  it("forgot passphrase: 'quit' aborts and leaves the file untouched", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "correct-pass");
    await manager.addProvider("vllm", { baseUrl: "http://10.0.0.9:8000" });
    lockCipher();

    const configPath = path.join(root, "user-data", "config.json");
    const before = await fs.readFile(configPath, "utf-8");

    const manager2 = new ConfigManager({ rootDir: root });
    const responses = ["wrong-1", "wrong-2", "wrong-3", "q"];
    let promptCount = 0;
    await expect(
      manager2.unlockOrSetupProvidersCipher(async () => {
        const value = responses[promptCount];
        promptCount += 1;
        return value;
      }),
    ).rejects.toThrow(/aborted/i);
    expect(promptCount).toBe(4);
    expect(await fs.readFile(configPath, "utf-8")).toBe(before);
  });

  it("forgot passphrase: 'reset' + cancelled confirmation falls back to retry, no file change", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "correct-pass");
    await manager.addProvider("vllm", { baseUrl: "http://10.0.0.9:8000" });
    lockCipher();

    const configPath = path.join(root, "user-data", "config.json");
    const before = await fs.readFile(configPath, "utf-8");

    const manager2 = new ConfigManager({ rootDir: root });
    const responses = [
      "wrong-1",
      "wrong-2",
      "wrong-3",
      "r",
      "not-yes",
      "correct-pass",
    ];
    let promptCount = 0;
    await manager2.unlockOrSetupProvidersCipher(async () => {
      const value = responses[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(6);
    expect(await manager2.getProviders()).toEqual({
      vllm: { baseUrl: "http://10.0.0.9:8000" },
    });
    expect(await fs.readFile(configPath, "utf-8")).toBe(before);
  });

  it("forgot passphrase: 'reset' + confirmed wipes provider secrets but preserves everything else", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "correct-pass");
    await manager.addProvider("vllm", {
      baseUrl: "http://10.0.0.9:8000",
      apiKey: "sk-old",
    });
    await manager.setModel("agent", "gemma3:27b");
    lockCipher();

    const configPath = path.join(root, "user-data", "config.json");
    const before = await fs.readFile(configPath, "utf-8");

    const manager2 = new ConfigManager({ rootDir: root });
    const responses = [
      "wrong-1",
      "wrong-2",
      "wrong-3",
      "r",
      "yes",
      "brand-new-pass",
    ];
    let promptCount = 0;
    await manager2.unlockOrSetupProvidersCipher(async () => {
      const value = responses[promptCount];
      promptCount += 1;
      return value;
    });
    expect(promptCount).toBe(6);

    // Cipher is unlocked with the new passphrase — no further prompt needed.
    expect(await manager2.getProviders()).toEqual({});
    // Everything unrelated to the secrets envelope survives the reset.
    expect(await manager2.getAgentModel()).toBe("gemma3:27b");

    // The old (still correctly encrypted, just now orphaned) file was backed up.
    const files = await fs.readdir(path.dirname(configPath));
    const backups = files.filter((name) => name.startsWith("config.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(
      await fs.readFile(
        path.join(path.dirname(configPath), backups[0]),
        "utf-8",
      ),
    ).toBe(before);

    // The new file has a fresh envelope, not the one that was reset away.
    const after = await fs.readFile(configPath, "utf-8");
    expect(after).not.toBe(before);
    expect(after).toContain("$providersSecrets");
  });
});

describe("ConfigManager.unlockOrSetupProvidersCipher — locked cipher propagates errors", () => {
  it("throws rather than silently returning empty providers when locked", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "lock-test-pass");
    await manager.addProvider("vllm", { baseUrl: "http://10.0.0.9:8000" });
    lockCipher();

    const manager2 = new ConfigManager({ rootDir: root });
    await expect(manager2.getProviders()).rejects.toThrow(/locked/i);
  });

  it("annotates the locked-cipher error with provider-secrets context, even from an unrelated getter", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "lock-test-pass");
    await manager.addProvider("vllm", { baseUrl: "http://10.0.0.9:8000" });
    await manager.setModel("agent", "gemma3:27b");
    lockCipher();

    // getAgentModel() has nothing to do with providers, but _loadRaw() must
    // decrypt $providersSecrets to merge the full config either way — the
    // error it throws should say so, not just "cipher is locked".
    const manager2 = new ConfigManager({ rootDir: root });
    await expect(manager2.getAgentModel()).rejects.toThrow(
      /provider secrets decryption failed while loading config/i,
    );
  });
});

describe("ConfigManager.rotateProvidersPassphrase", () => {
  it("re-encrypts existing provider secrets under a new passphrase, preserving values", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "old-pass");
    await manager.addProvider("openai", {
      baseUrl: "https://api.openai.com",
      apiKey: "sk-before-rotation",
    });

    await manager.rotateProvidersPassphrase("old-pass", "new-pass");

    expect(await manager.getProviders()).toEqual({
      openai: {
        baseUrl: "https://api.openai.com",
        apiKey: "sk-before-rotation",
      },
    });

    // Simulate a restart: only the new passphrase should unlock it now. The
    // old one is wrong for every attempt including the post-reset-menu
    // prompt, so bound the mock with a final "q" (quit) — an unbounded mock
    // returning the same wrong value forever would spin the retry loop,
    // which resets its attempt counter on every "retry" menu choice.
    lockCipher();
    const manager2 = new ConfigManager({ rootDir: root });
    const responses = ["old-pass", "old-pass", "old-pass", "q"];
    let promptCount = 0;
    await expect(
      manager2.unlockOrSetupProvidersCipher(async () => {
        const value = responses[promptCount];
        promptCount += 1;
        return value;
      }),
    ).rejects.toThrow(/aborted/i); // exhausts retries and quits — never silently unlocks
  });

  it("the new passphrase unlocks it correctly after a simulated restart", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "old-pass");
    await manager.addProvider("vllm", {
      baseUrl: "http://10.0.0.9:8000",
      apiKey: "sk-vllm",
    });

    await manager.rotateProvidersPassphrase("old-pass", "new-pass");
    lockCipher();

    const manager2 = new ConfigManager({ rootDir: root });
    let promptCount = 0;
    await manager2.unlockOrSetupProvidersCipher(async () => {
      promptCount += 1;
      return "new-pass";
    });
    expect(promptCount).toBe(1);
    expect(await manager2.getProviders()).toEqual({
      vllm: { baseUrl: "http://10.0.0.9:8000", apiKey: "sk-vllm" },
    });
  });

  it("preserves every other config field across rotation", async () => {
    const { manager } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "old-pass");
    await manager.addProvider("openai", { baseUrl: "https://api.openai.com" });
    await manager.setModel("agent", "gemma3:27b");
    await manager.set("agentTemp", 0.2);

    await manager.rotateProvidersPassphrase("old-pass", "new-pass");

    expect(await manager.getAgentModel()).toBe("gemma3:27b");
    expect(await manager.getAgentTemperature()).toBe(0.2);
  });

  it("throws ConfigDecryptionError and changes nothing when currentPassphrase is wrong", async () => {
    const { manager, root } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "correct-pass");
    await manager.addProvider("openai", {
      baseUrl: "https://api.openai.com",
      apiKey: "sk-unchanged",
    });
    const configPath = path.join(root, "user-data", "config.json");
    const before = await fs.readFile(configPath, "utf-8");

    await expect(
      manager.rotateProvidersPassphrase("wrong-pass", "new-pass"),
    ).rejects.toThrow(ConfigDecryptionError);

    // Nothing on disk changed, and the original passphrase still works.
    expect(await fs.readFile(configPath, "utf-8")).toBe(before);
    expect(await manager.getProviders()).toEqual({
      openai: { baseUrl: "https://api.openai.com", apiKey: "sk-unchanged" },
    });
  });

  it("throws when there is no config file yet", async () => {
    const { manager } = await makeManager();
    await expect(
      manager.rotateProvidersPassphrase("old-pass", "new-pass"),
    ).rejects.toThrow(/nothing to rotate/i);
  });

  it("throws when no provider secrets have ever been encrypted", async () => {
    const { manager } = await makeManager();
    await manager.unlockOrSetupProvidersCipher(async () => "some-pass");
    // Unlocked, but never called addProvider — no $providersSecrets exists yet.
    await expect(
      manager.rotateProvidersPassphrase("some-pass", "new-pass"),
    ).rejects.toThrow(/nothing to rotate/i);
  });
});
