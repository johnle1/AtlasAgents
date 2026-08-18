/**
 * Unit tests — client ui/components/approvalKeymap.ts
 *
 * Pure keymap extracted from ApprovalMenu so Esc / digit hotkeys can be
 * tested without rendering an Ink tree.
 *
 * Category checklist:
 * - Normal: Enter confirms the highlighted option; digits 1–3 jump+confirm
 * - Boundary: up/down clamp; out-of-range digit is a no-op
 * - Error: Esc dismisses with the same defaults as cancelPendingApprovals
 *   (planReview → "skip", keepUndo/runSkip → false)
 */

import { describe, expect, it } from "vitest";
import {
  buildOptions,
  dismissValueFor,
  resolveApprovalKey,
} from "../../../../packages/client/src/ui/components/approvalKeymap.js";
import type { ApprovalRequest } from "../../../../packages/client/src/ui/types.js";

const emptyKey = {
  upArrow: false,
  downArrow: false,
  return: false,
  escape: false,
};

const planReview: ApprovalRequest = {
  type: "planReview",
  task: "refactor",
  stepCount: 2,
  agentCount: 1,
  execution: "sequential",
  modeLabel: null,
};

const runSkip: ApprovalRequest = { type: "runSkip", command: "rm -rf build" };
const keepUndo: ApprovalRequest = { type: "keepUndo", contextLabel: "a.ts" };

describe("buildOptions", () => {
  it("returns Implement / Skip / Revise for planReview (normal)", () => {
    const options = buildOptions(planReview);
    expect(options.map((option) => option.value)).toEqual([
      "implement",
      "skip",
      "edit",
    ]);
  });

  it("returns Run / Skip / Revise / Always allow for runSkip (normal)", () => {
    const options = buildOptions(runSkip);
    expect(options.map((option) => option.value)).toEqual([
      true,
      false,
      "edit",
      "always",
    ]);
  });

  it("returns Keep / Undo / Revise / Always allow for keepUndo (normal)", () => {
    const options = buildOptions(keepUndo);
    expect(options.map((option) => option.value)).toEqual([
      true,
      false,
      "edit",
      "always",
    ]);
  });

  it("does not include Always allow for planReview (boundary)", () => {
    const options = buildOptions(planReview);
    expect(options.map((option) => option.value)).toEqual([
      "implement",
      "skip",
      "edit",
    ]);
    expect(options.some((option) => option.value === "always")).toBe(false);
  });
});

describe("dismissValueFor — Esc / disconnect parity", () => {
  it("returns skip for planReview (normal)", () => {
    expect(dismissValueFor("planReview")).toBe("skip");
  });

  it("returns false for keepUndo and runSkip (normal)", () => {
    expect(dismissValueFor("keepUndo")).toBe(false);
    expect(dismissValueFor("runSkip")).toBe(false);
  });
});

describe("resolveApprovalKey", () => {
  const options = buildOptions(runSkip);

  it("moves up and down with clamping (boundary)", () => {
    expect(
      resolveApprovalKey("", { ...emptyKey, upArrow: true }, options, 0, "runSkip"),
    ).toEqual({ type: "move", index: 0 });

    expect(
      resolveApprovalKey("", { ...emptyKey, upArrow: true }, options, 2, "runSkip"),
    ).toEqual({ type: "move", index: 1 });

    expect(
      resolveApprovalKey(
        "",
        { ...emptyKey, downArrow: true },
        options,
        options.length - 1,
        "runSkip",
      ),
    ).toEqual({ type: "move", index: options.length - 1 });

    expect(
      resolveApprovalKey(
        "",
        { ...emptyKey, downArrow: true },
        options,
        0,
        "runSkip",
      ),
    ).toEqual({ type: "move", index: 1 });
  });

  it("confirms the highlighted option on Enter (normal)", () => {
    expect(
      resolveApprovalKey("", { ...emptyKey, return: true }, options, 0, "runSkip"),
    ).toEqual({ type: "confirm", value: true });

    expect(
      resolveApprovalKey("", { ...emptyKey, return: true }, options, 1, "runSkip"),
    ).toEqual({ type: "confirm", value: false });
  });

  it("digits 1–3 jump+confirm that option immediately (normal)", () => {
    expect(resolveApprovalKey("1", emptyKey, options, 0, "runSkip")).toEqual({
      type: "confirm",
      value: true,
    });
    expect(resolveApprovalKey("2", emptyKey, options, 0, "runSkip")).toEqual({
      type: "confirm",
      value: false,
    });
    expect(resolveApprovalKey("3", emptyKey, options, 0, "runSkip")).toEqual({
      type: "confirm",
      value: "edit",
    });
  });

  it("digit 4 confirms Always allow for runSkip (normal)", () => {
    expect(resolveApprovalKey("4", emptyKey, options, 0, "runSkip")).toEqual({
      type: "confirm",
      value: "always",
    });
  });

  it("out-of-range digits are a no-op (boundary)", () => {
    expect(resolveApprovalKey("0", emptyKey, options, 1, "runSkip")).toEqual({
      type: "noop",
    });
    expect(resolveApprovalKey("5", emptyKey, options, 1, "runSkip")).toEqual({
      type: "noop",
    });
  });

  it("Esc dismisses planReview as skip (error — same as disconnect)", () => {
    const planOptions = buildOptions(planReview);
    expect(
      resolveApprovalKey(
        "",
        { ...emptyKey, escape: true },
        planOptions,
        0,
        "planReview",
      ),
    ).toEqual({ type: "dismiss", value: "skip" });
  });

  it("Esc dismisses keepUndo and runSkip as false (error — same as disconnect)", () => {
    expect(
      resolveApprovalKey(
        "",
        { ...emptyKey, escape: true },
        options,
        0,
        "runSkip",
      ),
    ).toEqual({ type: "dismiss", value: false });

    expect(
      resolveApprovalKey(
        "",
        { ...emptyKey, escape: true },
        buildOptions(keepUndo),
        0,
        "keepUndo",
      ),
    ).toEqual({ type: "dismiss", value: false });
  });
});
