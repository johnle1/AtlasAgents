/**
 * Unit tests — client ui/footer/buildFooterLine.ts
 *
 * Pure footer formatter: cwd · branch · model · mode · remaining context %.
 * No Ink — truncation and the `—` placeholder are the whole contract.
 *
 * Category checklist:
 * - Normal: all fields present, remaining % rendered
 * - Boundary: null context → `—`; missing branch omitted; narrow width truncates
 * - Error: non-finite / empty model still produces a usable line
 */

import { describe, expect, it } from "vitest";
import {
  buildFooterLine,
  remainingContextPct,
} from "../../../../packages/client/src/ui/footer/buildFooterLine.js";

describe("remainingContextPct", () => {
  it("returns the unused fraction as a percentage (normal)", () => {
    expect(remainingContextPct(2500, 10_000)).toBe(75);
  });

  it("clamps to 0 when usedTokens >= window (boundary)", () => {
    expect(remainingContextPct(10_000, 10_000)).toBe(0);
    expect(remainingContextPct(12_000, 10_000)).toBe(0);
  });

  it("clamps to 100 when usedTokens is 0 (boundary)", () => {
    expect(remainingContextPct(0, 10_000)).toBe(100);
  });

  it("returns 0 for a non-positive window (error)", () => {
    expect(remainingContextPct(10, 0)).toBe(0);
    expect(remainingContextPct(10, -1)).toBe(0);
  });
});

describe("buildFooterLine", () => {
  it("joins cwd, branch, model, mode, and remaining % (normal)", () => {
    expect(
      buildFooterLine({
        cwd: "~/src",
        branch: "main",
        model: "gemma3:12b",
        approvalMode: "default",
        contextPct: 75,
        width: 80,
      }),
    ).toBe("~/src · main · gemma3:12b · default · 75%");
  });

  it("renders — when contextPct is null (boundary)", () => {
    expect(
      buildFooterLine({
        cwd: "~/src",
        branch: "main",
        model: "gemma3:12b",
        approvalMode: "default",
        contextPct: null,
        width: 80,
      }),
    ).toBe("~/src · main · gemma3:12b · default · —");
  });

  it("omits the branch segment when branch is null (boundary)", () => {
    expect(
      buildFooterLine({
        cwd: "~/src",
        branch: null,
        model: "gemma3:12b",
        approvalMode: "plan",
        contextPct: 40,
        width: 80,
      }),
    ).toBe("~/src · gemma3:12b · ⏸ Plan · 40%");
  });

  it("renders Accept Edits and BYPASS labels with icons (normal)", () => {
    expect(
      buildFooterLine({
        cwd: "~",
        branch: null,
        model: "m",
        approvalMode: "accept_edits",
        contextPct: null,
        width: 80,
      }),
    ).toContain("⏵ Accept Edits");
    expect(
      buildFooterLine({
        cwd: "~",
        branch: null,
        model: "m",
        approvalMode: "bypass",
        contextPct: null,
        width: 80,
      }),
    ).toContain("⚠ BYPASS");
  });

  it("truncates with an ellipsis when the terminal is narrower than the line (boundary)", () => {
    const line = buildFooterLine({
      cwd: "~/very/long/path/to/project",
      branch: "feature/long-branch-name",
      model: "gemma3:27b",
      approvalMode: "accept_edits",
      contextPct: 12,
      width: 24,
    });
    expect(line.length).toBeLessThanOrEqual(24);
    expect(line.endsWith("…")).toBe(true);
  });

  it("still renders a line when model is empty (error)", () => {
    const line = buildFooterLine({
      cwd: "~",
      branch: null,
      model: "",
      approvalMode: "default",
      contextPct: null,
      width: 40,
    });
    expect(line).toContain("~");
    expect(line).toContain("—");
  });
});
