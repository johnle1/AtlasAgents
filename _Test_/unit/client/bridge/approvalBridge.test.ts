/**
 * Unit tests — ui/bridge/approval.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
