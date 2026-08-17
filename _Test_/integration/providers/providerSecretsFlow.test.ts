/**
 * Integration tests — provider API keys stay encrypted and never leak through
 * the command-routing layer.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : buildRouter + Router.routeCommand, a real
 *                          ConfigManager (encrypted, disk-backed via a temp
 *                          root), real OllamaClient/ProviderRegistry
 *                          instances (constructed but never called over the
 *                          network by the routes under test).
 * Mocks                  : the non-config RouterBuilderDeps fields (skills,
 *                          prefs, session, orchestrator, etc.) are trivial
 *                          stubs — this file's job is the config/provider
 *                          routes, not task orchestration.
 *
 * What this test catches that unit tests miss
 * --------------------------------------------
 * `_Test_/unit/configManagerProvidersCipher.test.ts` already proves the
 * cipher itself is correct (encrypt/decrypt/migrate/lock) by calling
 * `ConfigManager` methods directly. `_Test_/unit/routerSanitize.test.ts`
 * proves `stripProviderSecrets` is correct as a pure function. Neither shows
 * that `buildRouter` actually wires them together: a handler could call the
 * wrong config method, forget to call `stripProviderSecrets`, or a future
 * refactor could add a new field to `ServerConfig` that leaks straight
 * through `config.get` without anyone noticing (no unit test would fail).
 * This file drives requests through the exact same `Router.routeCommand`
 * entry point the real RSocket layer uses.
 *
 * Category checklist:
 *   ✅ Happy path          — add → list → response has hasApiKey, no key text
 *   ✅ Contract consistency — config.get scrubs providers the same way providers.list does
 *   ✅ System-level edges   — the round trip survives a simulated process restart
 *   ✅ Failure propagation  — remove-in-use and a locked cipher reject through
 *                             routeCommand rather than resolving with empty/ok data
 *   ✅ State integrity      — a rejected remove leaves the provider untouched
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Session } from "../../../packages/server/src/routing/types.js";
import type { RouterBuilderDeps } from "../../../packages/server/src/routing/types.js";
import { buildRouter } from "../../../packages/server/src/routing/routerBuilder.js";
import { ConfigManager } from "../../../packages/server/src/config/index.js";
import { lockCipher } from "@atlasagents/shared";
import { OllamaClient } from "../../../packages/server/src/ollama/client.js";
import { ProviderRegistry } from "../../../packages/server/src/providers/providerRegistry.js";

const tempRoots: string[] = [];

afterEach(async () => {
  lockCipher();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const SESSION: Session = { userId: "user_1", requesterId: "req_1" };

/** Builds a real, encryption-backed ConfigManager over a fresh temp directory. */
const makeConfigManager = async (): Promise<{
  config: ConfigManager;
  root: string;
}> => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "atlas-provider-secrets-flow-"),
  );
  tempRoots.push(root);
  return { config: new ConfigManager({ rootDir: root }), root };
};

/**
 * Wires a real Router over the given config manager. The non-config
 * dependencies are trivial stubs — none of the routes under test in this
 * file (`providers.*`, `config.get`) touch them.
 */
const makeRouter = (config: ConfigManager) => {
  const deps: RouterBuilderDeps = {
    ollama: new OllamaClient(),
    providerRegistry: new ProviderRegistry({
      config,
      ollamaClient: new OllamaClient(),
    }),
    config,
    skills: { saveAll: async () => 0 },
    prefs: {
      getAll: async () => [],
      deleteByTopic: async () => 0,
      clear: async () => {},
    },
    session: {
      exists: async () => false,
      clear: async () => "",
      saveSnapshot: async () => {},
    },
    orchestrator: {
      runTask: async () => {},
    },
    brokerByRequester: new Map(),
    createPerConnection: () => {
      throw new Error("not used by these tests");
    },
    preferenceRulesToMemoryEntries: () => [],
  };
  return buildRouter(deps);
};

describe("provider secrets — routes never leak key material", () => {
  it("providers.list reports hasApiKey without ever including the key text", async () => {
    const { config } = await makeConfigManager();
    await config.unlockOrSetupProvidersCipher(async () => "flow-pass");
    await config.addProvider("openai", {
      baseUrl: "https://api.openai.com",
      apiKey: "sk-secret-flow-key",
    });
    const router = makeRouter(config);

    const result = await router.routeCommand(SESSION, "providers.list", {});

    expect(JSON.stringify(result)).not.toContain("sk-secret-flow-key");
    expect(result).toMatchObject({
      providers: {
        openai: { baseUrl: "https://api.openai.com", hasApiKey: true },
      },
    });
  });

  it("config.get scrubs provider secrets the same way providers.list does", async () => {
    const { config } = await makeConfigManager();
    await config.unlockOrSetupProvidersCipher(async () => "flow-pass");
    await config.addProvider("openai", {
      baseUrl: "https://api.openai.com",
      apiKey: "sk-secret-via-config-get",
    });
    const router = makeRouter(config);

    const result = await router.routeCommand(SESSION, "config.get", {});

    expect(JSON.stringify(result)).not.toContain("sk-secret-via-config-get");
    expect(
      (result as { providers: Record<string, { hasApiKey: boolean }> })
        .providers.openai.hasApiKey,
    ).toBe(true);
  });

  it("the encrypted key survives a simulated process restart through the route layer", async () => {
    const { config, root } = await makeConfigManager();
    await config.unlockOrSetupProvidersCipher(async () => "restart-flow-pass");
    await config.addProvider("vllm", {
      baseUrl: "http://10.0.0.9:8000",
      apiKey: "sk-restart-key",
    });
    lockCipher(); // simulate the server process restarting

    const config2 = new ConfigManager({ rootDir: root });
    await config2.unlockOrSetupProvidersCipher(async () => "restart-flow-pass");
    const router2 = makeRouter(config2);

    const result = await router2.routeCommand(SESSION, "providers.list", {});

    expect(result).toMatchObject({
      providers: { vllm: { baseUrl: "http://10.0.0.9:8000", hasApiKey: true } },
    });
    // And the plaintext key is genuinely still there for actual use, just not
    // in the client-facing route response above.
    expect(await config2.getProvider("vllm")).toEqual({
      baseUrl: "http://10.0.0.9:8000",
      apiKey: "sk-restart-key",
    });
  });
});

describe("provider secrets — route-layer error propagation", () => {
  it("providers.remove rejects through routeCommand when the provider is in use", async () => {
    const { config } = await makeConfigManager();
    await config.unlockOrSetupProvidersCipher(async () => "flow-pass");
    await config.addProvider("openai", { baseUrl: "https://api.openai.com" });
    await config.setProvider("agent", "openai");
    const router = makeRouter(config);

    await expect(
      router.routeCommand(SESSION, "providers.remove", { name: "openai" }),
    ).rejects.toThrow(/in use/i);

    // State integrity: the rejected remove must not have partially removed it.
    expect(await config.getProvider("openai")).toEqual({
      baseUrl: "https://api.openai.com",
    });
  });

  it("providers.list rejects through routeCommand rather than resolving with empty data when the cipher is locked", async () => {
    const { config, root } = await makeConfigManager();
    await config.unlockOrSetupProvidersCipher(async () => "flow-pass");
    await config.addProvider("openai", {
      baseUrl: "https://api.openai.com",
      apiKey: "sk-should-not-appear-empty",
    });
    lockCipher(); // simulate a restart where startup forgot to unlock

    const config2 = new ConfigManager({ rootDir: root }); // never unlocked
    const router2 = makeRouter(config2);

    // The dangerous failure mode here isn't a thrown error — it's the route
    // silently resolving with `{ providers: {} }`, which looks indistinguishable
    // from "no providers configured" to the client and would look like data loss.
    await expect(
      router2.routeCommand(SESSION, "providers.list", {}),
    ).rejects.toThrow(/locked/i);
  });
});
