/**
 * Unit tests — ui/bridge/approval.ts
 *
 * Covers the pending-approval queue, Esc/disconnect defaults, notifications,
 * session allowlist short-circuits, and approval-mode short-circuits
 * (`accept_edits` / `auto` / `bypass`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  sessionAllowlist,
  setSessionApprovalMode,
} from "../../../../packages/client/src/ui/bridge/allowlist.js";

beforeEach(() => {
  setBridgeHooks({});
  setInkUIActiveValue(false);
  setPendingApprovalEntry(null);
  sessionAllowlist.clear();
  setSessionApprovalMode("default");
  mockNotifyUser.mockClear();
});

afterEach(() => {
  sessionAllowlist.clear();
  setSessionApprovalMode("default");
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

describe("allowlist short-circuit (WS4)", () => {
  it("resolves a matching keepUndo immediately without notifying (normal)", async () => {
    setInkUIActiveValue(true);
    sessionAllowlist.add({ type: "keepUndo", path: "a.ts" });

    const result = await requestApproval({
      type: "keepUndo",
      contextLabel: "a.ts",
    });
    expect(result).toBe(true);
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("accept_edits auto-approves keepUndo without notifying (normal)", async () => {
    setInkUIActiveValue(true);
    setSessionApprovalMode("accept_edits");

    const result = await requestApproval({
      type: "keepUndo",
      contextLabel: "b.ts",
    });
    expect(result).toBe(true);
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });
});

describe("requestApproval mode short-circuits (WS-B)", () => {
  const keepUndo = { type: "keepUndo" as const, contextLabel: "c.ts" };
  const runSkip = { type: "runSkip" as const, command: "npm test" };
  const planReview = {
    type: "planReview" as const,
    task: "x",
    stepCount: 1,
    agentCount: 1,
    execution: "sequential" as const,
    modeLabel: null,
  };

  it("bypass auto-approves every request type without notifying (normal)", async () => {
    setInkUIActiveValue(true);
    setSessionApprovalMode("bypass");

    expect(await requestApproval(keepUndo)).toBe(true);
    expect(await requestApproval(runSkip)).toBe(true);
    // planReview resolves a PlanDecision — the server rejects boolean true.
    expect(await requestApproval(planReview)).toBe("implement");
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("auto auto-approves keepUndo without notifying (normal)", async () => {
    setInkUIActiveValue(true);
    setSessionApprovalMode("auto");

    expect(
      await requestApproval({ type: "keepUndo", contextLabel: "d.ts" }),
    ).toBe(true);
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("accept_edits still prompts runSkip (boundary)", async () => {
    setInkUIActiveValue(true);
    setSessionApprovalMode("accept_edits");

    const pending = requestApproval(runSkip);
    expect(mockNotifyUser).toHaveBeenCalledOnce();
    resolveApproval(false);
    expect(await pending).toBe(false);
  });

  it("auto still prompts runSkip — the command layer gates shell (boundary)", async () => {
    setInkUIActiveValue(true);
    setSessionApprovalMode("auto");

    const pending = requestApproval(runSkip);
    expect(mockNotifyUser).toHaveBeenCalledOnce();
    resolveApproval(true);
    expect(await pending).toBe(true);
  });

  it("auto auto-approves planReview with implement (normal)", async () => {
    setInkUIActiveValue(true);
    setSessionApprovalMode("auto");

    expect(await requestApproval(planReview)).toBe("implement");
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("accept_edits still prompts planReview (boundary)", async () => {
    setInkUIActiveValue(true);
    setSessionApprovalMode("accept_edits");

    const pending = requestApproval(planReview);
    expect(mockNotifyUser).toHaveBeenCalledOnce();
    resolveApproval("skip");
    expect(await pending).toBe("skip");
  });
});
