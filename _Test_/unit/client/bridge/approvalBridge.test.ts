/**
 * Unit tests — ui/bridge/approval.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockNotifyUser } = vi.hoisted(() => ({
  mockNotifyUser: vi.fn(),
}));

vi.mock("../../../../packages/client/src/ui/notify.js", () => ({
  notifyUser: mockNotifyUser,
}));

import {
  setBridgeHooks,
  setInkUIActiveValue,
  setPendingApprovalEntry,
} from "../../../../packages/client/src/ui/bridge/state.js";
import {
  cancelPendingApprovals,
  getPendingApproval,
  requestApproval,
  resolveApproval,
} from "../../../../packages/client/src/ui/bridge/approval.js";

beforeEach(() => {
  setBridgeHooks({});
  setInkUIActiveValue(false);
  setPendingApprovalEntry(null);
  mockNotifyUser.mockClear();
});

describe("approval bridge", () => {
  it("auto-resolves when Ink is inactive", async () => {
    await expect(
      requestApproval({ type: "runSkip", command: "echo hi" }),
    ).resolves.toBe(false);
    await expect(
      requestApproval({
        type: "planReview",
        task: "refactor the bridge",
        stepCount: 3,
        agentCount: 1,
        execution: "sequential",
        modeLabel: null,
      }),
    ).resolves.toBe("skip");
  });

  it("queues approval when Ink is active", async () => {
    const onApprovalChange = vi.fn();
    setInkUIActiveValue(true);
    setBridgeHooks({ onApprovalChange });

    const pending = requestApproval({ type: "runSkip", command: "ls" });
    expect(getPendingApproval()).toEqual({ type: "runSkip", command: "ls" });
    expect(onApprovalChange).toHaveBeenCalledWith({
      type: "runSkip",
      command: "ls",
    });

    resolveApproval(true);
    await expect(pending).resolves.toBe(true);
    expect(getPendingApproval()).toBeNull();
  });

  it("cancelPendingApprovals resolves with defaults", async () => {
    setInkUIActiveValue(true);
    const pending = requestApproval({ type: "keepUndo", contextLabel: "a.ts" });
    cancelPendingApprovals();
    await expect(pending).resolves.toBe(false);
    expect(getPendingApproval()).toBeNull();
  });

  it("cancelPendingApprovals resolves planReview as skip (Esc / disconnect parity)", async () => {
    setInkUIActiveValue(true);
    const pending = requestApproval({
      type: "planReview",
      task: "refactor",
      stepCount: 1,
      agentCount: 1,
      execution: "sequential",
      modeLabel: null,
    });
    cancelPendingApprovals();
    await expect(pending).resolves.toBe("skip");
  });

  it("fires exactly one Action required notification when the UI is active (normal)", async () => {
    setInkUIActiveValue(true);
    const pending = requestApproval({ type: "runSkip", command: "ls" });
    expect(mockNotifyUser).toHaveBeenCalledOnce();
    expect(mockNotifyUser).toHaveBeenCalledWith("Action required");
    resolveApproval(true);
    await pending;
  });

  it("does not notify when the UI is inactive (boundary)", async () => {
    await requestApproval({ type: "runSkip", command: "ls" });
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });
});
