/**
 * Line-by-line diff rendering engine.
 *
 * @remarks
 * This module transforms raw line diffs (from the `diff` library) into formatted
 * display suitable for both terminals (with ANSI colors) and plain-text output.
 * It implements two key insights:
 *
 * 1. **Context-aware rendering:** Only shows changed lines plus a small surrounding
 *    context (3 lines before/after), keeping diffs focused and readable.
 * 2. **Format separation:** Splits output into two paths:
 *    - {@link getDiffDisplayLines} for structured data (used by Shiki/web renderers)
 *    - {@link formatDiffPlain} for ANSI-colored terminal output
 *
 * **Pipeline:**
 * `computeDiff` (compute chunks) → `buildDisplayRows` (add line numbers) →
 * `buildNearChangeIndices` (identify context) → `renderDiffLines` or
 * `getDiffDisplayLines` (format for output).
 *
 * @example
 * ```ts
 * const originalText = "line1\nline2\nline3\n";
 * const newText = "line1\nmodified\nline3\n";
 *
 * const chunks = computeDiff(originalText, newText);
 * const displayLines = getDiffDisplayLines(chunks);
 * // [{kind: "equal", lineNum: 1, text: "line1"},
 * //  {kind: "removed", lineNum: 2, text: "line2"},
 * //  {kind: "added", lineNum: 2, text: "modified"},
 * //  {kind: "equal", lineNum: 3, text: "line3"}]
 * ```
 */

import { diffLines } from "diff";
import pc from "picocolors";
import type { DiffChunk, DisplayRow } from "./types.js";

/**
 * Splits a diff chunk by newlines and removes the trailing empty element.
 *
 * @remarks
 * The `diff` library appends a trailing newline to chunk values. Since we split
 * on `\n`, this creates an empty string at the end of the array that we need to
 * discard for clean line arrays.
 *
 * @param chunkValue - Raw chunk text from diffLines output (e.g., "line1\nline2\n").
 * @returns Array of individual lines without trailing empty string.
 *
 * @example
 * ```ts
 * splitChunkLines("line1\nline2\n"); // ["line1", "line2"]
 * splitChunkLines("single"); // ["single"]
 * ```
 */
const splitChunkLines = (chunkValue: string): string[] => {
  const chunkLines = chunkValue.split("\n");
  if (chunkLines.length > 0 && chunkLines[chunkLines.length - 1] === "") {
    chunkLines.pop();
  }
  return chunkLines;
};

/**
 * Converts diff chunks into display rows with line numbers.
 *
 * @remarks
 * Associates each line with its number in the "new file" for added/equal lines,
 * or "old file" for removed lines. This mirrors how diff viewers show line numbers:
 * added content shows where it appears in the new file, removed content shows where
 * it came from in the old file.
 *
 * **Numbering strategy:**
 * - `added` and `equal` rows: numbered from the new file (advance `currentNewFileLineNum`)
 * - `removed` rows: numbered from the old file (advance `currentOldFileLineNum`)
 * - Only `equal` rows advance both counters (they exist in both files)
 *
 * @param chunks - Raw diff chunks from `diffLines()`.
 * @returns Display rows with kind ("added" | "removed" | "equal"), text, and lineNum.
 *
 * @example
 * ```ts
 * const chunks = computeDiff("a\nb\n", "a\nx\n");
 * const rows = buildDisplayRows(chunks);
 * // [
 * //   { kind: "equal", text: "a", lineNum: 1 },
 * //   { kind: "removed", text: "b", lineNum: 2 },
 * //   { kind: "added", text: "x", lineNum: 2 },
 * // ]
 * ```
 */
const buildDisplayRows = (chunks: DiffChunk[]): DisplayRow[] => {
  const displayRows: DisplayRow[] = [];
  let currentNewFileLineNum = 1;
  let currentOldFileLineNum = 1;

  for (const diffChunk of chunks) {
    const chunkLines = splitChunkLines(diffChunk.value);

    if (diffChunk.added === true) {
      for (const lineText of chunkLines) {
        displayRows.push({
          kind: "added",
          text: lineText,
          lineNum: currentNewFileLineNum,
        });
        currentNewFileLineNum += 1;
      }
    } else if (diffChunk.removed === true) {
      for (const lineText of chunkLines) {
        displayRows.push({
          kind: "removed",
          text: lineText,
          lineNum: currentOldFileLineNum,
        });
        currentOldFileLineNum += 1;
      }
    } else {
      for (const lineText of chunkLines) {
        displayRows.push({
          kind: "equal",
          text: lineText,
          lineNum: currentNewFileLineNum,
        });
        currentNewFileLineNum += 1;
        currentOldFileLineNum += 1;
      }
    }
  }

  return displayRows;
};

/**
 * Identifies rows near changes to show as context.
 *
 * @remarks
 * Context rows (equal lines surrounding changes) help readers understand what
 * changed without seeing the entire file. This function uses a fixed 3-line radius:
 * if a change happens at row N, rows [N-3...N+3] are marked as context (assuming
 * they're "equal" kind; added/removed rows are always shown regardless).
 *
 * **Performance:** For each change, we directly mark its fixed-size radius window
 * rather than checking every equal row against every change. Since the radius is
 * a constant, this is O(rows + changes × radius) — effectively linear — instead of
 * the O(rows × changes) an all-pairs distance check would cost on a file with many
 * scattered edits.
 *
 * @param rows - Display rows from `buildDisplayRows`.
 * @returns Set of row indices that should display as context (dimmed).
 *
 * @example
 * ```ts
 * const rows = [
 *   { kind: "equal", text: "line1", lineNum: 1 },
 *   { kind: "equal", text: "line2", lineNum: 2 },
 *   { kind: "added", text: "inserted", lineNum: 3 },
 *   { kind: "equal", text: "line4", lineNum: 4 },
 *   { kind: "equal", text: "line5", lineNum: 5 },
 * ];
 * buildNearChangeIndices(rows); // Set { 0, 1, 3, 4 } (within 3 lines of index 2)
 * ```
 */
const buildNearChangeIndices = (rows: DisplayRow[]): Set<number> => {
  const nearChangeIndices = new Set<number>();
  const contextWindowRadius = 3;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (rows[rowIndex]?.kind !== "added" && rows[rowIndex]?.kind !== "removed") {
      continue;
    }

    const windowStart = Math.max(0, rowIndex - contextWindowRadius);
    const windowEnd = Math.min(rows.length - 1, rowIndex + contextWindowRadius);
    for (let windowIndex = windowStart; windowIndex <= windowEnd; windowIndex += 1) {
      if (rows[windowIndex]?.kind === "equal") {
        nearChangeIndices.add(windowIndex);
      }
    }
  }

  return nearChangeIndices;
};

/**
 * Computes the line-by-line diff between two file contents.
 *
 * @remarks
 * This is a thin wrapper around the `diff` library's `diffLines` function.
 * It returns chunks (contiguous blocks of added/removed/equal lines) rather
 * than character-level or word-level diffs, which is appropriate for file edits.
 *
 * The result is the input to the rest of the rendering pipeline:
 * {@link buildDisplayRows} → {@link buildNearChangeIndices} → {@link renderDiffLines}.
 *
 * @param originalFileContent - The original file text (before changes).
 * @param proposedFileContent - The new file text (after changes).
 * @returns Array of diff chunks with `value` (text), `added`, and `removed` flags.
 *
 * @example
 * ```ts
 * const chunks = computeDiff("old\ntext\n", "old\nmodified\n");
 * // [
 * //   { value: "old\n", added: false, removed: false },
 * //   { value: "text\n", added: false, removed: true },
 * //   { value: "modified\n", added: true, removed: false },
 * // ]
 * ```
 */
export const computeDiff = (
  originalFileContent: string,
  proposedFileContent: string,
): DiffChunk[] => {
  return diffLines(originalFileContent, proposedFileContent) as DiffChunk[];
};

/**
 * Determines whether a row should appear in diff output, and under what label.
 *
 * @remarks
 * Shared by {@link renderDiffLines} and {@link getDiffDisplayLines} so both output
 * paths (terminal and structured/web) agree on exactly which rows are visible:
 * added/removed rows are always shown, equal rows only if they're in the context
 * window, and everything else is hidden.
 *
 * @param row - The display row to classify.
 * @param rowIndex - The row's index, used to check `nearChangeIndices` membership.
 * @param nearChangeIndices - Indices from `buildNearChangeIndices`.
 * @returns "added" | "removed" | "context" if visible, or `null` if the row should be omitted.
 */
const classifyVisibleRow = (
  row: DisplayRow,
  rowIndex: number,
  nearChangeIndices: Set<number>,
): "added" | "removed" | "context" | null => {
  if (row.kind === "added" || row.kind === "removed") {
    return row.kind;
  }
  return nearChangeIndices.has(rowIndex) ? "context" : null;
};

/**
 * Formats display rows as terminal-friendly strings with optional ANSI colors.
 */
const renderDiffLines = (
  displayRows: DisplayRow[],
  nearChangeIndices: Set<number>,
  useColor: boolean,
): string[] => {
  const outputLines: string[] = [];

  for (let rowIndex = 0; rowIndex < displayRows.length; rowIndex += 1) {
    const currentRow = displayRows[rowIndex];
    if (!currentRow) {
      continue;
    }

    const visibleKind = classifyVisibleRow(currentRow, rowIndex, nearChangeIndices);
    if (visibleKind === null) {
      continue;
    }

    const paddedLineNum = String(currentRow.lineNum).padStart(4);

    if (visibleKind === "added") {
      const line = `  ${paddedLineNum}  + ${currentRow.text}`;
      outputLines.push(useColor ? pc.green(line) : line);
    } else if (visibleKind === "removed") {
      const line = `  ${paddedLineNum}  - ${currentRow.text}`;
      outputLines.push(useColor ? pc.red(line) : line);
    } else {
      const line = `  ${paddedLineNum}    ${currentRow.text}`;
      outputLines.push(useColor ? pc.dim(line) : line);
    }
  }

  return outputLines;
};

export type DiffDisplayLine = {
  kind: "added" | "removed" | "context";
  lineNum: number;
  text: string;
};

/**
 * Extracts structured diff rows for client-side rendering.
 */
export const getDiffDisplayLines = (chunks: DiffChunk[]): DiffDisplayLine[] => {
  const displayRows = buildDisplayRows(chunks);
  const nearChangeIndices = buildNearChangeIndices(displayRows);
  const result: DiffDisplayLine[] = [];

  for (let rowIndex = 0; rowIndex < displayRows.length; rowIndex += 1) {
    const row = displayRows[rowIndex];
    if (!row) {
      continue;
    }
    const visibleKind = classifyVisibleRow(row, rowIndex, nearChangeIndices);
    if (visibleKind !== null) {
      result.push({ kind: visibleKind, lineNum: row.lineNum, text: row.text });
    }
  }

  return result;
};

/**
 * Formats a diff as plain text (no ANSI colors), optionally with a file header.
 */
export const formatDiffPlain = (
  chunks: DiffChunk[],
  filePath?: string,
): string => {
  const displayRows = buildDisplayRows(chunks);
  const nearChangeIndices = buildNearChangeIndices(displayRows);
  const outputLines: string[] = [];

  if (filePath !== undefined && filePath.length > 0) {
    outputLines.push(`File: ${filePath}`);
    outputLines.push("");
  }

  outputLines.push(...renderDiffLines(displayRows, nearChangeIndices, false));

  return outputLines.join("\n");
};