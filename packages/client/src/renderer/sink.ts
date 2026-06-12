import { appendHistory, appendLog } from "../ui/uiBridge.js";
import type { HistoryVariant } from "../ui/types.js";

/**
 * <Summary>
 * What it does:
 *   Appends a block of styled lines to the output history for display.
 *
 * How it does it (step by step):
 *   1. Create a history entry object with kind "block" and the provided lines.
 *   2. Append the history entry to the UI bridge for display.
 *
 * Parameters:
 *   @param {string[]} lines — Array of styled strings to display as a block.
 *
 * Returns:
 *   @returns {void} — Returns after appending the block to history.
 *
 * Dependencies:
 *   - appendHistory — adds the history entry to the UI display system.
 *
 * Dependants:
 *   - All renderer functions — use this to display styled line blocks.
 *   - appendStyledLines — calls this after adding spacing lines.
 * </Summary>
 */
export const appendBlock = (lines: string[]): void => {
  if (!Array.isArray(lines)) {
    throw new Error("appendBlock: lines must be an array");
  }
  appendHistory({ kind: "block", lines });
};

/**
 * <Summary>
 * What it does:
 *   Appends a single text line to the log output with a specified variant for styling.
 *
 * How it does it (step by step):
 *   1. Append the text line to the log output with the specified variant.
 *   2. Use the default "system" variant if no variant is provided.
 *
 * Parameters:
 *   @param {string} text — The text line to append to the log.
 *   @param {HistoryVariant} variant — The styling variant (e.g., "system", "error", "secondary"). Defaults to "system".
 *
 * Returns:
 *   @returns {void} — Returns after appending the text to the log.
 *
 * Dependencies:
 *   - appendLog — adds the text line to the UI log display.
 *
 * Dependants:
 *   - Progress display functions — use this for real-time progress updates.
 *   - Error display functions — use this with error variant.
 * </Summary>
 */
export const appendText = (
  text: string,
  variant: HistoryVariant = "system",
): void => {
  // ===== STEP 1: Append text to log =====
  // Step 1a: Append the text line to the log output with the specified variant
  // Step 1b: The variant determines how the text is styled (color, formatting, etc.)
  appendLog(text, variant);
};

/**
 * <Summary>
 * What it does:
 *   Appends a diff with file path and styled body to the output history.
 *
 * How it does it (step by step):
 *   1. Create a history entry object with kind "diff", file path, and styled body.
 *   2. Append the history entry to the UI bridge for display.
 *
 * Parameters:
 *   @param {string} path — The file path that the diff applies to.
 *   @param {string} body — The styled diff content (with syntax highlighting).
 *
 * Returns:
 *   @returns {void} — Returns after appending the diff to history.
 *
 * Dependencies:
 *   - appendHistory — adds the history entry to the UI display system.
 *
 * Dependants:
 *   - File write operations — use this to display file change diffs.
 * </Summary>
 */
export const appendDiff = (path: string, body: string): void => {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("appendDiff: path must be a non-empty string");
  }
  if (typeof body !== "string") {
    throw new Error("appendDiff: body must be a string");
  }
  appendHistory({ kind: "diff", path, body });
};

/**
 * <Summary>
 * What it does:
 *   Appends styled lines with optional leading and trailing blank lines for spacing.
 *
 * How it does it (step by step):
 *   1. Create a copy of the provided lines array to avoid mutation.
 *   2. If leading blank is not explicitly disabled, add a blank line at the start.
 *   3. If trailing blank is not explicitly disabled, add a blank line at the end.
 *   4. Append the resulting lines as a block to the output history.
 *
 * Parameters:
 *   @param {string[]} lines — Array of styled strings to display.
 *   @param {{ leadingBlank?: boolean; trailingBlank?: boolean }} options — Optional configuration for spacing. Defaults to adding both leading and trailing blanks.
 *
 * Returns:
 *   @returns {void} — Returns after appending the styled lines with spacing.
 *
 * Dependencies:
 *   - appendBlock — appends the final lines to the output history.
 *
 * Dependants:
 *   - Configuration display functions — use this for config tables.
 *   - Model display functions — use this for model lists.
 *   - Memory display functions — use this for memory entries.
 * </Summary>
 */
export const appendStyledLines = (
  lines: string[],
  options?: { leadingBlank?: boolean; trailingBlank?: boolean },
): void => {
  // ===== STEP 1: Create mutable copy =====
  // Step 1a: Create a copy of the provided lines array to avoid mutating the original
  // Step 1b: This prevents side effects on the caller's array
  const blockLines = [...lines];

  // ===== STEP 2: Add leading blank line =====
  // Step 2a: Check if leading blank is not explicitly disabled (defaults to true)
  if (options?.leadingBlank !== false) {
    // Step 2b: Add a blank line at the start for spacing before the content
    blockLines.unshift("");
  }

  // ===== STEP 3: Add trailing blank line =====
  // Step 3a: Check if trailing blank is not explicitly disabled (defaults to true)
  if (options?.trailingBlank !== false) {
    // Step 3b: Add a blank line at the end for spacing after the content
    blockLines.push("");
  }

  // ===== STEP 4: Append block to history =====
  // Step 4a: Append the final lines with spacing to the output history
  // Step 4b: This creates visual separation from other content in the display
  appendBlock(blockLines);
};
