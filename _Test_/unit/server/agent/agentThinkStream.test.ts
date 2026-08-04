/**
 * Unit tests — server orchestration/agent/agent.ts (incremental think streaming)
 *
 * Covers the onThinkDelta/onThinkEnd hooks added to Agent.plan(): deltas
 * arriving via either the content or reasoning channel on the native
 * tool-calling path, deltas arriving inline on the text-mode (chatStream)
 * path, an unclosed think tag still producing a matching close signal, and
 * an auxiliary-tool-call turn (explore_codebase) that `continue`s the loop
 * still closing its own stream before doing so.
 */

import { describe, expect, it } from "vitest";
import { Agent } from "../../../../packages/server/src/orchestration/agent/agent.js";
import { extractAgentThink } from "../../../../packages/server/src/orchestration/agent/agentThink.js";
import { EXPLORE_CODEBASE_TOOL_NAME } from "../../../../packages/server/src/orchestration/agent/agentTools.js";
import type {
  IConfigManager,
  IOllamaClient,
} from "../../../../packages/server/src/orchestration/interfaces.js";
import type { Message } from "../../../../packages/server/src/orchestration/types.js";

const VALID_THINK_BLOCK = `<agent-think>
COMPLEXITY: simple
  reasoning: fix one bug with tests

UNDERSTAND:
  literal: fix bug

EXPLORATION:
  need explore? no

PLAN:
  agent count: 1
  execution: sequential

  Agent 1 — implementation:
    1. do work

SELF-CHECK:
  issues? none

COMMAND PLAN:
  setup commands: none
  verify commands: npm test
</agent-think>`;

const VALID_PLAN_ARGS = {
  subtasks: [
    {
      id: 1,
      text: "do work",
      dependsOn: [],
      agentId: 1,
      agentLabel: "implementation",
    },
  ],
  execution: "sequential",
  agentCount: 1,
  risks: [] as string[],
};

const nativeConfig = {
  getAgentModel: async () => "test-agent",
  getAgentTemperature: async () => 0,
  getAgentModelSupportsTools: async () => true,
} as unknown as IConfigManager;

const textModeConfig = {
  getAgentModel: async () => "gemma4:26b",
  getAgentTemperature: async () => 0,
  getAgentModelSupportsTools: async () => false,
} as unknown as IConfigManager;

describe("Agent.plan think-delta streaming", () => {
  it("streams agent-think content incrementally via the native content channel", async () => {
    const deltas: string[] = [];
    const endCalls: (string | null)[] = [];

    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: Message[],
        _tools: unknown[],
        _options: unknown,
        onToken?: (token: string) => void,
      ) => {
        for (const character of VALID_THINK_BLOCK) {
          onToken?.(character);
        }
        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const agent = new Agent({ ollama, config: nativeConfig });
    await agent.plan("fix the bug", "", "", undefined, {
      onThinkDelta: (text) => deltas.push(text),
      onThinkEnd: (text) => endCalls.push(text),
    });

    const expectedInner = extractAgentThink(VALID_THINK_BLOCK);
    // Deltas are the scanner's raw, untrimmed inner text (trimming can't
    // happen mid-stream); trim before comparing to the trimmed final block.
    expect(deltas.join("").trim()).toBe(expectedInner);
    expect(endCalls).toEqual([expectedInner]);
  });

  it("streams agent-think content when it arrives via the reasoning channel instead of content", async () => {
    // Reasoning-heavy models sometimes return empty `content` and put
    // everything in `thinking` — agent.ts falls back to `thinking` in that
    // case (agentResult.content || agentResult.thinking). onThinkToken must
    // feed the same scanner so the block is still recognized.
    const deltas: string[] = [];

    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: Message[],
        _tools: unknown[],
        options: { onThinkToken?: (token: string) => void },
      ) => {
        for (const character of VALID_THINK_BLOCK) {
          options.onThinkToken?.(character);
        }
        return {
          content: "",
          thinking: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const agent = new Agent({ ollama, config: nativeConfig });
    await agent.plan("fix the bug", "", "", undefined, {
      onThinkDelta: (text) => deltas.push(text),
    });

    expect(deltas.join("").trim()).toBe(extractAgentThink(VALID_THINK_BLOCK));
  });

  it("streams agent-think content incrementally on the text-mode (chatStream) path", async () => {
    const deltas: string[] = [];
    const endCalls: (string | null)[] = [];
    const fullResponse = `${VALID_THINK_BLOCK}\n${JSON.stringify(VALID_PLAN_ARGS)}`;

    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        for (const character of fullResponse) {
          yield character;
        }
      },
    } as unknown as IOllamaClient;

    const agent = new Agent({ ollama, config: textModeConfig });
    await agent.plan("fix the bug", "", "", undefined, {
      onThinkDelta: (text) => deltas.push(text),
      onThinkEnd: (text) => endCalls.push(text),
    });

    const expectedInner = extractAgentThink(VALID_THINK_BLOCK);
    expect(deltas.join("").trim()).toBe(expectedInner);
    expect(endCalls).toEqual([expectedInner]);
  });

  it("still calls onThinkEnd(null) every iteration when the tag is opened but never closed", async () => {
    const endCalls: (string | null)[] = [];
    const ollama = {
      chatWithTools: async () => ({
        content: "<agent-think>opened but never closed",
        toolCalls: [],
      }),
    } as unknown as IOllamaClient;

    const agent = new Agent({ ollama, config: nativeConfig });
    // The model never produces a valid plan, so plan() is guaranteed to
    // reject once its bounded retry budget is exhausted — only the
    // onThinkEnd calls made along the way are under test here.
    await agent
      .plan("fix the bug", "", "", undefined, {
        onThinkEnd: (text) => endCalls.push(text),
      })
      .catch(() => {});

    expect(endCalls.length).toBeGreaterThan(0);
    expect(endCalls.every((text) => text === null)).toBe(true);
  });

  it("closes the think stream for a turn that continues via an auxiliary tool call (explore_codebase)", async () => {
    const endCalls: (string | null)[] = [];
    let chatCallCount = 0;

    const ollama = {
      chatWithTools: async () => {
        chatCallCount += 1;
        if (chatCallCount === 1) {
          return {
            content: "",
            toolCalls: [
              {
                name: EXPLORE_CODEBASE_TOOL_NAME,
                args: { reason: "unknown stack" },
              },
            ],
          };
        }
        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const agent = new Agent({ ollama, config: nativeConfig });
    await agent.plan("add feature", "", "", undefined, {
      onThinkEnd: (text) => endCalls.push(text),
      exploreCodebase: async () => ({
        snapshot: "Structure:\npackages/\n_Test_/\n",
      }),
    });

    expect(chatCallCount).toBe(2);
    // First turn had no think block at all (still closes with null) and
    // `continue`d past the aux tool call; second turn produced the plan.
    expect(endCalls).toEqual([null, extractAgentThink(VALID_THINK_BLOCK)]);
  });
});

describe("Agent.plan think-delta streaming (content/reasoning channel isolation)", () => {
  it("still recognizes a tag split across content-channel chunks by an interleaved reasoning-channel token (regression guard)", async () => {
    // Both channels used to feed one shared scanner. A reasoning token
    // landing between the two content-channel halves of "<agent-think>"
    // broke the buffer's match against the open tag, and the whole block
    // was silently dropped from the live view.
    const deltas: string[] = [];
    const splitIndex = "<agent-thi".length;

    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: Message[],
        _tools: unknown[],
        options: { onThinkToken?: (token: string) => void },
        onToken?: (token: string) => void,
      ) => {
        onToken?.(VALID_THINK_BLOCK.slice(0, splitIndex));
        options.onThinkToken?.("unrelated reasoning chatter ");
        onToken?.(VALID_THINK_BLOCK.slice(splitIndex));
        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const agent = new Agent({ ollama, config: nativeConfig });
    await agent.plan("fix the bug", "", "", undefined, {
      onThinkDelta: (text) => deltas.push(text),
    });

    expect(deltas.join("").trim()).toBe(extractAgentThink(VALID_THINK_BLOCK));
  });

  it("does not leak untagged reasoning-channel text while the content channel is mid-block (regression guard)", async () => {
    // Once the content channel's scanner is `inside` a block, the old
    // shared-scanner design had no way to tell that a reasoning-channel
    // push wasn't more of the same block — it emitted raw, untagged
    // chain-of-thought verbatim as a delta, the exact leak the module's own
    // docs say is prevented.
    const deltas: string[] = [];
    const openIndex = VALID_THINK_BLOCK.indexOf("\n") + 1; // just past "<agent-think>\n"

    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: Message[],
        _tools: unknown[],
        options: { onThinkToken?: (token: string) => void },
        onToken?: (token: string) => void,
      ) => {
        onToken?.(VALID_THINK_BLOCK.slice(0, openIndex));
        options.onThinkToken?.("UNTAGGED_LEAK_MARKER");
        onToken?.(VALID_THINK_BLOCK.slice(openIndex));
        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const agent = new Agent({ ollama, config: nativeConfig });
    await agent.plan("fix the bug", "", "", undefined, {
      onThinkDelta: (text) => deltas.push(text),
    });

    const joined = deltas.join("");
    expect(joined).not.toContain("UNTAGGED_LEAK_MARKER");
    expect(joined.trim()).toBe(extractAgentThink(VALID_THINK_BLOCK));
  });
});
