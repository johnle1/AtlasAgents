/**
 * Unit tests — client ui/approvalFlow.ts
 *
 * @remarks
 * `requestApprovalWithFeedback` is the guard against the "Revise" option
 * (value `"edit"`) being treated as a truthy boolean by naive
 * `(await requestApproval(...)) as boolean` casts. These tests pin down
 * that every decision resolves to a safe `{ approved, feedback? }` shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequestApproval, mockRequestPrompt, mockNotifyUser } = vi.hoisted(() => ({
  mockRequestApproval: vi.fn(),
  mockRequestPrompt: vi.fn(),
  mockNotifyUser: vi.fn(),
}));

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
  requestApproval: mockRequestApproval,
  requestPrompt: mockRequestPrompt,
}));

vi.mock("../../../../packages/client/src/ui/notify.js", () => ({
  notifyUser: mockNotifyUser,
}));

import { requestApprovalWithFeedback } from "../../../../packages/client/src/ui/approvalFlow.js";
import { dismissValueFor } from "../../../../packages/client/src/ui/components/approvalKeymap.js";

const request = { type: "runSkip", command: "rm -rf build" } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requestApprovalWithFeedback", () => {
  it("resolves approved: true when the user picks the affirmative option", async () => {
    mockRequestApproval.mockResolvedValue(true);
    const outcome = await requestApprovalWithFeedback(request, "revise?");
    expect(outcome).toEqual({ approved: true });
    expect(mockRequestPrompt).not.toHaveBeenCalled();
  });

  it("resolves approved: false with no feedback on a plain decline", async () => {
    mockRequestApproval.mockResolvedValue(false);
    const outcome = await requestApprovalWithFeedback(request, "revise?");
    expect(outcome).toEqual({ approved: false });
    expect(mockRequestPrompt).not.toHaveBeenCalled();
  });

  it("prompts for free text and returns it as feedback when the user picks Revise", async () => {
    mockRequestApproval.mockResolvedValue("edit");
    mockRequestPrompt.mockResolvedValue("use pnpm instead of npm");
    const outcome = await requestApprovalWithFeedback(request, "What should change?");
    expect(mockRequestPrompt).toHaveBeenCalledWith({
      type: "line",
      prompt: "What should change?",
    });
    expect(outcome).toEqual({ approved: false, feedback: "use pnpm instead of npm" });
  });

  it("trims whitespace from the feedback text", async () => {
    mockRequestApproval.mockResolvedValue("edit");
    mockRequestPrompt.mockResolvedValue("  add error handling  ");
    const outcome = await requestApprovalWithFeedback(request, "revise?");
    expect(outcome).toEqual({ approved: false, feedback: "add error handling" });
  });

  it("omits feedback entirely when Revise is picked but nothing is typed", async () => {
    mockRequestApproval.mockResolvedValue("edit");
    mockRequestPrompt.mockResolvedValue("   ");
    const outcome = await requestApprovalWithFeedback(request, "revise?");
    expect(outcome).toEqual({ approved: false });
  });

  it("never resolves approved: true for a Revise decision, even with feedback", async () => {
    mockRequestApproval.mockResolvedValue("edit");
    mockRequestPrompt.mockResolvedValue("something");
    const outcome = await requestApprovalWithFeedback(request, "revise?");
    expect(outcome.approved).toBe(false);
  });
});

describe("Esc dismiss defaults match cancelPendingApprovals", () => {
  it("dismissing a keepUndo request resolves false (normal)", () => {
    expect(dismissValueFor("keepUndo")).toBe(false);
  });

  it("dismissing a planReview request resolves skip (normal)", () => {
    expect(dismissValueFor("planReview")).toBe("skip");
  });
});

describe("requestApproval notification (via real approval bridge)", () => {
  it("fires exactly one Action required notification when UI is active (normal)", async () => {
    const { setInkUIActiveValue, setPendingApprovalEntry, setBridgeHooks } =
      await import("../../../../packages/client/src/ui/bridge/state.js");
    const { requestApproval, resolveApproval } = await import(
      "../../../../packages/client/src/ui/bridge/approval.js"
    );
    setBridgeHooks({});
    setPendingApprovalEntry(null);
    setInkUIActiveValue(true);
    mockNotifyUser.mockClear();

    const pending = requestApproval({ type: "keepUndo", contextLabel: "a.ts" });
    expect(mockNotifyUser).toHaveBeenCalledOnce();
    expect(mockNotifyUser).toHaveBeenCalledWith("Action required");
    resolveApproval(false);
    await pending;
  });
});
