/**
 * Unit tests — client commands/modelSelectionHandlers.ts
 *
 * Covers the provider-grouped picker flow: continuous numbering across
 * groups, mapping a chosen number back to {provider, model}, persisting both
 * fields locally + on the server via config.setModel, and rolling back local
 * config when the server rejects the change.
 *
 * `config.js` is mocked because loadConfig/updateConfig write to the real
 * `~/.atlasagents/config.json` on disk — a real test run must never touch a
 * developer's actual config file.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleSetModel } from "../../../../packages/client/src/commands/modelSelectionHandlers";
import type { Connection } from "../../../../packages/client/src/connection/index";
import type { PromptPort } from "../../../../packages/client/src/ui/promptPort";
import type { Config } from "../../../../packages/client/src/config/index";
import type { CurrentModelSelection } from "../../../../packages/client/src/renderer.js";

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
const printGroupedModelsMock = vi.fn(
  (
    groups: { provider: string; models: string[] }[],
    _label: unknown,
    _current?: CurrentModelSelection,
  ) => {
    const entries: { provider: string; model: string }[] = [];
    for (const group of groups) {
      for (const model of group.models) {
        entries.push({ provider: group.provider, model });
      }
    }
    return entries;
  },
);

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => loadConfigMock(),
  updateConfig: (patch: Partial<Config>) => updateConfigMock(patch),
}));

vi.mock("../../../../packages/client/src/renderer.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../packages/client/src/renderer.js")
    >();
  return {
    ...actual,
    printGroupedModels: (
      groups: unknown,
      label: unknown,
      current?: CurrentModelSelection,
    ) => printGroupedModelsMock(groups, label, current),
  };
});

beforeEach(() => {
  currentConfig = baseConfig();
  loadConfigMock.mockClear();
  updateConfigMock.mockClear();
  printGroupedModelsMock.mockClear();
});

const fakePrompts = (choice: number): PromptPort =>
  ({
    choose: vi.fn(async () => choice),
  }) as unknown as PromptPort;

const GROUPED_MODELS_RESPONSE = {
  groups: [
    { provider: "ollama", models: ["gemma3:27b"] },
    { provider: "lmstudio", models: ["Qwen2.5-7B-Instruct"] },
  ],
};

describe("handleSetModel — selection", () => {
  it("maps the chosen number to the correct (provider, model) across groups", async () => {
    const sendCommand = vi
      .fn()
      .mockResolvedValueOnce(GROUPED_MODELS_RESPONSE) // providers.listModels
      .mockResolvedValueOnce({ ok: true, supportsTools: true }); // config.setModel

    const connectionUpdateConfig = vi.fn();
    const connection = {
      sendCommand,
      updateConfig: connectionUpdateConfig,
    } as unknown as Connection;

    // Entry #2 is the lmstudio model (continuous numbering after ollama's one model).
    await handleSetModel("agent", connection, fakePrompts(2));

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

    await handleSetModel("subagent", connection, fakePrompts(1));

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

describe("handleSetModel — current selection markers", () => {
  it("treats whitespace-only model fields as unset (no picker markers)", async () => {
    currentConfig = {
      ...baseConfig(),
      agentModel: "   ",
      subagentModel: "\t",
    };
    const sendCommand = vi.fn().mockResolvedValueOnce(GROUPED_MODELS_RESPONSE);
    const connection = {
      sendCommand,
      updateConfig: vi.fn(),
    } as unknown as Connection;

    await handleSetModel("agent", connection, fakePrompts(0));

    expect(printGroupedModelsMock).toHaveBeenCalledWith(
      GROUPED_MODELS_RESPONSE.groups,
      "agent",
      {},
    );
  });

  it("trims padded model names before passing them as current markers", async () => {
    currentConfig = {
      ...baseConfig(),
      agentModel: "  gemma3:27b  ",
      subagentModel: " Qwen2.5-7B-Instruct ",
      agentProvider: "ollama",
      subagentProvider: "lmstudio",
    };
    const sendCommand = vi.fn().mockResolvedValueOnce(GROUPED_MODELS_RESPONSE);
    const connection = {
      sendCommand,
      updateConfig: vi.fn(),
    } as unknown as Connection;

    await handleSetModel("agent", connection, fakePrompts(0));

    expect(printGroupedModelsMock).toHaveBeenCalledWith(
      GROUPED_MODELS_RESPONSE.groups,
      "agent",
      {
        agent: { provider: "ollama", model: "gemma3:27b" },
        subagent: { provider: "lmstudio", model: "Qwen2.5-7B-Instruct" },
      },
    );
  });
});

describe("handleSetModel — cancel / empty", () => {
  it("makes no config changes when the user cancels (out-of-range choice)", async () => {
    const sendCommand = vi.fn().mockResolvedValueOnce(GROUPED_MODELS_RESPONSE);
    const connection = {
      sendCommand,
      updateConfig: vi.fn(),
    } as unknown as Connection;

    await handleSetModel("agent", connection, fakePrompts(0));

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

    await handleSetModel("agent", connection, fakePrompts(1));

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

    await handleSetModel("agent", connection, fakePrompts(2));

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
