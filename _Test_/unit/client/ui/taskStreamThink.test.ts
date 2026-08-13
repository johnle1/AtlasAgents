/**
 * Unit tests — client ui/taskStream.ts (think-start/think-delta/think-end handling)
 *
 * @remarks
 * `uiBridge.js` and `config/index.js` are mocked so this exercises taskStream's
 * own frame-dispatch and coalescing logic in isolation, without a real Ink
 * render or RSocket connection. The fake `Connection.sendTask` simply
 * replays a fixed frame sequence through `onFrame`, synchronously.
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
  mockNotifyUser,
  mockSetContextUsage,
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
  mockNotifyUser: vi.fn(),
  mockSetContextUsage: vi.fn(),
  mockLoadConfig: vi.fn(),
}));

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
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
  setContextUsage: mockSetContextUsage,
}));

vi.mock("../../../../packages/client/src/ui/notify.js", () => ({
  notifyUser: mockNotifyUser,
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: mockLoadConfig,
}));

import { runTaskStream } from "../../../../packages/client/src/ui/taskStream.js";
import type { Connection } from "../../../../packages/client/src/connection/index.js";
import type { TaskFrame } from "../../../../packages/client/src/types/frames.js";

/** Replays a fixed frame sequence through onFrame, then resolves `done`. */
const fakeConnection = (frames: TaskFrame[]): Connection =>
  ({
    sendTask: async (options: {
      onFrame: (frame: TaskFrame) => void | Promise<void>;
    }) => {
      const done = (async () => {
        for (const frame of frames) {
          await options.onFrame(frame);
        }
      })();
      return { done, cancel: () => {} };
    },
    respondPlan: async () => {},
  }) as unknown as Connection;

const appendHistoryThinkCalls = () =>
  mockAppendHistory.mock.calls
    .map(([item]) => item)
    .filter((item) => item.kind === "think");

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({ showThinkOutput: true });
});

describe("runTaskStream — showThinkOutput off", () => {
  it("ignores think-start/delta/end entirely when the gate is off", async () => {
    mockLoadConfig.mockReturnValue({ showThinkOutput: false });
    const connection = fakeConnection([
      { kind: "think-start", id: "t1", agent: false },
      { kind: "think-delta", id: "t1", text: "reasoning\n" },
      { kind: "think-end", id: "t1", text: "reasoning" },
    ]);

    await runTaskStream(connection, "do something");

    expect(mockStartLiveThink).not.toHaveBeenCalled();
    expect(mockAppendLiveThink).not.toHaveBeenCalled();
    expect(mockEndLiveThink).not.toHaveBeenCalled();
    expect(appendHistoryThinkCalls()).toEqual([]);
  });
});

describe("runTaskStream — showThinkOutput on", () => {
  it("streams a single think block and commits it on think-end", async () => {
    const connection = fakeConnection([
      {
        kind: "think-start",
        id: "t1",
        agent: false,
        source: { agentId: 2, agentLabel: "tester" },
      },
      { kind: "think-delta", id: "t1", text: "first line\n" },
      { kind: "think-delta", id: "t1", text: "second line\n" },
      { kind: "think-end", id: "t1", text: "first line\nsecond line" },
    ]);

    await runTaskStream(connection, "do something");

    expect(mockStartLiveThink).toHaveBeenCalledWith(
      "t1",
      false,
      "Agent 2 — tester",
    );
    // Each delta ends with "\n", so each paints immediately rather than
    // waiting to accumulate — deterministic regardless of terminal width.
    expect(mockAppendLiveThink.mock.calls).toEqual([
      ["t1", "first line\n"],
      ["t1", "second line\n"],
    ]);
    expect(mockEndLiveThink).toHaveBeenCalledWith("t1");
    expect(appendHistoryThinkCalls()).toEqual([
      { kind: "think", text: "first line\nsecond line", agent: false },
    ]);
  });

  it("ignores a delta for an unknown id without throwing", async () => {
    const connection = fakeConnection([
      { kind: "think-delta", id: "unknown", text: "orphaned" },
    ]);

    await expect(runTaskStream(connection, "do something")).resolves.toBeUndefined();
    expect(mockAppendLiveThink).not.toHaveBeenCalled();
  });

  it("keeps two interleaved think streams separate", async () => {
    const connection = fakeConnection([
      { kind: "think-start", id: "t1", agent: true },
      { kind: "think-start", id: "t2", agent: false, source: { agentId: 3, agentLabel: "worker" } },
      { kind: "think-delta", id: "t1", text: "agent line\n" },
      { kind: "think-delta", id: "t2", text: "worker line\n" },
      { kind: "think-end", id: "t2", text: "worker line" },
      { kind: "think-end", id: "t1", text: "agent line" },
    ]);

    await runTaskStream(connection, "do something");

    expect(mockAppendLiveThink.mock.calls).toEqual([
      ["t1", "agent line\n"],
      ["t2", "worker line\n"],
    ]);
    expect(appendHistoryThinkCalls()).toEqual([
      { kind: "think", text: "worker line", agent: false },
      { kind: "think", text: "agent line", agent: true },
    ]);
  });

  it("accumulates sub-threshold deltas without repainting yet commits in full on think-end", async () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 80,
      configurable: true,
    });

    try {
      // threshold = max(8, floor(80/8)) = 10 chars; neither delta below
      // reaches it and neither contains a newline.
      const connection = fakeConnection([
        { kind: "think-start", id: "t1", agent: false },
        { kind: "think-delta", id: "t1", text: "ab" },
        { kind: "think-delta", id: "t1", text: "cd" },
        { kind: "think-end", id: "t1" },
      ]);

      await runTaskStream(connection, "do something");

      expect(mockAppendLiveThink).not.toHaveBeenCalled();
      // think-end omitted `text`, so the commit falls back to everything
      // accumulated locally — proving no text was silently dropped.
      expect(appendHistoryThinkCalls()).toEqual([
        { kind: "think", text: "abcd", agent: false },
      ]);
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        configurable: true,
      });
    }
  });

  it("commits an open think stream before the plan-review approval prompt", async () => {
    mockRequestApproval.mockResolvedValue("skip");
    const connection = fakeConnection([
      { kind: "think-start", id: "t1", agent: true },
      { kind: "think-delta", id: "t1", text: "still reasoning\n" },
      {
        kind: "confirm-plan",
        id: "plan-1",
        task: "do something",
        steps: ["step"],
        risks: [],
        agents: [],
        agentCount: 1,
        execution: "sequential",
        modeLabel: null,
      },
    ]);

    await runTaskStream(connection, "do something");

    expect(mockEndLiveThink).toHaveBeenCalledWith("t1");
    const historyKinds = mockAppendHistory.mock.calls.map(([item]) => item.kind);
    // The think block must commit before the plan card appears.
    expect(historyKinds.indexOf("think")).toBeLessThan(
      historyKinds.indexOf("plan"),
    );
  });

  it("continues a stream force-committed by the plan-review prompt instead of dropping the rest (regression guard)", async () => {
    // commitLiveThinks() used to clear the whole thinkStreams map, so every
    // later frame for that id hit the "unknown id" no-op path — the server
    // has no idea the client force-closed anything and keeps streaming.
    // A subagent still reasoning through a plan-review prompt lost
    // everything after the prompt appeared.
    mockRequestApproval.mockResolvedValue("skip");
    const connection = fakeConnection([
      { kind: "think-start", id: "t1", agent: false },
      { kind: "think-delta", id: "t1", text: "before the prompt\n" },
      {
        kind: "confirm-plan",
        id: "plan-1",
        task: "do something",
        steps: ["step"],
        risks: [],
        agents: [],
        agentCount: 1,
        execution: "sequential",
        modeLabel: null,
      },
      // The server keeps streaming t1 after the force-commit.
      { kind: "think-delta", id: "t1", text: "after the prompt\n" },
      { kind: "think-end", id: "t1", text: "before the prompt\nafter the prompt" },
    ]);

    await runTaskStream(connection, "do something");

    // Reopened for the continuation, not silently dropped.
    expect(mockStartLiveThink.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockAppendLiveThink.mock.calls).toContainEqual(["t1", "after the prompt\n"]);

    const thinkCalls = appendHistoryThinkCalls();
    // The pre-prompt text was committed once by the force-commit; the
    // post-prompt continuation must appear too, not be lost.
    const combined = thinkCalls.map((c) => c.text).join("\n");
    expect(combined).toContain("before the prompt");
    expect(combined).toContain("after the prompt");
    // And it must not be duplicated: "before the prompt" appears exactly once.
    expect(thinkCalls.filter((c) => c.text.includes("before the prompt"))).toHaveLength(1);
  });

  it("a think-end with no committed prefix still commits normally (no regression on the common path)", async () => {
    const connection = fakeConnection([
      { kind: "think-start", id: "t1", agent: false },
      { kind: "think-delta", id: "t1", text: "just one block\n" },
      { kind: "think-end", id: "t1", text: "just one block" },
    ]);

    await runTaskStream(connection, "do something");

    expect(appendHistoryThinkCalls()).toEqual([
      { kind: "think", text: "just one block", agent: false },
    ]);
  });

  it("commits an open think stream before the error message", async () => {
    // handleErrorFrame's own commit fires synchronously as soon as the error
    // frame is dispatched — independent of whether the stream promise itself
    // later resolves or rejects, so a fake that never rejects still proves
    // the ordering.
    const connection = fakeConnection([
      { kind: "think-start", id: "t1", agent: false },
      { kind: "think-delta", id: "t1", text: "reasoning\n" },
      { kind: "error", message: "boom" },
    ]);

    await runTaskStream(connection, "do something");

    const historyItems = mockAppendHistory.mock.calls.map(([item]) => item);
    const thinkIndex = historyItems.findIndex((item) => item.kind === "think");
    const errorIndex = historyItems.findIndex(
      (item) => item.kind === "text" && item.variant === "error",
    );
    expect(thinkIndex).toBeGreaterThanOrEqual(0);
    expect(thinkIndex).toBeLessThan(errorIndex);
  });
});

describe("runTaskStream — notifications", () => {
  it("fires one Task complete notification on success (normal)", async () => {
    const connection = fakeConnection([]);
    await runTaskStream(connection, "do something");
    expect(mockNotifyUser).toHaveBeenCalledOnce();
    expect(mockNotifyUser).toHaveBeenCalledWith("Task complete");
  });

  it("does not notify on a server error frame (error)", async () => {
    const connection = fakeConnection([{ kind: "error", message: "boom" }]);
    await runTaskStream(connection, "do something");
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("does not notify when the user cancels (boundary)", async () => {
    let resolveDone: (() => void) | undefined;
    const connection = {
      sendTask: async () => {
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        return {
          done,
          cancel: () => {
            resolveDone?.();
          },
        };
      },
      respondPlan: async () => {},
    } as unknown as Connection;

    const running = runTaskStream(connection, "do something");
    await Promise.resolve();
    const cancel = mockSetActiveTaskCancel.mock.calls.find(
      (call) => typeof call[0] === "function",
    )?.[0] as (() => void) | undefined;
    expect(cancel).toBeTypeOf("function");
    cancel!();
    await running;

    expect(mockNotifyUser).not.toHaveBeenCalled();
    expect(mockAppendHistory).toHaveBeenCalledWith({
      kind: "text",
      text: "Task cancelled by user",
      variant: "warning",
    });
  });
});
