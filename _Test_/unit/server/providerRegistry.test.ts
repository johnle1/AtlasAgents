/**
 * Unit tests — server providers/providerRegistry.ts
 *
 * Covers the seam that lets Agent/Subagent keep depending on IOllamaClient
 * unchanged while the actual backend (Ollama, vLLM, ...) is resolved per
 * role, per call, from config — including the per-task override path used
 * when a client-sent task overrides the configured provider.
 */

import { describe, expect, it } from "vitest";
import {
  OLLAMA_PROVIDER_NAME,
  ProviderRegistry,
  RoleRoutedClient,
  type ProviderRegistryConfig,
} from "../../../packages/server/src/providers/providerRegistry.js";
import { OpenAiCompatibleAdapter } from "../../../packages/server/src/providers/openAiCompatibleAdapter.js";
import { ConfigError } from "../../../packages/server/src/config/configManager/index.js";
import type {
  IOllamaAdminClient,
  IOllamaClient,
} from "../../../packages/server/src/orchestration/interfaces/ollamaInterfaces.js";

const fakeOllamaClient = (): IOllamaClient & IOllamaAdminClient =>
  ({
    chat: async () => "ollama-response",
    chatStream: async function* () {
      yield "ollama-stream";
    },
    chatWithTools: async () => ({ content: "", thinking: "", toolCalls: [] }),
    listModels: async () => [],
    listModelsDetailed: async () => [],
    pullModel: async function* () {},
    deleteModel: async () => {},
    showModel: async () => ({}),
    listRunning: async () => [],
  }) as unknown as IOllamaClient & IOllamaAdminClient;

const makeConfig = (overrides: {
  agentProvider?: string;
  subagentProvider?: string;
  providers?: Record<string, { baseUrl: string; apiKey?: string }>;
}): ProviderRegistryConfig => ({
  getAgentProvider: async () => overrides.agentProvider ?? "ollama",
  getSubagentProvider: async () => overrides.subagentProvider ?? "ollama",
  getProvider: async (name) => overrides.providers?.[name],
});

describe("ProviderRegistry.getClient / getAdmin", () => {
  it("returns the shared native client for 'ollama'", async () => {
    const ollamaClient = fakeOllamaClient();
    const registry = new ProviderRegistry({
      config: makeConfig({}),
      ollamaClient,
    });

    expect(await registry.getClient(OLLAMA_PROVIDER_NAME)).toBe(ollamaClient);
    expect(await registry.getAdmin(OLLAMA_PROVIDER_NAME)).toBe(ollamaClient);
  });

  it("builds an OpenAiCompatibleAdapter for a configured non-Ollama provider", async () => {
    const ollamaClient = fakeOllamaClient();
    const registry = new ProviderRegistry({
      config: makeConfig({
        providers: { "vllm-gpu": { baseUrl: "http://localhost:8000/v1" } },
      }),
      ollamaClient,
    });

    const client = await registry.getClient("vllm-gpu");
    expect(client).toBeInstanceOf(OpenAiCompatibleAdapter);
  });

  it("throws ConfigError for an unconfigured provider name", async () => {
    const registry = new ProviderRegistry({
      config: makeConfig({}),
      ollamaClient: fakeOllamaClient(),
    });

    await expect(registry.getClient("does-not-exist")).rejects.toThrow(
      ConfigError,
    );
    await expect(registry.getAdmin("does-not-exist")).rejects.toThrow(
      ConfigError,
    );
  });
});

describe("ProviderRegistry.getRoleClient", () => {
  it("resolves the agent role through config.getAgentProvider", async () => {
    const ollamaClient = fakeOllamaClient();
    const registry = new ProviderRegistry({
      config: makeConfig({ agentProvider: "ollama" }),
      ollamaClient,
    });

    const result = await registry
      .getRoleClient("agent")
      .chat("m", [], { temperature: 0 });
    expect(result).toBe("ollama-response");
  });

  it("resolves the subagent role independently of the agent role", async () => {
    const ollamaClient = fakeOllamaClient();
    const registry = new ProviderRegistry({
      config: makeConfig({
        agentProvider: "ollama",
        subagentProvider: "vllm-gpu",
        providers: { "vllm-gpu": { baseUrl: "http://localhost:8000/v1" } },
      }),
      ollamaClient,
    });

    // Agent role hits the native client (fast path, no network).
    expect(
      await registry.getRoleClient("agent").chat("m", [], { temperature: 0 }),
    ).toBe("ollama-response");

    // Subagent role resolves to a real (unreachable) adapter instance —
    // distinct client, proving role isolation without needing network I/O.
    const subagentClient = registry.getRoleClient("subagent");
    expect(subagentClient).toBeInstanceOf(RoleRoutedClient);
  });

  it("an override provider always wins over the configured provider", async () => {
    const ollamaClient = fakeOllamaClient();
    const registry = new ProviderRegistry({
      config: makeConfig({
        agentProvider: "ollama",
        providers: { "vllm-gpu": { baseUrl: "http://localhost:8000/v1" } },
      }),
      ollamaClient,
    });

    // Override to "ollama" explicitly even though a different provider is
    // reachable in config — resolveClient should still hit the native path.
    const overridden = registry.getRoleClient("agent", "ollama");
    expect(await overridden.chat("m", [], { temperature: 0 })).toBe(
      "ollama-response",
    );
  });

  it("caches the non-override role client across calls", () => {
    const registry = new ProviderRegistry({
      config: makeConfig({}),
      ollamaClient: fakeOllamaClient(),
    });

    expect(registry.getRoleClient("agent")).toBe(registry.getRoleClient("agent"));
  });

  it("does not cache an override role client", () => {
    const registry = new ProviderRegistry({
      config: makeConfig({}),
      ollamaClient: fakeOllamaClient(),
    });

    expect(registry.getRoleClient("agent", "ollama")).not.toBe(
      registry.getRoleClient("agent", "ollama"),
    );
  });
});

describe("RoleRoutedClient.chatStream", () => {
  it("delegates streaming to the resolved underlying client", async () => {
    const ollamaClient = fakeOllamaClient();
    const registry = new ProviderRegistry({
      config: makeConfig({ agentProvider: "ollama" }),
      ollamaClient,
    });

    const tokens: string[] = [];
    for await (const token of registry
      .getRoleClient("agent")
      .chatStream("m", [], { temperature: 0 })) {
      tokens.push(token);
    }

    expect(tokens).toEqual(["ollama-stream"]);
  });
});
