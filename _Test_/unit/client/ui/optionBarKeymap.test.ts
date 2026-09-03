/**
 * Unit tests — client ui/components/optionBarKeymap.ts
 *
 * Pure keymap + windowing logic behind the shared horizontal option bar
 * (`/model` and `/effort`), extracted so left/right/Enter/Esc handling and
 * the scroll window can be tested without rendering an Ink tree.
 *
 * Category checklist:
 * - Normal: right/left moves the highlight; Enter confirms; a short list
 *   (e.g. /effort's 5 levels) needs no windowing at all
 * - Boundary: left/right clamp at both ends (no wraparound); a windowed
 *   list's hasMore flags flip correctly at each edge and in the middle
 * - Error: Esc dismisses regardless of position
 */

import { describe, expect, it } from "vitest";
import {
  computeOptionBarPointerOffset,
  computeVisibleWindow,
  DEFAULT_OPTION_BAR_HIGHLIGHT,
  optionBarLabelColor,
  resolveOptionBarKey,
} from "../../../../packages/client/src/ui/components/optionBarKeymap.js";

const emptyKey = {
  leftArrow: false,
  rightArrow: false,
  return: false,
  escape: false,
};

describe("resolveOptionBarKey", () => {
  it("moves right and left (normal)", () => {
    expect(
      resolveOptionBarKey({ ...emptyKey, rightArrow: true }, 1, 5),
    ).toEqual({ type: "move", index: 2 });

    expect(
      resolveOptionBarKey({ ...emptyKey, leftArrow: true }, 1, 5),
    ).toEqual({ type: "move", index: 0 });
  });

  it("clamps at both ends without wrapping (boundary)", () => {
    expect(
      resolveOptionBarKey({ ...emptyKey, leftArrow: true }, 0, 5),
    ).toEqual({ type: "move", index: 0 });

    expect(
      resolveOptionBarKey({ ...emptyKey, rightArrow: true }, 4, 5),
    ).toEqual({ type: "move", index: 4 });
  });

  it("confirms the highlighted index on Enter (normal)", () => {
    expect(resolveOptionBarKey({ ...emptyKey, return: true }, 2, 5)).toEqual({
      type: "confirm",
      index: 2,
    });
  });

  it("dismisses on Esc regardless of position (error)", () => {
    expect(resolveOptionBarKey({ ...emptyKey, escape: true }, 3, 5)).toEqual({
      type: "dismiss",
    });
  });

  it("is a no-op for unrecognized keys (boundary)", () => {
    expect(resolveOptionBarKey(emptyKey, 1, 5)).toEqual({ type: "noop" });
  });
});

describe("computeVisibleWindow", () => {
  it("shows every option with no truncation when the list already fits (normal)", () => {
    expect(computeVisibleWindow(0, 3, 5)).toEqual({
      indices: [0, 1, 2],
      hasMore: { left: false, right: false },
    });
  });

  it("centers the window on the selected index deep in a long list (normal)", () => {
    expect(computeVisibleWindow(10, 20, 5)).toEqual({
      indices: [8, 9, 10, 11, 12],
      hasMore: { left: true, right: true },
    });
  });

  it("clamps the window at the start — no left truncation once selection is near 0 (boundary)", () => {
    expect(computeVisibleWindow(0, 20, 5)).toEqual({
      indices: [0, 1, 2, 3, 4],
      hasMore: { left: false, right: true },
    });
    expect(computeVisibleWindow(1, 20, 5)).toEqual({
      indices: [0, 1, 2, 3, 4],
      hasMore: { left: false, right: true },
    });
  });

  it("clamps the window at the end — no right truncation once selection is near the last index (boundary)", () => {
    expect(computeVisibleWindow(19, 20, 5)).toEqual({
      indices: [15, 16, 17, 18, 19],
      hasMore: { left: true, right: false },
    });
    expect(computeVisibleWindow(18, 20, 5)).toEqual({
      indices: [15, 16, 17, 18, 19],
      hasMore: { left: true, right: false },
    });
  });
});

describe("computeOptionBarPointerOffset", () => {
  it("centers under the first label, no preceding options (normal)", () => {
    // "low" is 3 chars wide → floor(3/2) = 1.
    expect(computeOptionBarPointerOffset(["low"], 0, false)).toBe(1);
  });

  it("accounts for each preceding label plus its separator (normal)", () => {
    const labels = ["low", "medium", "high"];
    // "low · " is 6 chars, "medium" is 6 wide → 6 + 3 = 9.
    expect(computeOptionBarPointerOffset(labels, 1, false)).toBe(9);
    // "low · medium · " is 15 chars, "high" is 4 wide → 15 + 2 = 17.
    expect(computeOptionBarPointerOffset(labels, 2, false)).toBe(17);
  });

  it("shifts by the left-edge prefix's width when the window is truncated (boundary)", () => {
    // "‹ " is 2 chars, "medium" is 6 wide → 2 + 3 = 5.
    expect(computeOptionBarPointerOffset(["medium", "high"], 0, true)).toBe(5);
  });

  it("centers correctly for a single-character label (boundary)", () => {
    // "a" is 1 char wide → floor(1/2) = 0.
    expect(computeOptionBarPointerOffset(["a", "bb"], 0, false)).toBe(0);
    // "a · " is 4 chars, "bb" is 2 wide → 4 + 1 = 5.
    expect(computeOptionBarPointerOffset(["a", "bb"], 1, false)).toBe(5);
  });
});

describe("optionBarLabelColor", () => {
  const effortColors = ["blue", "green", "yellow", "#ff8800", "magenta"];

  it("returns undefined for unselected labels when a palette is supplied", () => {
    expect(optionBarLabelColor(effortColors, 0, 2)).toBeUndefined();
    expect(optionBarLabelColor(effortColors, 4, 2)).toBeUndefined();
  });

  it("returns the palette entry only for the highlighted index", () => {
    expect(optionBarLabelColor(effortColors, 2, 2)).toBe("yellow");
    expect(optionBarLabelColor(effortColors, 3, 3)).toBe("#ff8800");
  });

  it("falls back to cyan for the highlighted label when no palette is supplied", () => {
    expect(optionBarLabelColor(undefined, 1, 1)).toBe(
      DEFAULT_OPTION_BAR_HIGHLIGHT,
    );
    expect(optionBarLabelColor(undefined, 0, 0)).toBe("cyan");
  });
});
