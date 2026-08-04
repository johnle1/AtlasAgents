/**
 * Unit tests — server orchestration/subagent/subagent.ts (incremental think streaming)
 *
 * Covers Subagent.run()'s think-start/think-delta/think-end emission: deltas
 * streaming via the native tool-calling path's content channel, the
 * open-then-immediately-close fallback when nothing drives an incremental
 * callback this turn, the text-mode (chatStream) path, and that the
 * pre-existing command-plan retry logic (trackers.firstThinkSeen /
 * commandPlanRetryUsed) still runs correctly with each iteration's think
 * stream closing independently.
 *
 * Dependencies are stubbed as minimally as the "finish" tool path allows —
 * see finishHandler.ts, which only reads handlerContext.trackers/commandPlan
 * (both built internally by Subagent.run) and never touches
 * workspace/terminal/recorder, so empty objects satisfy them here.
 */

import { describe, expect, it, vi } from "vitest";
import { Subagent } from "../../../../packages/server/src/orchestration/subagent/subagent.js";
import { extractThinking } from "../../../../packages/server/src/orchestration/toolProtocol.js";
import type { Agent } from "../../../../packages/server/src/orchestration/agent/agent.js";
import type {
  IConfigManager,
  IOllamaClient,
} from "../../../../packages/server/src/orchestration/interfaces.js";
import type { TaskFrame } from "../../../../packages/server/src/transport/frames.js";
import type { AgentRunParams } from "../../../../packages/server/src/orchestration/subagent/types.js";
import { logger } from "../../../../packages/server/src/utils/logger.js";

const THINK_BLOCK = `<redacted_thinking>
Setup commands: none
Verify commands: none
Off-limits (run-project): none
Proceeding straight to finish — nothing to set up or verify for this trivial subtask.
</redacted_thinking>`;

const nativeConfig = {
  getSubagentModel: async () => "fake-subagent-model",
  getSubagentTemperature: async () => 0.4,
  getSubagentModelSupportsTools: async () => true,
  getMaxRetries: async () => 3,
} as unknown as IConfigManager;

const textModeConfig = {
  getSubagentModel: async () => "fake-subagent-model",
  getSubagentTemperature: async () => 0.4,
  getSubagentModelSupportsTools: async () => false,
  getMaxRetries: async () => 3,
} as unknown as IConfigManager;

const baseRunParams = (
  emit: (frame: TaskFrame) => void,
  debug?: boolean,
): AgentRunParams => ({
  taskId: "task-1",
  subtask: "do the thing",
  agentId: 1,
  agentLabel: "worker",
  skillContent: "",
  sessionContext: "",
  workspace: {},
  terminal: {},
  recorder: {},
  emit,
  signal: new AbortController().signal,
  ...(debug ? { debug: true } : {}),
});

const makeSubagent = (
  ollama: IOllamaClient,
  config: IConfigManager = nativeConfig,
): Subagent =>
  new Subagent({ ollama, config, agent: {} as unknown as Agent });

describe("Subagent think-delta streaming (native tool-calling path)", () => {
  it("streams redacted_thinking content incrementally via the content channel", async () => {
    const frames: TaskFrame[] = [];
    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: unknown[],
        _tools: unknown[],
        _options: unknown,
        onToken?: (token: string) => void,
      ) => {
        for (const character of THINK_BLOCK) {
          onToken?.(character);
        }
        return {
          content: THINK_BLOCK,
          toolCalls: [{ name: "finish", args: { summary: "done", keyFindings: [] } }],
        };
      },
    } as unknown as IOllamaClient;

    await makeSubagent(ollama).run(baseRunParams((frame) => frames.push(frame)));

    const startFrames = frames.filter((frame) => frame.kind === "think-start");
    const deltaFrames = frames.filter((frame) => frame.kind === "think-delta");
    const endFrames = frames.filter((frame) => frame.kind === "think-end");

    expect(startFrames).toHaveLength(1);
    expect(startFrames[0]).toMatchObject({
      agent: false,
      source: { agentId: 1, agentLabel: "worker" },
    });
    expect(endFrames).toHaveLength(1);

    const combinedDelta = deltaFrames
      .map((frame) => (frame as Extract<TaskFrame, { kind: "think-delta" }>).text)
      .join("");
    expect(combinedDelta.trim()).toBe(extractThinking(THINK_BLOCK));

    // All three frames belong to the same stream.
    const ids = new Set(
      [...startFrames, ...deltaFrames, ...endFrames].map(
        (frame) => (frame as { id: string }).id,
      ),
    );
    expect(ids.size).toBe(1);
  });

  it("emits a start/end pair with the full text when nothing drives an incremental callback", async () => {
    const frames: TaskFrame[] = [];
    const ollama = {
      chatWithTools: async () => ({
        content: THINK_BLOCK,
        toolCalls: [{ name: "finish", args: { summary: "done", keyFindings: [] } }],
      }),
    } as unknown as IOllamaClient;

    await makeSubagent(ollama).run(baseRunParams((frame) => frames.push(frame)));

    expect(frames.filter((frame) => frame.kind === "think-delta")).toEqual([]);
    const startFrames = frames.filter((frame) => frame.kind === "think-start");
    const endFrames = frames.filter((frame) => frame.kind === "think-end");
    expect(startFrames).toHaveLength(1);
    expect(endFrames).toEqual([
      {
        kind: "think-end",
        id: (startFrames[0] as { id: string }).id,
        text: extractThinking(THINK_BLOCK),
      },
    ]);
  });
});

describe("Subagent think-delta streaming (text-mode / chatStream path)", () => {
  it("streams redacted_thinking content incrementally as tokens are yielded", async () => {
    const frames: TaskFrame[] = [];
    const fullResponse = `${THINK_BLOCK}\n<<TOOL>>{"tool":"finish","summary":"done","keyFindings":[]}<<END>>`;
    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        for (const character of fullResponse) {
          yield character;
        }
      },
    } as unknown as IOllamaClient;

    await makeSubagent(ollama, textModeConfig).run(
      baseRunParams((frame) => frames.push(frame)),
    );

    const deltaFrames = frames.filter((frame) => frame.kind === "think-delta");
    expect(frames.filter((frame) => frame.kind === "think-start")).toHaveLength(1);
    expect(frames.filter((frame) => frame.kind === "think-end")).toHaveLength(1);
    const combinedDelta = deltaFrames
      .map((frame) => (frame as Extract<TaskFrame, { kind: "think-delta" }>).text)
      .join("");
    expect(combinedDelta.trim()).toBe(extractThinking(THINK_BLOCK));
  });
});

describe("Subagent think streaming alongside the command-plan retry", () => {
  it("closes two independent think streams across a command-plan retry round", async () => {
    const frames: TaskFrame[] = [];
    let callCount = 0;
    // Missing setup/verify/off-limits sections — fails hasCommandPlanSection,
    // triggering the first-think retry-prompt injection (subagent.ts).
    const incompleteThink =
      "<redacted_thinking>\nI'll just start working.\n</redacted_thinking>";

    const ollama = {
      chatWithTools: async () => {
        callCount += 1;
        if (callCount === 1) {
          return { content: incompleteThink, toolCalls: [] };
        }
        return {
          content: THINK_BLOCK,
          toolCalls: [{ name: "finish", args: { summary: "done", keyFindings: [] } }],
        };
      },
    } as unknown as IOllamaClient;

    await makeSubagent(ollama).run(baseRunParams((frame) => frames.push(frame)));

    expect(callCount).toBe(2);
    // Neither turn's fake drives a delta callback, so both open-then-close
    // immediately in finish() — proving each iteration's emitter is
    // independent (the second iteration isn't left thinking it already
    // opened a stream).
    expect(frames.filter((frame) => frame.kind === "think-start")).toHaveLength(2);
    const endFrames = frames.filter((frame) => frame.kind === "think-end");
    expect(endFrames.map((frame) => (frame as { text?: string }).text)).toEqual([
      "I'll just start working.",
      extractThinking(THINK_BLOCK),
    ]);
  });
});

describe("Subagent thinking-field fallback (native tool-calling path)", () => {
  it("does not spuriously retry 'missing thinking' when reasoning arrives only via the thinking field, not content (regression guard)", async () => {
    // ChatResult.content used to be the only source extractThinking() ever
    // read. A model that puts its whole <redacted_thinking> block in the
    // native `thinking` field (leaving `content` empty, which is normal for
    // a turn that's purely a tool call) had thinkText come back null even
    // though it clearly reasoned — live-streamed to the UI correctly via
    // onThinkToken — tripping subagentRetryHandler's "Tool called but no
    // thinking block" retry on every single turn, forever, since nothing
    // about the retry changes what channel the model uses.
    const frames: TaskFrame[] = [];
    let callCount = 0;
    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: unknown[],
        _tools: unknown[],
        options: { onThinkToken?: (token: string) => void },
      ) => {
        callCount += 1;
        for (const character of THINK_BLOCK) {
          options.onThinkToken?.(character);
        }
        return {
          content: "",
          thinking: THINK_BLOCK,
          toolCalls: [{ name: "finish", args: { summary: "done", keyFindings: [] } }],
        };
      },
    } as unknown as IOllamaClient;

    const result = await makeSubagent(ollama).run(
      baseRunParams((frame) => frames.push(frame)),
    );

    expect(callCount).toBe(1); // no retry — thinking was found via the fallback
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("done");
    // Still correctly streamed live via the reasoning channel.
    expect(frames.some((frame) => frame.kind === "think-start")).toBe(true);
  });
});

describe("Subagent think-delta streaming (content/reasoning channel isolation)", () => {
  it("still recognizes a redacted_thinking tag split across content-channel chunks by an interleaved reasoning-channel token (regression guard)", async () => {
    const frames: TaskFrame[] = [];
    const splitIndex = "<redacted_thi".length;

    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: unknown[],
        _tools: unknown[],
        options: { onThinkToken?: (token: string) => void },
        onToken?: (token: string) => void,
      ) => {
        onToken?.(THINK_BLOCK.slice(0, splitIndex));
        options.onThinkToken?.("unrelated reasoning chatter ");
        onToken?.(THINK_BLOCK.slice(splitIndex));
        return {
          content: THINK_BLOCK,
          toolCalls: [{ name: "finish", args: { summary: "done", keyFindings: [] } }],
        };
      },
    } as unknown as IOllamaClient;

    await makeSubagent(ollama).run(baseRunParams((frame) => frames.push(frame)));

    const deltaFrames = frames.filter((frame) => frame.kind === "think-delta");
    const combinedDelta = deltaFrames
      .map((frame) => (frame as Extract<TaskFrame, { kind: "think-delta" }>).text)
      .join("");
    expect(combinedDelta.trim()).toBe(extractThinking(THINK_BLOCK));
  });

  it("does not leak untagged reasoning-channel text while the content channel is mid-block (regression guard)", async () => {
    const frames: TaskFrame[] = [];
    const openIndex = THINK_BLOCK.indexOf("\n") + 1;

    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: unknown[],
        _tools: unknown[],
        options: { onThinkToken?: (token: string) => void },
        onToken?: (token: string) => void,
      ) => {
        onToken?.(THINK_BLOCK.slice(0, openIndex));
        options.onThinkToken?.("UNTAGGED_LEAK_MARKER");
        onToken?.(THINK_BLOCK.slice(openIndex));
        return {
          content: THINK_BLOCK,
          toolCalls: [{ name: "finish", args: { summary: "done", keyFindings: [] } }],
        };
      },
    } as unknown as IOllamaClient;

    await makeSubagent(ollama).run(baseRunParams((frame) => frames.push(frame)));

    const deltaFrames = frames.filter((frame) => frame.kind === "think-delta");
    const combinedDelta = deltaFrames
      .map((frame) => (frame as Extract<TaskFrame, { kind: "think-delta" }>).text)
      .join("");
    expect(combinedDelta).not.toContain("UNTAGGED_LEAK_MARKER");
    expect(combinedDelta.trim()).toBe(extractThinking(THINK_BLOCK));
  });
});

describe("Subagent text-mode parseAllToolCalls", () => {
  it("parses legacy tool blocks from streamed assistant text", async () => {
    const fullResponse = `${THINK_BLOCK}\n<<TOOL>>{"tool":"finish","summary":"parsed via text mode","keyFindings":[]}<<END>>`;
    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        for (const character of fullResponse) {
          yield character;
        }
      },
    } as unknown as IOllamaClient;

    const result = await makeSubagent(ollama, textModeConfig).run(
      baseRunParams(vi.fn()),
    );

    expect(result.summary).toBe("parsed via text mode");
  });
});

describe("Subagent agentDebugLog", () => {
  it("logs turn diagnostics only when debug is enabled (pushThink frames)", async () => {
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => undefined);

    const ollama = {
      chatWithTools: async () => ({
        content: THINK_BLOCK,
        toolCalls: [{ name: "finish", args: { summary: "ok", keyFindings: [] } }],
      }),
    } as unknown as IOllamaClient;

    await makeSubagent(ollama).run(baseRunParams(vi.fn(), true));

    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});
