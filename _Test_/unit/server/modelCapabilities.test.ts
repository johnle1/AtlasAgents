import { describe, expect, it } from "vitest";
import { modelSupportsNativeTools } from "../../../packages/server/src/ollama/modelCapabilities.js";
import { syncAdvisorToolSupport, syncAgentToolSupport } from "../../../packages/server/src/ollama/syncAgentToolSupport.js";
import type { ModelInfo } from "../../../packages/server/src/ollama/types.js";

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
