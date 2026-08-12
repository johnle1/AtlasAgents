/**
 * Integration tests — think-stream frames end to end (server → client)
 *
 * @remarks
 * Wires the REAL server-side think pipeline to the REAL client task-stream
 * controller, with fakes only at the two outer boundaries:
 *
 *   model tokens ──► thinkStream.js (scanner + frame emitter, real)
 *                  ──► agent.js Agent.plan (real, lead-agent case only)
 *                  ──► TaskFrame[] (the wire format)
 *                  ──► taskStream.js runTaskStream (real client dispatch)
 *                  ──► uiBridge (mocked — no Ink render)
 *
 * - The model is a fake `IOllamaClient` that streams a think block in
 *   awkward chunks; the RSocket connection is a fake that replays emitted
 *   frames through `onFrame`, mirroring `taskStreamThink.test.ts`.
 * - `uiBridge.js` and `config/index.js` are mocked so the suite runs
 *   headless; everything between the model boundary and the UI bridge is
 *   production code.
 *
 * What this proves that the unit tests on either side cannot:
 * - Server coalescing (`coalesceChars`) and client re-coalescing compose
 *   without dropping or duplicating text.
 * - Scanner chunk-boundary hold-back survives the whole trip: think text
 *   arrives intact in history even when tags split across chunks.
 * - Think text never leaks into the visible assistant stream or history.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAppendHistory,
  mockAppendLiveThink,
  mockClearSubagentStatuses,
  mockEndLiveThink,
  mockRequestApproval,
  mockRequestPrompt,
  mockSetSubagentBoards,
  mockSetSubagentStatus,
  mockSetBusy,
  mockSetSpinner,
  mockSetStreamingText,
  mockSetTaskActive,
  mockStartLiveThink,
  mockUpdateAgentActivity,
  mockSetActiveTaskCancel,
  mockLoadConfig,
} = vi.hoisted(() => ({
  mockAppendHistory: vi.fn(),
  mockAppendLiveThink: vi.fn(),
  mockClearSubagentStatuses: vi.fn(),
  mockEndLiveThink: vi.fn(),
  mockRequestApproval: vi.fn(),
  mockRequestPrompt: vi.fn(),
  mockSetSubagentBoards: vi.fn(),
  mockSetSubagentStatus: vi.fn(),
  mockSetBusy: vi.fn(),
  mockSetSpinner: vi.fn(),
  mockSetStreamingText: vi.fn(),
  mockSetTaskActive: vi.fn(),
  mockStartLiveThink: vi.fn(),
  mockUpdateAgentActivity: vi.fn(),
  mockSetActiveTaskCancel: vi.fn(),
  mockLoadConfig: vi.fn(),
}));

vi.mock("../../../packages/client/src/ui/uiBridge.js", () => ({
  appendHistory: mockAppendHistory,
  appendLiveThink: mockAppendLiveThink,
  clearSubagentStatuses: mockClearSubagentStatuses,
  endLiveThink: mockEndLiveThink,
  requestApproval: mockRequestApproval,
  requestPrompt: mockRequestPrompt,
  setSubagentBoards: mockSetSubagentBoards,
  setSubagentStatus: mockSetSubagentStatus,
  setBusy: mockSetBusy,
  setSpinner: mockSetSpinner,
  setStreamingText: mockSetStreamingText,
  setTaskActive: mockSetTaskActive,
  startLiveThink: mockStartLiveThink,
  updateAgentActivity: mockUpdateAgentActivity,
  setActiveTaskCancel: mockSetActiveTaskCancel,
}));

vi.mock("../../../packages/client/src/ui/notify.js", () => ({
  notifyUser: vi.fn(),
}));

vi.mock("../../../packages/client/src/config/index.js", () => ({
  loadConfig: mockLoadConfig,
}));

import { Agent } from "../../../packages/server/src/orchestration/agent/agent.js";
import { extractAgentThink } from "../../../packages/server/src/orchestration/agent/agentThink.js";
import {
  createThinkFrameEmitter,
  createThinkTagScanner,
} from "../../../packages/server/src/orchestration/thinkStream.js";
import type { TaskFrame as ServerTaskFrame } from "../../../packages/server/src/transport/frames.js";
import type {
  IConfigManager,
  IOllamaClient,
} from "../../../packages/server/src/orchestration/interfaces.js";
import type { Message } from "../../../packages/server/src/orchestration/types.js";

import { runTaskStream } from "../../../packages/client/src/ui/taskStream.js";
import { formatAgentThinkForDisplay } from "../../../packages/client/src/renderer.js";
import type { Connection } from "../../../packages/client/src/connection/index.js";
import type { TaskFrame as ClientTaskFrame } from "../../../packages/client/src/types/frames.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Harness — fake Connection whose sendTask runs the real server pipeline
// ---------------------------------------------------------------------------

/**
 * Frames are collected as the server pipeline produces them, then replayed
 * through `onFrame` in order. Collect-then-replay keeps ordering exact while
 * letting each case build its frames however the real pipeline emits them.
 */
const connectionFromFrames = (frames: ServerTaskFrame[]): Connection =>
  ({
    sendTask: async (options: {
      onFrame: (frame: ClientTaskFrame) => void | Promise<void>;
    }) => {
      const done = (async () => {
        for (const frame of frames) {
          await options.onFrame(frame as unknown as ClientTaskFrame);
        }
      })();
      return { done, cancel: () => {} };
    },
    respondPlan: async () => {},
  }) as unknown as Connection;

/**
 * Runs the REAL lead-agent planner against a fake model that streams the
 * think block character by character (the worst case for the scanner's
 * partial-tag hold-back), with the production hook wiring from
 * orchestratorPipeline: onThinkDelta → emitter.delta, onThinkEnd →
 * emitter.finish.
 */
const runLeadAgentPipeline = async (): Promise<ServerTaskFrame[]> => {
  const frames: ServerTaskFrame[] = [];
  const thinkFrames = createThinkFrameEmitter({
    emit: (frame) => frames.push(frame),
    agent: true,
  });

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
    onThinkDelta: (text) => thinkFrames.delta(text),
    onThinkEnd: (text) => thinkFrames.finish(text),
  });

  return frames;
};

/**
 * Runs the REAL scanner + emitter pair directly (the subagent wiring — see
 * subagent.ts), feeding `chunks` through the scanner and closing the turn
 * with `finalText`, exactly as subagent.ts does with extractThinking output.
 */
const runSubagentPipeline = (params: {
  chunks: string[];
  finalText: string | null;
  source: { agentId: number; agentLabel: string };
}): ServerTaskFrame[] => {
  const frames: ServerTaskFrame[] = [];
  const scanner = createThinkTagScanner(["think"]);
  const thinkFrames = createThinkFrameEmitter({
    emit: (frame) => frames.push(frame),
    agent: false,
    source: params.source,
  });

  for (const chunk of params.chunks) {
    thinkFrames.delta(scanner.push(chunk));
  }
  thinkFrames.delta(scanner.flush());
  thinkFrames.finish(params.finalText);

  return frames;
};

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

const historyItems = () => mockAppendHistory.mock.calls.map(([item]) => item);

const historyThinkEntries = () =>
  historyItems().filter((item) => item.kind === "think");

const historyTextEntries = () =>
  historyItems().filter((item) => item.kind === "text");

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({ showThinkOutput: true });
});

// ---------------------------------------------------------------------------
// Lead agent — full Agent.plan → emitter → client
// ---------------------------------------------------------------------------

describe("think flow — lead agent (Agent.plan → emitter → runTaskStream)", () => {
  it("commits exactly one agent think block with the extracted text", async () => {
    const frames = await runLeadAgentPipeline();

    // The wire itself is well-formed before the client ever sees it:
    // start, ≥1 delta, exactly one end, all sharing one id.
    const kinds = frames.map((frame) => frame.kind);
    expect(kinds[0]).toBe("think-start");
    expect(kinds[kinds.length - 1]).toBe("think-end");
    expect(kinds).toContain("think-delta");
    const ids = new Set(
      frames.map((frame) => ("id" in frame ? frame.id : null)),
    );
    expect(ids.size).toBe(1);

    await runTaskStream(connectionFromFrames(frames), "fix the bug");

    // VALID_THINK_BLOCK is a well-formed fixture, so extraction always
    // succeeds here — the non-null assertion narrows the general
    // `string | null` return type, it doesn't paper over a real null case.
    const expectedText = formatAgentThinkForDisplay(
      extractAgentThink(VALID_THINK_BLOCK)!,
    );
    expect(historyThinkEntries()).toEqual([
      { kind: "think", text: expectedText, agent: true },
    ]);

    // Live view opened and closed with the same wire id, and painted at
    // least once (the block contains newlines, which flush immediately).
    const [startedId, startedAgent, startedLabel] =
      mockStartLiveThink.mock.calls[0];
    expect(startedAgent).toBe(true);
    expect(startedLabel).toBeNull();
    expect(mockEndLiveThink).toHaveBeenCalledWith(startedId);
    expect(mockAppendLiveThink).toHaveBeenCalled();
    for (const [paintId] of mockAppendLiveThink.mock.calls) {
      expect(paintId).toBe(startedId);
    }
  });

  it("never leaks think text into the visible assistant stream or text history", async () => {
    const frames = await runLeadAgentPipeline();
    await runTaskStream(connectionFromFrames(frames), "fix the bug");

    for (const entry of historyTextEntries()) {
      expect(entry.text).not.toContain("COMPLEXITY");
      expect(entry.text).not.toContain("agent-think");
    }
    for (const call of mockSetStreamingText.mock.calls) {
      expect(call[0] ?? "").not.toContain("COMPLEXITY");
    }
  });
});

// ---------------------------------------------------------------------------
// Subagent — scanner + emitter with tag splits across chunk boundaries
// ---------------------------------------------------------------------------

describe("think flow — subagent (scanner chunk boundaries → client)", () => {
  it("survives tags split across chunks and lands intact in history", async () => {
    const frames = runSubagentPipeline({
      // Splits BOTH tags across chunk boundaries — the scanner's hold-back
      // must not emit partial tags as text, nor swallow real text.
      chunks: ["<th", "ink>hello", " wo", "rld</thi", "nk>visible tail"],
      finalText: "hello world",
      source: { agentId: 2, agentLabel: "tester" },
    });

    await runTaskStream(connectionFromFrames(frames), "do something");

    // Labelled per the SubagentTaskBoard convention.
    expect(mockStartLiveThink).toHaveBeenCalledWith(
      expect.any(String),
      false,
      "Agent 2 — tester",
    );
    expect(historyThinkEntries()).toEqual([
      {
        kind: "think",
        text: formatAgentThinkForDisplay("hello world"),
        agent: false,
      },
    ]);
    // Text outside the tag ("visible tail") is discarded by the scanner and
    // must not appear anywhere in the think commit.
    for (const entry of historyThinkEntries()) {
      expect(entry.text).not.toContain("visible tail");
    }
  });

  it("keeps two interleaved subagent streams separate through the whole trip", async () => {
    // Two emitters sharing one frame sink, interleaved chunk by chunk —
    // the concurrent-subagents case from orchestratorPipeline.
    const frames: ServerTaskFrame[] = [];
    const emit = (frame: ServerTaskFrame) => frames.push(frame);
    const scannerA = createThinkTagScanner(["think"]);
    const scannerB = createThinkTagScanner(["think"]);
    const a = createThinkFrameEmitter({
      emit,
      agent: false,
      source: { agentId: 2, agentLabel: "tester" },
    });
    const b = createThinkFrameEmitter({
      emit,
      agent: false,
      source: { agentId: 3, agentLabel: "worker" },
    });

    a.delta(scannerA.push("<think>alpha one\n"));
    b.delta(scannerB.push("<think>beta one\n"));
    a.delta(scannerA.push("alpha two\n"));
    b.delta(scannerB.push("beta two</think>"));
    b.delta(scannerB.flush());
    b.finish("beta one\nbeta two");
    a.delta(scannerA.push("</think>"));
    a.delta(scannerA.flush());
    a.finish("alpha one\nalpha two");

    await runTaskStream(connectionFromFrames(frames), "do something");

    expect(mockStartLiveThink.mock.calls).toEqual([
      [expect.any(String), false, "Agent 2 — tester"],
      [expect.any(String), false, "Agent 3 — worker"],
    ]);
    // Each stream commits exactly once, in completion order, with its own
    // text — no cross-contamination between ids.
    expect(historyThinkEntries()).toEqual([
      {
        kind: "think",
        text: formatAgentThinkForDisplay("beta one\nbeta two"),
        agent: false,
      },
      {
        kind: "think",
        text: formatAgentThinkForDisplay("alpha one\nalpha two"),
        agent: false,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Zero-delta turn — finish() with final text but no incremental deltas
// ---------------------------------------------------------------------------

describe("think flow — zero-delta turn (finish() only, no delta() calls)", () => {
  it("opens and closes a live think stream in one shot, and the client commits it", async () => {
    // A turn where the scanner found nothing streamable: finish() with the
    // whole-block text opens a think-start immediately followed by its
    // think-end, so the text is never dropped.
    const frames: ServerTaskFrame[] = [];
    const thinkFrames = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: true,
    });
    thinkFrames.finish("whole-block reasoning");

    expect(frames.map((frame) => frame.kind)).toEqual([
      "think-start",
      "think-end",
    ]);

    await runTaskStream(connectionFromFrames(frames), "do something");

    expect(mockStartLiveThink).toHaveBeenCalledTimes(1);
    expect(historyThinkEntries()).toEqual([
      {
        kind: "think",
        text: formatAgentThinkForDisplay("whole-block reasoning"),
        agent: true,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Gate — showThinkOutput off suppresses the whole pipeline at the client
// ---------------------------------------------------------------------------

describe("think flow — showThinkOutput gate", () => {
  it("displays nothing when the gate is off, even though frames stream", async () => {
    mockLoadConfig.mockReturnValue({ showThinkOutput: false });

    const frames = await runLeadAgentPipeline();
    expect(frames.length).toBeGreaterThan(0); // server still produced frames

    await runTaskStream(connectionFromFrames(frames), "fix the bug");

    expect(mockStartLiveThink).not.toHaveBeenCalled();
    expect(mockAppendLiveThink).not.toHaveBeenCalled();
    expect(mockEndLiveThink).not.toHaveBeenCalled();
    expect(historyThinkEntries()).toEqual([]);
  });
});
