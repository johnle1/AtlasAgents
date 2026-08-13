/**
 * Unit tests — client ui/taskStream.ts usage-frame handling.
 *
 * A `usage` frame updates context state via the bridge; malformed numbers
 * are clamped or ignored so the footer never shows `NaN%`.
 *
 * Category checklist:
 * - Normal: valid usage calls setContextUsage
 * - Boundary: usedTokens above the window is clamped; zero is accepted
 * - Error: negative window / non-finite values are ignored
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

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({ showThinkOutput: false });
});

describe("runTaskStream — usage frame", () => {
  it("forwards a valid usage frame to setContextUsage (normal)", async () => {
    await runTaskStream(
      fakeConnection([
        { kind: "usage", usedTokens: 1_024, contextWindow: 4_096 },
        { kind: "done" },
      ]),
      "hello",
    );

    expect(mockSetContextUsage).toHaveBeenCalledWith({
      usedTokens: 1_024,
      contextWindow: 4_096,
    });
  });

  it("clamps usedTokens above the window (boundary)", async () => {
    await runTaskStream(
      fakeConnection([
        { kind: "usage", usedTokens: 9_999, contextWindow: 4_096 },
      ]),
      "hello",
    );

    expect(mockSetContextUsage).toHaveBeenCalledWith({
      usedTokens: 4_096,
      contextWindow: 4_096,
    });
  });

  it("accepts usedTokens of 0 (boundary)", async () => {
    await runTaskStream(
      fakeConnection([{ kind: "usage", usedTokens: 0, contextWindow: 8192 }]),
      "hello",
    );

    expect(mockSetContextUsage).toHaveBeenCalledWith({
      usedTokens: 0,
      contextWindow: 8192,
    });
  });

  it("ignores a non-positive contextWindow (error)", async () => {
    await runTaskStream(
      fakeConnection([{ kind: "usage", usedTokens: 10, contextWindow: 0 }]),
      "hello",
    );
    await runTaskStream(
      fakeConnection([{ kind: "usage", usedTokens: 10, contextWindow: -4 }]),
      "hello",
    );

    expect(mockSetContextUsage).not.toHaveBeenCalled();
  });

  it("ignores non-finite usedTokens (error)", async () => {
    await runTaskStream(
      fakeConnection([
        { kind: "usage", usedTokens: Number.NaN, contextWindow: 4096 },
      ]),
      "hello",
    );

    expect(mockSetContextUsage).not.toHaveBeenCalled();
  });
});
