/**
 * Pure horizontal-option-bar keymap and windowing logic.
 *
 * @remarks
 * Extracted from the Ink render tree (mirrors {@link "./approvalKeymap.js"}'s
 * split of pure key→action logic from `ApprovalMenu`) so left/right/Enter/Esc
 * handling and the scroll window can be unit-tested without rendering
 * anything. Shared by both the `/model` and `/effort` pickers via
 * `OptionBarPrompt` in `PromptOverlay.tsx`.
 */

/** Ink `useInput` key flags this keymap reads. */
export type OptionBarKeyInformation = {
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
};

/**
 * Result of mapping a keystroke onto the option bar.
 *
 * - `noop` — ignore the key
 * - `move` — highlight a new index (clamped, no wraparound)
 * - `confirm` — resolve with the currently-highlighted index (Enter)
 * - `dismiss` — Esc; caller resolves with no change
 */
export type OptionBarKeyAction =
  | { type: "noop" }
  | { type: "move"; index: number }
  | { type: "confirm"; index: number }
  | { type: "dismiss" };

/**
 * Maps a keystroke to an option-bar action.
 *
 * @param key - Arrow / Enter / Esc flags from Ink's `useInput`.
 * @param selectedIndex - Currently highlighted option.
 * @param optionCount - Total number of options.
 * @returns The action the bar should take.
 *
 * @example
 * ```ts
 * resolveOptionBarKey({ rightArrow: true }, 1, 5);
 * // { type: "move", index: 2 }
 * ```
 */
export const resolveOptionBarKey = (
  key: OptionBarKeyInformation,
  selectedIndex: number,
  optionCount: number,
): OptionBarKeyAction => {
  if (key.escape) {
    return { type: "dismiss" };
  }

  if (key.leftArrow) {
    return { type: "move", index: Math.max(0, selectedIndex - 1) };
  }

  if (key.rightArrow) {
    return {
      type: "move",
      index: Math.min(optionCount - 1, selectedIndex + 1),
    };
  }

  if (key.return) {
    return { type: "confirm", index: selectedIndex };
  }

  return { type: "noop" };
};

/** A slice of option indices to actually render, plus whether more exist off-screen. */
export type OptionBarWindow = {
  /** Indices into the full options array, in display order. */
  indices: number[];
  hasMore: { left: boolean; right: boolean };
};

/**
 * Picks the slice of option indices to render around `selectedIndex`, so a
 * long list (e.g. `/model` across several providers) doesn't overflow
 * terminal width the way a short, fixed list (e.g. `/effort`'s 5 levels)
 * never needs to.
 *
 * @param selectedIndex - Currently highlighted option (0-based).
 * @param optionCount - Total number of options.
 * @param windowSize - Max options to show at once.
 * @returns The visible indices (length `min(windowSize, optionCount)`,
 *   centered on `selectedIndex` where possible) and which edges are
 *   truncated.
 *
 * @example
 * ```ts
 * computeVisibleWindow(0, 3, 5);
 * // { indices: [0, 1, 2], hasMore: { left: false, right: false } }
 *
 * computeVisibleWindow(7, 20, 5);
 * // { indices: [5, 6, 7, 8, 9], hasMore: { left: true, right: true } }
 * ```
 */
export const computeVisibleWindow = (
  selectedIndex: number,
  optionCount: number,
  windowSize: number,
): OptionBarWindow => {
  if (optionCount <= windowSize) {
    return {
      indices: Array.from({ length: optionCount }, (_, i) => i),
      hasMore: { left: false, right: false },
    };
  }

  const unclampedStart = selectedIndex - Math.floor(windowSize / 2);
  const start = Math.max(0, Math.min(unclampedStart, optionCount - windowSize));
  const indices = Array.from({ length: windowSize }, (_, i) => start + i);

  return {
    indices,
    hasMore: {
      left: start > 0,
      right: start + windowSize < optionCount,
    },
  };
};

/** Separator rendered between adjacent visible option labels. */
export const OPTION_BAR_SEPARATOR = " · ";

/** Prefix rendered before the first visible label when the window is truncated on the left. */
export const OPTION_BAR_LEFT_EDGE = "‹ ";

/**
 * Column (0-based) of the single centered pointer under the selected label
 * in the flattened text row `OptionBarPrompt` renders.
 *
 * @remarks
 * Walks the visible labels up to `selectedPosition`, summing each label's
 * width plus one {@link OPTION_BAR_SEPARATOR}, plus
 * {@link OPTION_BAR_LEFT_EDGE}'s width when `hasLeftEdge` is true, to find
 * the selected label's starting column — then adds half its own width so
 * the pointer sits at its midpoint rather than its start. Exact only
 * because every rendered segment is a plain fixed-width string with no
 * wrapping, which holds given the option bar's small window size and short
 * labels.
 *
 * @param labels - Visible option labels, in render order (already windowed).
 * @param selectedPosition - Index into `labels` (not the full option list)
 *   of the highlighted one.
 * @param hasLeftEdge - Whether an {@link OPTION_BAR_LEFT_EDGE} prefix precedes the row.
 * @returns The column to place the pointer character at.
 *
 * @example
 * ```ts
 * computeOptionBarPointerOffset(["low", "medium", "high"], 1, false);
 * // "low · " is 6 chars, "medium" is 6 chars wide → 6 + 3 = 9
 * ```
 */
export const computeOptionBarPointerOffset = (
  labels: string[],
  selectedPosition: number,
  hasLeftEdge: boolean,
): number => {
  let column = hasLeftEdge ? OPTION_BAR_LEFT_EDGE.length : 0;
  for (let i = 0; i < selectedPosition; i++) {
    column += labels[i]!.length + OPTION_BAR_SEPARATOR.length;
  }
  const selectedLabel = labels[selectedPosition] ?? "";
  return column + Math.floor(selectedLabel.length / 2);
};

/** Default Ink highlight when no per-option palette is supplied (`/model`). */
export const DEFAULT_OPTION_BAR_HIGHLIGHT = "cyan";

/**
 * Ink color for one option label — only the highlighted index is tinted.
 *
 * @param optionColors - Optional palette aligned with the full options list.
 * @param optionIndex - Index being rendered.
 * @param selectedIndex - Currently highlighted index.
 * @returns Ink color name/hex for the selected label, or `undefined` when unselected.
 */
export const optionBarLabelColor = (
  optionColors: string[] | undefined,
  optionIndex: number,
  selectedIndex: number,
): string | undefined => {
  if (optionIndex !== selectedIndex) {
    return undefined;
  }
  if (optionColors && optionColors[optionIndex]) {
    return optionColors[optionIndex];
  }
  return DEFAULT_OPTION_BAR_HIGHLIGHT;
};
