/**
 * Unit tests — server config/configManager.ts provider extensions
 *
 * Confirms the additive, back-compat contract: a legacy config.json with no
 * provider fields transparently defaults both roles to "ollama", and the new
 * addProvider/removeProvider/setProvider/setRoleModel methods validate and
 * persist correctly through the existing atomic-write + mutex machinery.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConfigError,
  ConfigManager,
} from "../../../../packages/server/src/config/index.js";
import { initializeCipher } from "@atlasagents/shared";

// ConfigManager encrypts the `providers` field at rest; any write requires
// the cipher to be unlocked first (normally done via
// ConfigManager.unlockOrSetupProvidersCipher at server startup). These tests
// exercise provider CRUD logic, not the encryption itself, so unlock once
// with a fixed passphrase and share it across every test in this file.
beforeAll(() => {
  initializeCipher("test-passphrase-for-config-provider-tests");
});

const tempRoots: string[] = [];

const makeManager = async (): Promise<{
  manager: ConfigManager;
  root: string;
}> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-config-"));
  tempRoots.push(root);
  return { manager: new ConfigManager({ rootDir: root }), root };
};

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("ConfigManager provider defaults — back-compat", () => {
  it("defaults both roles to 'ollama' with no config.json on disk", async () => {
    const { manager } = await makeManager();
    expect(await manager.getAgentProvider()).toBe("ollama");
    expect(await manager.getSubagentProvider()).toBe("ollama");
    expect(await manager.getProviders()).toEqual({});
  });

  it("defaults to 'ollama' when an existing config.json predates the provider fields", async () => {
    const { manager, root } = await makeManager();
    const configPath = path.join(root, "user-data", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        subagentModel: "gemma3:27b",
      }),
    );

    expect(await manager.getSubagentModel()).toBe("gemma3:27b");
    expect(await manager.getAgentProvider()).toBe("ollama");
    expect(await manager.getSubagentProvider()).toBe("ollama");
  });
});

describe("ConfigManager.addProvider / getProvider / getProviders", () => {
  it("adds a provider and makes it retrievable", async () => {
    const { manager } = await makeManager();
    await manager.addProvider("lmstudio", {
      baseUrl: "http://localhost:1234/v1",
    });

    expect(await manager.getProvider("lmstudio")).toEqual({
      baseUrl: "http://localhost:1234/v1",
    });
    expect(await manager.getProviders()).toEqual({
      "lmstudio": { baseUrl: "http://localhost:1234/v1" },
    });
  });

  it("stores an apiKey when provided", async () => {
    const { manager } = await makeManager();
    await manager.addProvider("lmstudio", {
      baseUrl: "http://localhost:1234/v1",
      apiKey: "secret",
    });

    expect(await manager.getProvider("lmstudio")).toEqual({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "secret",
    });
  });

  it("rejects an empty name", async () => {
    const { manager } = await makeManager();
    await expect(
      manager.addProvider("", { baseUrl: "http://x/v1" }),
    ).rejects.toThrow(ConfigError);
  });

  it("rejects the reserved 'ollama' name", async () => {
    const { manager } = await makeManager();
    await expect(
      manager.addProvider("ollama", { baseUrl: "http://x/v1" }),
    ).rejects.toThrow(ConfigError);
  });

  it("rejects an empty baseUrl", async () => {
    const { manager } = await makeManager();
    await expect(
      manager.addProvider("lmstudio", { baseUrl: "" }),
    ).rejects.toThrow(ConfigError);
  });

  it("upserts (overwrites) an existing provider entry", async () => {
    const { manager } = await makeManager();
    await manager.addProvider("lmstudio", {
      baseUrl: "http://localhost:1234/v1",
    });
    await manager.addProvider("lmstudio", {
      baseUrl: "http://localhost:9000/v1",
    });

    expect(await manager.getProvider("lmstudio")).toEqual({
      baseUrl: "http://localhost:9000/v1",
    });
  });
});

describe("ConfigManager.removeProvider", () => {
  it("removes a configured, unused provider", async () => {
    const { manager } = await makeManager();
    await manager.addProvider("lmstudio", { baseUrl: "http://x/v1" });
    await manager.removeProvider("lmstudio");

    expect(await manager.getProvider("lmstudio")).toBeUndefined();
  });

  it("rejects removing 'ollama'", async () => {
    const { manager } = await makeManager();
    await expect(manager.removeProvider("ollama")).rejects.toThrow(ConfigError);
  });

  it("rejects removing an unconfigured provider", async () => {
    const { manager } = await makeManager();
    await expect(manager.removeProvider("does-not-exist")).rejects.toThrow(
      ConfigError,
    );
  });

  it("rejects removing a provider currently in use by a role", async () => {
    const { manager } = await makeManager();
    await manager.addProvider("lmstudio", { baseUrl: "http://x/v1" });
    await manager.setProvider("agent", "lmstudio");

    await expect(manager.removeProvider("lmstudio")).rejects.toThrow(
      ConfigError,
    );
  });
});

describe("ConfigManager.setProvider", () => {
  it("switches a role to 'ollama'", async () => {
    const { manager } = await makeManager();
    await manager.addProvider("lmstudio", { baseUrl: "http://x/v1" });
    await manager.setProvider("agent", "lmstudio");
    await manager.setProvider("agent", "ollama");

    expect(await manager.getAgentProvider()).toBe("ollama");
  });

  it("rejects switching to an unconfigured provider", async () => {
    const { manager } = await makeManager();
    await expect(
      manager.setProvider("agent", "does-not-exist"),
    ).rejects.toThrow(ConfigError);
  });

  it("does not affect the other role", async () => {
    const { manager } = await makeManager();
    await manager.addProvider("lmstudio", { baseUrl: "http://x/v1" });
    await manager.setProvider("agent", "lmstudio");

    expect(await manager.getSubagentProvider()).toBe("ollama");
  });
});

describe("ConfigManager.setRoleModel", () => {
  it("sets both provider and model atomically", async () => {
    const { manager } = await makeManager();
    await manager.addProvider("lmstudio", { baseUrl: "http://x/v1" });
    await manager.setRoleModel("agent", "lmstudio", "Qwen2.5-7B-Instruct");

    expect(await manager.getAgentProvider()).toBe("lmstudio");
    expect(await manager.getAgentModel()).toBe("Qwen2.5-7B-Instruct");
  });

  it("triggers onModelChanged with the prior model on each real change", async () => {
    const { manager } = await makeManager();
    const changes: Array<[string, string]> = [];
    manager.setOnModelChanged((oldModel, role) =>
      changes.push([oldModel, role]),
    );

    // First call changes from the empty default — that's a real change too.
    await manager.setRoleModel("agent", "ollama", "gemma3:27b");
    await manager.setRoleModel("agent", "ollama", "gemma3:4b");

    expect(changes).toEqual([
      ["", "agent"],
      ["gemma3:27b", "agent"],
    ]);
  });

  it("does not trigger onModelChanged when the model is unchanged", async () => {
    const { manager } = await makeManager();
    await manager.setRoleModel("agent", "ollama", "gemma3:27b");

    const changes: Array<[string, string]> = [];
    manager.setOnModelChanged((oldModel, role) =>
      changes.push([oldModel, role]),
    );
    await manager.setRoleModel("agent", "ollama", "gemma3:27b");

    expect(changes).toEqual([]);
  });

  it("rejects an empty model name", async () => {
    const { manager } = await makeManager();
    await expect(manager.setRoleModel("agent", "ollama", "")).rejects.toThrow(
      ConfigError,
    );
  });

  it("rejects an unconfigured provider", async () => {
    const { manager } = await makeManager();
    await expect(
      manager.setRoleModel("agent", "does-not-exist", "some-model"),
    ).rejects.toThrow(ConfigError);
  });
});
