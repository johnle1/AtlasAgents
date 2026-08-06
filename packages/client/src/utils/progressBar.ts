/**
 * Shared block-character progress bar rendering.
 *
 * @remarks
 * Used by the subagent task board header (`ui/taskBoardLayout.ts`) and the
 * model-pull download progress line (`renderer/modelOutput.ts`) so the
 * CLI's progress indicators share one implementation and stay visually
 * consistent.
 */

/** Filled-segment block character. */
const FILLED_CHAR = "█";

/** Empty-segment block character. */
const EMPTY_CHAR = "░";

/**
 * Renders a fixed-width block-character progress bar.
 *
 * @param ratio - Fraction complete. Clamped to `[0, 1]` internally, so
 *   callers never need to pre-clamp — and can never trigger a negative
 *   `String.prototype.repeat` count (a `RangeError`) by passing a ratio
 *   derived from `completed > total`.
 * @param width - Total number of block characters in the bar.
 * @returns A `width`-character string of filled (`█`) followed by empty
 *   (`░`) blocks.
 *
 * @example
 * ```ts
 * renderProgressBar(0.5, 10); // "█████░░░░░"
 * ```
 */
export const renderProgressBar = (ratio: number, width: number): string => {
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  const filledWidth = Math.floor(clampedRatio * width);
  return (
    FILLED_CHAR.repeat(filledWidth) + EMPTY_CHAR.repeat(width - filledWidth)
  );
};
