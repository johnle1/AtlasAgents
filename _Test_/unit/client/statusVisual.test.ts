/**
 * Unit tests — statusVisual.ts
 *
 * Tests every exported resolver in the status visual module:
 *   - isWorkingStage          — pure boolean predicate
 *   - resolveWorkerVisual     — maps stage + icon → glyph/color/animate
 *   - resolveQueueVisual      — maps blocked flag → glyph/dim
 *   - resolveTaskLifecycleVisual — maps TaskLifecycleState → glyph/color/animate
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Mocks                  : config.loadConfig and terminalEnv helpers are mocked
 *   so that `shouldAnimateWorker()` returns a DETERMINISTIC value without
 *   touching the filesystem or environment variables.
 *
 * Category checklist:
 *   ✅ Normal  — every documented stage/icon combination
 *   ✅ Boundary — undefined stage, missing icon, pulse index wrapping
 *   ✅ Error   — non-existent stage strings (TypeScript prevents these at
 *                compile time, so we focus on runtime boundary values)
 *
 * Mock strategy
 * -------------
 * `shouldAnimateWorker()` internally calls:
 *   1. loadConfig()           — reads ~/.loopycode/config.json (side effect)
 *   2. isScreenReaderLikely() — checks TERM / CI env vars
 *
 * We mock both so animation state is predictable:
 *   showSpinner = true  + isScreenReaderLikely = false  → animate = true
 *
 * This means tests for working stages expect animate: true and a specific
 * frame character from pulse index 0 ("◉").
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

// ── Mocks must be declared BEFORE any imports that transitively
//    load the mocked modules (Vitest hoists vi.mock() calls). ──

vi.mock("../../../packages/client/src/config/index", () => ({
  /**
   * Stub config with animation enabled.
   * Only the `ui.showSpinner` field is used by shouldAnimateWorker().
   */
  loadConfig: vi.fn(() => ({
    ui: { showSpinner: true },
  })),
}));

vi.mock("../../../packages/client/src/ui/terminalEnv", () => ({
  /**
   * Pretend we are NOT inside tmux → use the standard 4-frame sequence.
   */
  inTmux: vi.fn(() => false),
  /**
   * Pretend we are NOT a screen reader or CI → animation enabled.
   */
  isScreenReaderLikely: vi.fn(() => false),
}));

import {
  isWorkingStage,
  resolveQueueVisual,
  resolveTaskLifecycleVisual,
  resolveWorkerVisual,
  WORKING_FRAMES,
} from "../../../packages/client/src/ui/statusVisual";

// ---------------------------------------------------------------------------
// isWorkingStage
// ---------------------------------------------------------------------------

describe("isWorkingStage — normal cases", () => {
  it("returns true for 'running' (normal)", () => {
    expect(isWorkingStage("running")).toBe(true);
  });

  it("returns true for 'reading' (normal)", () => {
    expect(isWorkingStage("reading")).toBe(true);
  });

  it("returns true for 'writing' (normal)", () => {
    expect(isWorkingStage("writing")).toBe(true);
  });

  it("returns true for 'thinking' (normal)", () => {
    expect(isWorkingStage("thinking")).toBe(true);
  });

  it("returns true for 'searching' (normal)", () => {
    expect(isWorkingStage("searching")).toBe(true);
  });
});

describe("isWorkingStage — boundary / non-working stages", () => {
  it("returns false for 'waiting' (boundary)", () => {
    expect(isWorkingStage("waiting")).toBe(false);
  });

  it("returns false for 'done' (boundary)", () => {
    expect(isWorkingStage("done")).toBe(false);
  });

  it("returns false for 'escalating' (boundary — not in the working set)", () => {
    expect(isWorkingStage("escalating")).toBe(false);
  });

  it("returns false for undefined stage (boundary — missing stage)", () => {
    expect(isWorkingStage(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkerVisual — agent path (isAgent = true)
// ---------------------------------------------------------------------------

describe("resolveWorkerVisual — agent (isAgent = true)", () => {
  it("returns green for ✓ icon (normal — done)", () => {
    const visual = resolveWorkerVisual(undefined, "✓", 0, true);
    expect(visual).toEqual({ glyph: "✓", color: "green" });
  });

  it("returns yellow for ⚠ icon (normal — warning)", () => {
    const visual = resolveWorkerVisual(undefined, "⚠", 0, true);
    expect(visual).toEqual({ glyph: "⚠", color: "yellow" });
  });

  it("returns the raw icon with no color for ◌ (normal — in-progress)", () => {
    // ◌ means actively thinking but the agent visual just echoes the icon
    const visual = resolveWorkerVisual("drafting", "◌", 0, true);
    expect(visual.glyph).toBe("◌");
    expect(visual.color).toBeUndefined();
  });

  it("ignores the stage for agent — only the icon matters (boundary)", () => {
    // Even a working stage should be treated purely by icon when isAgent=true
    const visual = resolveWorkerVisual("running", "✓", 0, true);
    expect(visual).toEqual({ glyph: "✓", color: "green" });
  });
});

// ---------------------------------------------------------------------------
// resolveWorkerVisual — Agent path (isAgent = false)
// ---------------------------------------------------------------------------

describe("resolveWorkerVisual — agent (isAgent = false)", () => {
  it("returns dimmed ◦ for 'waiting' stage (normal)", () => {
    const visual = resolveWorkerVisual("waiting", "◌", 0, false);
    expect(visual).toEqual({ glyph: "◦", dim: true });
  });

  it("returns green ✓ for 'done' stage (normal)", () => {
    const visual = resolveWorkerVisual("done", "✓", 0, false);
    expect(visual).toEqual({ glyph: "✓", color: "green" });
  });

  it("returns yellow ⚠ for 'escalating' stage (normal)", () => {
    const visual = resolveWorkerVisual("escalating", "◌", 0, false);
    expect(visual).toEqual({ glyph: "⚠", color: "yellow" });
  });

  it("returns yellow ⚠ when frameIcon is ⚠ regardless of stage (boundary)", () => {
    // The ⚠ icon takes precedence even if stage is 'running'
    const visual = resolveWorkerVisual("running", "⚠", 0, false);
    expect(visual).toEqual({ glyph: "⚠", color: "yellow" });
  });

  it("returns cyan animated frame for 'running' stage (normal — animation enabled)", () => {
    // With showSpinner=true and not screen reader → animate:true
    // pulse index 0 → frame 0 from WORKING_FRAMES ("◉")
    const visual = resolveWorkerVisual("running", "◌", 0, false);
    expect(visual).toEqual({
      glyph: WORKING_FRAMES[0],
      color: "cyan",
      animate: true,
    });
  });

  it("returns cyan animated frame for 'reading' stage (normal)", () => {
    const visual = resolveWorkerVisual("reading", "◌", 0, false);
    expect(visual.color).toBe("cyan");
    expect(visual.animate).toBe(true);
  });

  it("advances to the correct frame at pulse index 2 (boundary — frame cycling)", () => {
    // WORKING_FRAMES has 4 entries; index 2 % 4 = 2
    const visual = resolveWorkerVisual("running", "◌", 2, false);
    expect(visual.glyph).toBe(WORKING_FRAMES[2]);
  });

  it("wraps frame index correctly at pulse index 4 (boundary — modulo wrap)", () => {
    // Index 4 % 4 = 0 → same as first frame
    const visual = resolveWorkerVisual("running", "◌", 4, false);
    expect(visual.glyph).toBe(WORKING_FRAMES[0]);
  });

  it("returns dimmed frameIcon as fallback for unknown/unhandled stage (boundary)", () => {
    // 'retrying' is a valid SubagentStage but not in the working-stage set
    // and is not done/waiting/escalating → falls through to the default dimmed return
    const visual = resolveWorkerVisual("retrying", "◌", 0, false);
    expect(visual).toEqual({ glyph: "◌", dim: true });
  });
});

// ---------------------------------------------------------------------------
// resolveQueueVisual
// ---------------------------------------------------------------------------

describe("resolveQueueVisual", () => {
  it("returns dimmed □ when blocked = true (normal — task blocked)", () => {
    expect(resolveQueueVisual(true)).toEqual({ glyph: "□", dim: true });
  });

  it("returns cyan ○ when blocked = false (normal — queued but runnable)", () => {
    expect(resolveQueueVisual(false)).toEqual({ glyph: "○", color: "cyan" });
  });
});

// ---------------------------------------------------------------------------
// resolveTaskLifecycleVisual
// ---------------------------------------------------------------------------

describe("resolveTaskLifecycleVisual", () => {
  it("returns green ✓ for 'complete' state (normal)", () => {
    expect(resolveTaskLifecycleVisual("complete", 0)).toEqual({
      glyph: "✓",
      color: "green",
    });
  });

  it("returns cyan ○ for 'waiting' state (normal)", () => {
    // 'waiting' in lifecycle = queued but not yet assigned, shown as a plain circle
    expect(resolveTaskLifecycleVisual("waiting", 0)).toEqual({
      glyph: "○",
      color: "cyan",
    });
  });

  it("returns dimmed □ for 'blocked' state (normal)", () => {
    expect(resolveTaskLifecycleVisual("blocked", 0)).toEqual({
      glyph: "□",
      dim: true,
    });
  });

  it("returns red ✗ for 'failed' state (normal)", () => {
    expect(resolveTaskLifecycleVisual("failed", 0)).toEqual({
      glyph: "✗",
      color: "red",
    });
  });

  it("returns animated cyan frame for 'running' state at pulse 0 (normal)", () => {
    const visual = resolveTaskLifecycleVisual("running", 0);
    expect(visual).toEqual({
      glyph: WORKING_FRAMES[0],
      color: "cyan",
      animate: true,
    });
  });

  it("cycles to the correct frame for 'running' at pulse 3 (boundary — frame wrap)", () => {
    const visual = resolveTaskLifecycleVisual("running", 3);
    expect(visual.glyph).toBe(WORKING_FRAMES[3 % WORKING_FRAMES.length]);
  });
});
