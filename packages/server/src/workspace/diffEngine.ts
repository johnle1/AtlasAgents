/**
 * <Summary>
 * What it does:
 *   Computes line-level diffs with jsdiff and renders Claude Code style numbered
 *   output with picocolors. Pure functions only — no I/O.
 *
 * How it fits in the system:
 *   Supplies formatted previews for WorkspaceManager.writeFile and confirmation UIs.
 *
 * Dependencies:
 *   - diff — diffLines for chunk arrays.
 *   - picocolors — ANSI styling.
 *
 * Dependants:
 *   - WorkspaceManager.writeFile.
 * </Summary>
 */

import { diffLines } from "diff";
import pc from "picocolors";
import type { DiffChunk, DisplayRow } from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Splits a chunk value into lines, dropping the trailing empty segment jsdiff
 *   often appends after a final newline.
 *
 * Parameters:
 *   @param {string} value — Raw chunk value.
 *
 * Returns:
 *   @returns {string[]} — Non-trailing-split lines.
 *
 * Dependants:
 *   - buildDisplayRows.
 * </Summary>
 */
const splitChunkLines = (chunkValue: string): string[] => {
  // Split the chunk value by newline characters to separate into individual lines
  const chunkLines = chunkValue.split("\n");

  // Check if the last element is an empty string (common artifact from jsdiff when text ends with newline)
  if (chunkLines.length > 0 && chunkLines[chunkLines.length - 1] === "") {
    // Remove the trailing empty line to avoid false line count
    chunkLines.pop();
  }

  return chunkLines;
};

/**
 * <Summary>
 * What it does:
 *   Flattens jsdiff chunks into rows with stable new-file line numbers for display.
 *
 * Parameters:
 *   @param {DiffChunk[]} chunks — Output from computeDiff.
 *
 * Returns:
 *   @returns {DisplayRow[]} — Ordered rows for second pass.
 *
 * Dependants:
 *   - formatDiff.
 * </Summary>
 */
const buildDisplayRows = (chunks: DiffChunk[]): DisplayRow[] => {
  // Initialize the output array to store formatted rows with line numbers
  const displayRows: DisplayRow[] = [];

  // Track the current line number in the new file; only incremented for added/unchanged lines
  let currentNewFileLineNum = 1;

  // Process each chunk from the diff to convert into display rows
  for (const diffChunk of chunks) {
    // Split the chunk into individual lines, removing trailing empty lines from jsdiff artifacts
    const chunkLines = splitChunkLines(diffChunk.value);

    // Handle newly added lines: include line number and increment counter
    if (diffChunk.added === true) {
      for (const lineText of chunkLines) {
        displayRows.push({
          kind: "added",
          text: lineText,
          lineNum: currentNewFileLineNum,
        });
        currentNewFileLineNum += 1;
      }
    }
    // Handle removed lines: include line number but don't increment counter (these aren't in new file)
    else if (diffChunk.removed === true) {
      for (const lineText of chunkLines) {
        displayRows.push({
          kind: "removed",
          text: lineText,
          lineNum: currentNewFileLineNum,
        });
      }
    }
    // Handle unchanged lines: include line number and increment counter (context lines)
    else {
      for (const lineText of chunkLines) {
        displayRows.push({
          kind: "equal",
          text: lineText,
          lineNum: currentNewFileLineNum,
        });
        currentNewFileLineNum += 1;
      }
    }
  }

  return displayRows;
};

/**
 * <Summary>
 * What it does:
 *   Marks equal-row indices that sit within three row positions of any add/remove.
 *
 * Parameters:
 *   @param {DisplayRow[]} rows — Flattened diff rows.
 *
 * Returns:
 *   @returns {Set<number>} — Indices into rows to show as dim context.
 *
 * Dependants:
 *   - formatDiff.
 * </Summary>
 */
const buildNearChangeIndices = (rows: DisplayRow[]): Set<number> => {
  // First pass: collect all indices where changes (additions or removals) occur
  const changeRowIndices: number[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (
      rows[rowIndex]?.kind === "added" ||
      rows[rowIndex]?.kind === "removed"
    ) {
      changeRowIndices.push(rowIndex);
    }
  }

  // Initialize set to store indices of context rows near changes
  const nearChangeIndices = new Set<number>();

  // Define the context window: show context lines within 3 rows of any change
  const contextWindowRadius = 3;

  // Second pass: for each unchanged line, check if it's within context window of any change
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    // Skip non-context rows (only process unchanged/equal rows)
    if (rows[rowIndex]?.kind !== "equal") {
      continue;
    }

    // Check distance to each change index to determine if this context row is near a change
    for (const changeRowIndex of changeRowIndices) {
      // If the distance is within the context window, mark this row for display
      if (Math.abs(rowIndex - changeRowIndex) <= contextWindowRadius) {
        nearChangeIndices.add(rowIndex);
        break; // Found proximity; no need to check other changes for this row
      }
    }
  }

  return nearChangeIndices;
};

/**
 * <Summary>
 * What it does:
 *   Runs jsdiff line diff and returns chunk objects for formatting.
 *
 * Parameters:
 *   @param {string} original — File contents before edit.
 *   @param {string} proposed — File contents after edit.
 *
 * Returns:
 *   @returns {DiffChunk[]} — Line diff chunks.
 *
 * Dependants:
 *   - formatDiff, WorkspaceManager.writeFile.
 * </Summary>
 */
export const computeDiff = (
  originalFileContent: string,
  proposedFileContent: string,
): DiffChunk[] => {
  // Use the jsdiff library to compute line-level differences between original and proposed content
  // The diffLines function returns an array of chunks indicating which lines were added, removed, or unchanged
  return diffLines(originalFileContent, proposedFileContent) as DiffChunk[];
};

/**
 * <Summary>
 * What it does:
 *   Shared loop that formats display rows as numbered +/- and context lines.
 *
 * Dependants:
 *   - formatDiff, formatDiffPlain.
 * </Summary>
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

    const paddedLineNum = String(currentRow.lineNum).padStart(4);

    if (currentRow.kind === "added") {
      const line = `  ${paddedLineNum}  + ${currentRow.text}`;
      outputLines.push(useColor ? pc.green(line) : line);
    } else if (currentRow.kind === "removed") {
      const line = `  ${paddedLineNum}  - ${currentRow.text}`;
      outputLines.push(useColor ? pc.red(line) : line);
    } else if (nearChangeIndices.has(rowIndex)) {
      const line = `  ${paddedLineNum}    ${currentRow.text}`;
      outputLines.push(useColor ? pc.dim(line) : line);
    }
  }

  return outputLines;
};

/**
 * <Summary>
 * What it does:
 *   Renders a Claude Code style colored diff: header, then numbered + / - / dim
 *   context within three rows of a change.
 *
 * Parameters:
 *   @param {DiffChunk[]} chunks — From computeDiff.
 *   @param {string} filePath — Relative path shown in the header.
 *
 * Returns:
 *   @returns {string} — Single ANSI-colored string for terminal display.
 *
 * Dependants:
 *   - WorkspaceManager.writeFile.
 * </Summary>
 */
export const formatDiff = (chunks: DiffChunk[], filePath: string): string => {
  // Step 1: Convert diff chunks into display rows with proper line numbering
  const displayRows = buildDisplayRows(chunks);

  // Step 2: Identify which context lines are close enough to changes to display
  // This prevents showing too much unchanged code and keeps the diff focused
  const nearChangeIndices = buildNearChangeIndices(displayRows);

  // Step 3: Initialize output array to accumulate formatted lines for terminal output
  const outputLines: string[] = [];

  // Step 4: Add formatted header showing the file being written
  // Uses bold white text with a bullet point symbol for visual emphasis
  outputLines.push(pc.bold(pc.white(` \u25CF Writing ${filePath}`)));
  outputLines.push(""); // Add blank line after header for readability

  // Step 5: Render colored +/- and context lines
  outputLines.push(...renderDiffLines(displayRows, nearChangeIndices, true));

  // Step 6: Join all formatted lines with newline separators for final output
  return outputLines.join("\n");
};

/**
 * <Summary>
 * What it does:
 *   Renders a plain-text line diff for LLM prompts: optional file header, then
 *   numbered + / - lines and nearby context (no ANSI colors).
 *
 * How it does it (step by step):
 *   1. Build display rows and near-change indices (same as formatDiff).
 *   2. Optionally prepend a `File: path` header line.
 *   3. Emit plain + / - / context lines via renderDiffLines without picocolors.
 *   4. Join lines with newlines.
 *
 * Parameters:
 *   @param {DiffChunk[]} chunks — From computeDiff.
 *   @param {string} [filePath] — Optional path shown in a plain header.
 *
 * Returns:
 *   @returns {string} — Plain diff text safe for advisor prompts.
 *
 * Dependants:
 *   - PatternExtractor — user edit and write summaries.
 * </Summary>
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
