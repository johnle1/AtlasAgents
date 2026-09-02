import { describe, expect, it } from "vitest";
import {
  modelSupportsNativeTools,
  modelSupportsThinking,
} from "../../../../packages/server/src/ollama/modelCapabilities.js";
import { syncAdvisorToolSupport, syncAgentToolSupport } from "../../../../packages/server/src/ollama/syncAgentToolSupport.js";
import { syncAgentThinkingSupport } from "../../../../packages/server/src/ollama/syncAgentThinkingSupport.js";
import type { ModelInfo } from "../../../../packages/server/src/ollama/types.js";

describe("modelSupportsNativeTools", () => {
  it("returns true when capabilities includes tools", () => {
    const info: ModelInfo = { capabilities: ["completion", "tools"] };
    expect(modelSupportsNativeTools(info)).toBe(true);
  });

  it("returns false when capabilities omits tools", () => {
    const info: ModelInfo = { capabilities: ["completion"] };
    expect(modelSupportsNativeTools(info)).toBe(false);
  });

  it("returns false when capabilities is missing", () => {
    expect(modelSupportsNativeTools({})).toBe(false);
  });

  it("returns false when capabilities is not an array", () => {
    const info = { capabilities: "tools" } as unknown as ModelInfo;
    expect(modelSupportsNativeTools(info)).toBe(false);
  });
});

describe("modelSupportsThinking", () => {
  it("returns true when capabilities includes thinking", () => {
    const info: ModelInfo = { capabilities: ["completion", "thinking"] };
    expect(modelSupportsThinking(info)).toBe(true);
  });

  it("returns false when capabilities omits thinking (regression — qwen:4b HTTP 400)", () => {
    const info: ModelInfo = { capabilities: ["completion", "tools"] };
    expect(modelSupportsThinking(info)).toBe(false);
  });

  it("returns false when capabilities is missing", () => {
    expect(modelSupportsThinking({})).toBe(false);
  });

  it("returns false when capabilities is not an array", () => {
    const info = { capabilities: "thinking" } as unknown as ModelInfo;
    expect(modelSupportsThinking(info)).toBe(false);
  });
});

describe("syncAgentThinkingSupport", () => {
  it("persists true when showModel reports the thinking capability", async () => {
    const sets: Array<[string, unknown]> = [];
    const supports = await syncAgentThinkingSupport(
      {
        showModel: async () => ({ capabilities: ["thinking"] }),
      },
      {
        set: async (key, value) => {
          sets.push([key, value]);
        },
        getAgentModelSupportsThinking: async () => false,
      },
      "deepseek-r1:7b",
    );

    expect(supports).toBe(true);
    expect(sets).toEqual([["agentModelSupportsThinking", true]]);
  });

  it("persists false for a model without the thinking capability (regression — qwen:4b HTTP 400)", async () => {
    const sets: Array<[string, unknown]> = [];
    const supports = await syncAgentThinkingSupport(
      {
        showModel: async () => ({ capabilities: ["completion", "tools"] }),
      },
      {
        set: async (key, value) => {
          sets.push([key, value]);
        },
        getAgentModelSupportsThinking: async () => true,
      },
      "qwen:4b",
    );

    expect(supports).toBe(false);
    expect(sets).toEqual([["agentModelSupportsThinking", false]]);
  });

  it("returns the cached value without probing for an empty model name (boundary)", async () => {
    const showModel = async () => {
      throw new Error("should not be called");
    };
    const supports = await syncAgentThinkingSupport(
      { showModel },
      {
        set: async () => {},
        getAgentModelSupportsThinking: async () => true,
      },
      "   ",
    );

    expect(supports).toBe(true);
  });

  it("keeps the existing flag when showModel fails (error)", async () => {
    const sets: Array<[string, unknown]> = [];
    const supports = await syncAgentThinkingSupport(
      {
        showModel: async () => {
          throw new Error("Ollama unreachable");
        },
      },
      {
        set: async (key, value) => {
          sets.push([key, value]);
        },
        getAgentModelSupportsThinking: async () => true,
      },
      "deepseek-r1:7b",
    );

    expect(supports).toBe(true);
    expect(sets).toHaveLength(0);
  });
});

describe("syncAgentToolSupport", () => {
  // role "agent" → persists/reads the `agentModelSupportsTools` config key.
  it("persists true when showModel reports tools capability", async () => {
    const sets: Array<[string, unknown]> = [];
    const supports = await syncAgentToolSupport(
      {
        showModel: async () => ({ capabilities: ["tools"] }),
      },
      {
        set: async (key, value) => {
          sets.push([key, value]);
        },
        getAgentModelSupportsTools: async () => false,
      },
      "qwen2.5:7b",
    );

    expect(supports).toBe(true);
    expect(sets).toEqual([["agentModelSupportsTools", true]]);
  });

  it("keeps existing flag when showModel fails", async () => {
    const sets: Array<[string, unknown]> = [];
    const supports = await syncAgentToolSupport(
      {
        showModel: async () => {
          throw new Error("Ollama unreachable");
        },
      },
      {
        set: async (key, value) => {
          sets.push([key, value]);
        },
        // On probe failure the existing agent flag is read and returned unchanged.
        getAgentModelSupportsTools: async () => true,
      },
      "gemma3:4b",
    );

    expect(supports).toBe(true);
    expect(sets).toHaveLength(0);
  });
});

describe("syncAdvisorToolSupport (deprecated alias for syncAgentToolSupport)", () => {
  // "Advisor" was the agent role's name before the agent/subagent rename.
  // Alias of syncAgentToolSupport → role "agent" → the
  // `agentModelSupportsTools` config key.
  it("persists true when showModel reports tools capability", async () => {
    const sets: Array<[string, unknown]> = [];
    const supports = await syncAdvisorToolSupport(
      {
        showModel: async () => ({ capabilities: ["tools"] }),
      },
      {
        set: async (key, value) => {
          sets.push([key, value]);
        },
        getAgentModelSupportsTools: async () => false,
      },
      "qwen2.5:7b",
    );

    expect(supports).toBe(true);
    expect(sets).toEqual([["agentModelSupportsTools", true]]);
  });

  it("keeps existing flag when showModel fails", async () => {
    const sets: Array<[string, unknown]> = [];
    const supports = await syncAdvisorToolSupport(
      {
        showModel: async () => {
          throw new Error("Ollama unreachable");
        },
      },
      {
        set: async (key, value) => {
          sets.push([key, value]);
        },
        // On probe failure the existing agent flag is read and returned unchanged.
        getAgentModelSupportsTools: async () => false,
      },
      "gemma4:12b",
    );

    expect(supports).toBe(false);
    expect(sets).toHaveLength(0);
  });
});
