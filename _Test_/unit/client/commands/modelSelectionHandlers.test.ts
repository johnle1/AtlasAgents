/**
 * Unit tests — client commands/modelSelectionHandlers.ts
 *
 * Covers the provider-grouped picker flow: continuous flat indexing across
 * groups, mapping a chosen index back to {provider, model}, persisting both
 * fields locally + on the server via config.setModel, rolling back local
 * config when the server rejects the change, and seeding the shared
 * option-bar picker (`prompts.pickOption`) with the current model already
 * highlighted.
 *
 * `config.js` is mocked because loadConfig/updateConfig write to the real
 * `~/.atlasagents/config.json` on disk — a real test run must never touch a
 * developer's actual config file. `renderer.js`'s `buildGroupedModelsLines`
 * is NOT mocked — it's a pure data transform (no I/O), so exercising the
 * real implementation is both safe and a better test of the actual wiring.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleSetModel } from "../../../../packages/client/src/commands/modelSelectionHandlers";
import type { Connection } from "../../../../packages/client/src/connection/index";
import type { PromptPort } from "../../../../packages/client/src/ui/promptPort";
import type { Config } from "../../../../packages/client/src/config/index";

const baseConfig = (): Config =>
  ({
    server: "localhost",
    port: 7000,
    password: "",
    agentModel: "old-agent-model",
    subagentModel: "old-subagent-model",
    agentProvider: "ollama",
    subagentProvider: "ollama",
    agentTemp: 0.1,
    subagentTemp: 0.4,
    retries: 3,
    timeout: 600_000,
    shellTimeoutMs: 120_000,
    maxContextBudget: 0.2,
    workspace: "",
    showThinkOutput: false,
    subagentCap: 3,
    ui: { theme: "default" },
  }) as Config;

let currentConfig: Config;
const loadConfigMock = vi.fn(() => currentConfig);
const updateConfigMock = vi.fn((patch: Partial<Config>) => {
  currentConfig = { ...currentConfig, ...patch };
  return currentConfig;
});

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => loadConfigMock(),
  updateConfig: (patch: Partial<Config>) => updateConfigMock(patch),
}));

beforeEach(() => {
  currentConfig = baseConfig();
  loadConfigMock.mockClear();
  updateConfigMock.mockClear();
});

/** `pickOption` resolves the chosen index directly, or `null` on cancel. */
const fakePrompts = (index: number | null): PromptPort =>
  ({
    pickOption: vi.fn(async () => index),
  }) as unknown as PromptPort;

const GROUPED_MODELS_RESPONSE = {
  groups: [
    { provider: "ollama", models: ["gemma3:27b"] },
    { provider: "lmstudio", models: ["Qwen2.5-7B-Instruct"] },
  ],
};

describe("handleSetModel — selection", () => {
  it("maps the chosen index to the correct (provider, model) across groups", async () => {
    const sendCommand = vi
      .fn()
      .mockResolvedValueOnce(GROUPED_MODELS_RESPONSE) // providers.listModels
      .mockResolvedValueOnce({ ok: true, supportsTools: true }); // config.setModel

    const connectionUpdateConfig = vi.fn();
    const connection = {
      sendCommand,
      updateConfig: connectionUpdateConfig,
    } as unknown as Connection;

    // Index 1 is the lmstudio model (flat indexing after ollama's one model).
    await handleSetModel("agent", connection, fakePrompts(1));

    expect(sendCommand).toHaveBeenNthCalledWith(1, "providers.listModels", {});
    expect(sendCommand).toHaveBeenNthCalledWith(2, "config.setModel", {
      role: "agent",
      provider: "lmstudio",
      model: "Qwen2.5-7B-Instruct",
    });
    expect(updateConfigMock).toHaveBeenCalledWith({
      agentModel: "Qwen2.5-7B-Instruct",
      agentProvider: "lmstudio",
      configChangedAt: expect.any(Number),
    });
    expect(connectionUpdateConfig).toHaveBeenCalledWith(currentConfig);
  });

  it("updates subagent fields (not agent fields) for the subagent role", async () => {
    const sendCommand = vi
      .fn()
      .mockResolvedValueOnce(GROUPED_MODELS_RESPONSE)
      .mockResolvedValueOnce({ ok: true, supportsTools: false });
    const connection = {
      sendCommand,
      updateConfig: vi.fn(),
    } as unknown as Connection;

    await handleSetModel("subagent", connection, fakePrompts(0));

    expect(sendCommand).toHaveBeenNthCalledWith(2, "config.setModel", {
      role: "subagent",
      provider: "ollama",
      model: "gemma3:27b",
    });
    expect(updateConfigMock).toHaveBeenCalledWith({
      subagentModel: "gemma3:27b",
      subagentProvider: "ollama",
      configChangedAt: expect.any(Number),
    });
  });
});

describe("handleSetModel — option bar seeding (current selection)", () => {
  it("opens with initialIndex 0 when the model field is whitespace-only (unset)", async () => {
    currentConfig = {
      ...baseConfig(),
      agentModel: "   ",
      subagentModel: "\t",
    };
    const sendCommand = vi.fn().mockResolvedValueOnce(GROUPED_MODELS_RESPONSE);
    const prompts = fakePrompts(null);
    const connection = {
      sendCommand,
      updateConfig: vi.fn(),
    } as unknown as Connection;

    await handleSetModel("agent", connection, prompts);

    expect(prompts.pickOption).toHaveBeenCalledWith(
      "Pick agent model",
      ["gemma3:27b (ollama)", "Qwen2.5-7B-Instruct (lmstudio)"],
      0,
    );
  });

  it("seeds initialIndex on the currently-configured (trimmed) model", async () => {
    currentConfig = {
      ...baseConfig(),
      agentModel: "  Qwen2.5-7B-Instruct  ",
      agentProvider: "lmstudio",
    };
    const sendCommand = vi.fn().mockResolvedValueOnce(GROUPED_MODELS_RESPONSE);
    const prompts = fakePrompts(null);
    const connection = {
      sendCommand,
      updateConfig: vi.fn(),
    } as unknown as Connection;

    await handleSetModel("agent", connection, prompts);

    // Entry index 1 is {lmstudio, Qwen2.5-7B-Instruct}.
    expect(prompts.pickOption).toHaveBeenCalledWith(
      "Pick agent model",
      expect.any(Array),
      1,
    );
  });
});

describe("handleSetModel — cancel / empty", () => {
  it("makes no config changes when the user cancels (Esc)", async () => {
    const sendCommand = vi.fn().mockResolvedValueOnce(GROUPED_MODELS_RESPONSE);
    const connection = {
      sendCommand,
      updateConfig: vi.fn(),
    } as unknown as Connection;

    await handleSetModel("agent", connection, fakePrompts(null));

    expect(sendCommand).toHaveBeenCalledTimes(1); // only providers.listModels
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it("does nothing when no provider has any models", async () => {
    const sendCommand = vi.fn().mockResolvedValueOnce({
      groups: [{ provider: "ollama", models: [] }],
    });
    const connection = {
      sendCommand,
      updateConfig: vi.fn(),
    } as unknown as Connection;

    await handleSetModel("agent", connection, fakePrompts(0));

    expect(updateConfigMock).not.toHaveBeenCalled();
  });
});

describe("handleSetModel — server rollback", () => {
  it("restores the previous provider and model when config.setModel fails", async () => {
    const sendCommand = vi
      .fn()
      .mockResolvedValueOnce(GROUPED_MODELS_RESPONSE)
      .mockRejectedValueOnce(new Error("server rejected"));
    const connectionUpdateConfig = vi.fn();
    const connection = {
      sendCommand,
      updateConfig: connectionUpdateConfig,
    } as unknown as Connection;

    await handleSetModel("agent", connection, fakePrompts(1));

    // Forward write, then rollback write — both go through updateConfig.
    expect(updateConfigMock).toHaveBeenCalledTimes(2);
    expect(updateConfigMock).toHaveBeenLastCalledWith({
      agentModel: "old-agent-model",
      agentProvider: "ollama",
    });
    // Connection-level config (and therefore the banner) must never see the
    // rejected change.
    expect(connectionUpdateConfig).not.toHaveBeenCalled();
    expect(currentConfig.agentModel).toBe("old-agent-model");
    expect(currentConfig.agentProvider).toBe("ollama");
  });
});
