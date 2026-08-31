/**
 * Integration tests — router command dispatch against a real ConfigManager.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : buildRouter + Router.routeCommand, a real
 *                          ConfigManager (encrypted, disk-backed via a temp
 *                          root), a real ProviderRegistry.
 * Mocks                  : `OllamaClient.deleteModel` is stubbed with
 *                          `vi.spyOn` (no live Ollama needed) — every other
 *                          route under test never reaches the network at all.
 *
 * Why this file exists
 * ---------------------
 * This session found and fixed real bugs where `agentModel`/`subagentModel`
 * (or their temperature/tool-support counterparts) were swapped between the
 * two roles — every unit test for the individual modules involved still
 * passed, because each module was internally consistent; only the wiring
 * between them was wrong. Unit tests for `ConfigManager.setModel` or
 * `createSetConfigHandler` in isolation cannot catch a swap at the route
 * layer (e.g. `configKey === "agentModel"` accidentally calling
 * `config.setModel("subagent", ...)`). This file drives requests through
 * `Router.routeCommand` — the exact entry point the real RSocket layer
 * uses — and asserts the correct field was actually written on disk.
 *
 * Category checklist:
 *   ✅ Happy path          — config.setModel writes the correct role's field
 *   ✅ Contract consistency — config.set validates range per key
 *   ✅ Failure propagation — invalid values and unknown routes reject, not silently no-op
 *   ✅ State integrity      — models.delete reports the correct role flags
 *   ✅ System-level edges   — Router itself rejects a route with no registered handler
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Session,
  RouterBuilderDeps,
} from "../../../packages/server/src/routing/types.js";
import { buildRouter } from "../../../packages/server/src/routing/routerBuilder.js";
import { Router } from "../../../packages/server/src/routing/router.js";
import { ConfigManager } from "../../../packages/server/src/config/index.js";
import { lockCipher } from "@atlasagents/shared";
import { OllamaClient } from "../../../packages/server/src/ollama/client.js";
import { ProviderRegistry } from "../../../packages/server/src/providers/providerRegistry.js";
import { McpToolsCacheStore } from "../../../packages/server/src/orchestration/mcp/mcpToolsCacheStore.js";

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

const makeConfigManager = async (): Promise<{
  config: ConfigManager;
  root: string;
}> => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "atlas-router-command-flow-"),
  );
  tempRoots.push(root);
  const config = new ConfigManager({ rootDir: root });
  await config.unlockOrSetupProvidersCipher(async () => "router-flow-pass");
  return { config, root };
};

/** Builds a real Router. `ollama` is a real client whose network methods are
 * never called except where a test explicitly stubs `deleteModel`.
 *
 * `ollamaBaseUrl` defaults to an obviously-remote host so `models.storage`
 * (and `models.delete`'s `freedBytes` scan) short-circuits to "unavailable"
 * instead of reading this dev machine's real `~/.ollama/models` — keeping
 * these tests hermetic and their outcome independent of what's actually
 * installed locally. */
const makeRouter = (
  config: ConfigManager,
  ollama: OllamaClient = new OllamaClient(),
  ollamaBaseUrl = "http://router-command-flow-test.invalid:11434",
) => {
  const deps: RouterBuilderDeps = {
    ollama,
    providerRegistry: new ProviderRegistry({ config, ollamaClient: ollama }),
    config,
    ollamaBaseUrl,
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
    orchestrator: { runTask: async () => {} },
    brokerByRequester: new Map(),
    mcpToolsCacheStore: new McpToolsCacheStore({
      rootDir: path.join(os.tmpdir(), "atlas-router-command-flow-mcp-cache"),
    }),
    createPerConnection: () => {
      throw new Error("not used by these tests");
    },
    preferenceRulesToMemoryEntries: () => [],
  };
  return buildRouter(deps);
};

describe("config.setModel — role → field correctness (regression guard)", () => {
  it("role 'agent' writes agentModel, and never subagentModel", async () => {
    const { config } = await makeConfigManager();
    const ollama = new OllamaClient();
    vi.spyOn(ollama, "showModel").mockResolvedValue({});
    const router = makeRouter(config, ollama);

    await router.routeCommand(SESSION, "config.setModel", {
      role: "agent",
      provider: "ollama",
      model: "gemma3:27b",
    });

    const all = await config.getAll();
    expect(all.agentModel).toBe("gemma3:27b");
    expect(all.subagentModel).not.toBe("gemma3:27b");
  });

  it("role 'subagent' writes subagentModel, and never agentModel", async () => {
    const { config } = await makeConfigManager();
    // Pre-seed a distinct agentModel first. `mergeConfig` has a documented
    // backfill migration (packages/server/src/config/configManager/parsing.ts)
    // that copies subagentModel into agentModel when agentModel is still
    // empty — a leftover shim for a real prior bug where every model write
    // landed in subagentModel regardless of role. Without this seed, that
    // migration (correctly) makes agentModel mirror subagentModel here,
    // which would make this test's "never agentModel" assertion meaningless.
    await config.setModel("agent", "gemma3:27b");
    const ollama = new OllamaClient();
    vi.spyOn(ollama, "showModel").mockResolvedValue({});
    const router = makeRouter(config, ollama);

    await router.routeCommand(SESSION, "config.setModel", {
      role: "subagent",
      provider: "ollama",
      model: "qwen2.5-coder:7b",
    });

    const all = await config.getAll();
    expect(all.subagentModel).toBe("qwen2.5-coder:7b");
    expect(all.agentModel).toBe("gemma3:27b");
  });

  it("setting one role's model leaves the other role's model untouched", async () => {
    const { config } = await makeConfigManager();
    const ollama = new OllamaClient();
    vi.spyOn(ollama, "showModel").mockResolvedValue({});
    const router = makeRouter(config, ollama);
    await config.setModel("agent", "gemma3:27b");
    await config.setModel("subagent", "qwen2.5-coder:7b");

    await router.routeCommand(SESSION, "config.setModel", {
      role: "agent",
      provider: "ollama",
      model: "llama3.1:70b",
    });

    const all = await config.getAll();
    expect(all.agentModel).toBe("llama3.1:70b");
    // The regression this guards against: a role/field swap would have
    // clobbered the subagent's model when only the agent's was targeted.
    expect(all.subagentModel).toBe("qwen2.5-coder:7b");
  });
});

describe("config.setModel — placementWarning surfaces a measured VRAM spill", () => {
  it("returns a placementWarning when the newly-selected model is already loaded and spilling", async () => {
    const { config } = await makeConfigManager();
    const ollama = new OllamaClient();
    vi.spyOn(ollama, "showModel").mockResolvedValue({});
    vi.spyOn(ollama, "listRunning").mockResolvedValue([
      { name: "qwen3:70b", size: 100, size_vram: 52 },
    ]);
    const router = makeRouter(config, ollama);

    const result = await router.routeCommand(SESSION, "config.setModel", {
      role: "agent",
      provider: "ollama",
      model: "qwen3:70b",
    });

    expect(result).toMatchObject({ ok: true });
    expect((result as { placementWarning?: string }).placementWarning).toContain(
      "qwen3:70b",
    );
  });

  it("omits placementWarning when the selected model isn't loaded yet (no warm-up)", async () => {
    const { config } = await makeConfigManager();
    const ollama = new OllamaClient();
    vi.spyOn(ollama, "showModel").mockResolvedValue({});
    vi.spyOn(ollama, "listRunning").mockResolvedValue([]);
    const router = makeRouter(config, ollama);

    const result = await router.routeCommand(SESSION, "config.setModel", {
      role: "agent",
      provider: "ollama",
      model: "qwen3:70b",
    });

    expect(
      (result as { placementWarning?: string }).placementWarning,
    ).toBeUndefined();
  });

  it("never throws when listRunning() is unreachable — setModel still succeeds", async () => {
    const { config } = await makeConfigManager();
    const ollama = new OllamaClient();
    vi.spyOn(ollama, "showModel").mockResolvedValue({});
    vi.spyOn(ollama, "listRunning").mockRejectedValue(
      new Error("connection refused"),
    );
    const router = makeRouter(config, ollama);

    const result = await router.routeCommand(SESSION, "config.setModel", {
      role: "agent",
      provider: "ollama",
      model: "qwen3:70b",
    });

    expect(result).toMatchObject({ ok: true });
    expect(
      (result as { placementWarning?: string }).placementWarning,
    ).toBeUndefined();
  });
});

describe("config.set — value validation propagates through the route", () => {
  it("accepts an in-range agentTemp", async () => {
    const { config } = await makeConfigManager();
    const router = makeRouter(config);

    await router.routeCommand(SESSION, "config.set", {
      key: "agentTemp",
      value: 0.2,
    });

    expect((await config.getAll()).agentTemp).toBe(0.2);
  });

  it("rejects an out-of-range agentTemp rather than silently clamping it", async () => {
    const { config } = await makeConfigManager();
    const router = makeRouter(config);

    await expect(
      router.routeCommand(SESSION, "config.set", {
        key: "agentTemp",
        value: 1.5,
      }),
    ).rejects.toThrow(/between 0 and 1/i);
    // State integrity: the invalid write must not have partially applied.
    expect((await config.getAll()).agentTemp).not.toBe(1.5);
  });

  it("rejects a negative retries value", async () => {
    const { config } = await makeConfigManager();
    const router = makeRouter(config);

    await expect(
      router.routeCommand(SESSION, "config.set", { key: "retries", value: -1 }),
    ).rejects.toThrow(/non-negative/i);
  });
});

describe("models.delete — reports the correct role flags (no live Ollama)", () => {
  it("flags wasAgentModel when the deleted model matches the agent role", async () => {
    const { config } = await makeConfigManager();
    await config.setModel("agent", "gemma3:27b");
    await config.setModel("subagent", "qwen2.5-coder:7b");
    const ollama = new OllamaClient();
    vi.spyOn(ollama, "deleteModel").mockResolvedValue(undefined);
    const router = makeRouter(config, ollama);

    const result = await router.routeCommand(SESSION, "models.delete", {
      name: "gemma3:27b",
    });

    expect(result).toEqual({
      ok: true,
      wasAgentModel: true,
      wasSubagentModel: false,
    });
  });

  it("flags wasSubagentModel when the deleted model matches the subagent role", async () => {
    const { config } = await makeConfigManager();
    await config.setModel("agent", "gemma3:27b");
    await config.setModel("subagent", "qwen2.5-coder:7b");
    const ollama = new OllamaClient();
    vi.spyOn(ollama, "deleteModel").mockResolvedValue(undefined);
    const router = makeRouter(config, ollama);

    const result = await router.routeCommand(SESSION, "models.delete", {
      name: "qwen2.5-coder:7b",
    });

    expect(result).toEqual({
      ok: true,
      wasAgentModel: false,
      wasSubagentModel: true,
    });
  });

  it("flags neither when the deleted model matches no configured role", async () => {
    const { config } = await makeConfigManager();
    await config.setModel("agent", "gemma3:27b");
    await config.setModel("subagent", "qwen2.5-coder:7b");
    const ollama = new OllamaClient();
    vi.spyOn(ollama, "deleteModel").mockResolvedValue(undefined);
    const router = makeRouter(config, ollama);

    const result = await router.routeCommand(SESSION, "models.delete", {
      name: "unrelated-model:1b",
    });

    expect(result).toEqual({
      ok: true,
      wasAgentModel: false,
      wasSubagentModel: false,
    });
  });
});

describe("router dispatch — unknown/unimplemented routes reject", () => {
  it("rejects a route string that isn't a known RouteId", async () => {
    const { config } = await makeConfigManager();
    const router = makeRouter(config);

    await expect(
      router.routeCommand(SESSION, "totally.not.a.real.route", {}),
    ).rejects.toThrow(/unknown route/i);
  });

  it("Router itself rejects a valid RouteId with no registered handler", async () => {
    // Bypasses buildRouter to exercise Router.routeCommand's own dispatch
    // logic directly against a deliberately incomplete commands map.
    const router = new Router({ commands: {}, streams: {} });

    await expect(
      router.routeCommand(SESSION, "config.get", {}),
    ).rejects.toThrow(/not implemented/i);
  });
});
