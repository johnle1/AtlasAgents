/**
 * <Summary>
 * What it does:
 *   One line-level change segment from jsdiff (added, removed, or unchanged).
 *
 * Used by:
 *   - formatDiff — consumes chunk list.
 *
 * Produced by:
 *   - computeDiff.
 * </Summary>
 */
export type DiffChunk = {
  value: string;
  added?: boolean;
  removed?: boolean;
};
export type DisplayRow = {
  kind: "added" | "removed" | "equal";
  text: string;
  lineNum: number;
};
