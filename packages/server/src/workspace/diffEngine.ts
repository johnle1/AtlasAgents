/**
 * <Summary>
 * What it does:
 *   Builds git-style unified diffs with jsdiff and colors them for terminal display
 *   using picocolors. Pure functions only — no filesystem or network I/O.
 *
 * How it fits in the system:
 *   Used by WorkspaceManager.writeFile before asking the user to approve a change.
 *
 * Dependencies:
 *   - diff — createTwoFilesPatch (Myers-based unified diff).
 *   - picocolors — ANSI styling for +/- lines and hunk headers.
 *
 * Dependants:
 *   - WorkspaceManager, ConfirmationBroker (displays colored output).
 * </Summary>
 */

import { createTwoFilesPatch } from "diff";
import pc from "picocolors";

/**
 * <Summary>
 * What it does:
 *   Produces a unified diff patch string for one file (same path for old and new).
 *   Uses Myers algorithm from jsdiff to compute minimal change set.
 *
 * How it does it (step by step):
 *   1. Accept old content (before) and new content (after) as strings.
 *   2. Pass both to createTwoFilesPatch with same file path (since it's one file changing).
 *   3. Set context lines to 3 (show 3 lines of unchanged context around changes).
 *   4. Generate unified diff format (compatible with git, patch, etc.).
 *   5. Return the complete diff text (or empty string if contents identical).
 *
 * Parameters:
 *   @param {string} filePath — Relative workspace path shown in ---/+++ headers.
 *   @param {string} previousFileContent — Previous file contents (empty string for new files).
 *   @param {string} newFileContent — Proposed new contents.
 *
 * Returns:
 *   @returns {string} — Unified diff text in git format (may be empty when identical).
 *
 * Example output:
 *   --- src/index.ts
 *   +++ src/index.ts
 *   @@ -5,3 +5,4 @@
 *    const x = 1;
 *   -const y = 2;
 *   +const y = 3;
 *   +const z = 4;
 *
 * Dependants:
 *   - formatWritePreview, WorkspaceManager.writeFile.
 * </Summary>
 */
export const createUnifiedDiff = (
  filePath: string,
  previousFileContent: string,
  newFileContent: string,
): string => {
  // Step 1-2: Create unified diff using Myers algorithm
  // Pass same filePath twice since we're tracking one file's evolution (not comparing two files)
  // Step 3: context: 3 shows 3 lines of surrounding context around each change
  // Step 4-5: Returns git-compatible unified diff text
  return createTwoFilesPatch(
    filePath,
    filePath,
    previousFileContent,
    newFileContent,
    "",
    "",
    { context: 3 },
  );
};

/**
 * <Summary>
 * What it does:
 *   Applies terminal colors to a unified diff patch for better CLI readability.
 *   Uses picocolors for cross-platform ANSI color codes.
 *
 * How it does it (step by step):
 *   1. Split raw patch text into individual lines.
 *   2. Iterate through each line to classify its type by prefix.
 *   3. Apply color based on line type:
 *      - File paths (--- or +++) → bold white for emphasis
 *      - Hunk headers (@@..@@) → cyan to highlight section boundaries
 *      - Added lines (+) → green to show new content
 *      - Removed lines (-) → red to show deleted content
 *      - Context lines (no prefix) → uncolored (default terminal color)
 *   4. Collect all colored lines into result array.
 *   5. Join colored lines back into single string with newlines.
 *   6. Return complete colored diff ready for terminal display.
 *
 * Parameters:
 *   @param {string} rawDiffPatch — Unified diff text from createUnifiedDiff (no colors yet).
 *
 * Returns:
 *   @returns {string} — Patch with ANSI escape codes for terminal color display.
 *
 * Example transformation:
 *   Input:  "--- src/file.ts\n+++ src/file.ts\n@@ -1,3 +1,4 @@\n const x = 1;\n-const y = 2;\n+const y = 3;"
 *   Output: "\\x1b[1m--- src/file.ts\\x1b[0m\n\\x1b[1m+++ src/file.ts\\x1b[0m\n\\x1b[36m@@ -1,3 +1,4 @@\\x1b[0m\n const x = 1;\n\\x1b[31m-const y = 2;\\x1b[0m\n\\x1b[32m+const y = 3;\\x1b[0m"
 *
 * Dependants:
 *   - formatWritePreview, ConfirmationBroker (display in CLI/terminal).
 * </Summary>
 */
export const colorUnifiedDiff = (rawDiffPatch: string): string => {
  // Step 1: Split the raw diff text into individual lines for processing
  const coloredLines: string[] = [];

  // Step 2-3: Iterate through each line and classify it by prefix
  for (const currentLine of rawDiffPatch.split("\n")) {
    // File path headers (--- and +++) appear at the start of the diff
    // Bold them to make file boundaries visually distinct
    if (currentLine.startsWith("+++") || currentLine.startsWith("---")) {
      coloredLines.push(pc.bold(currentLine));
    }
    // Hunk headers (@@ -line,count +line,count @@) mark change regions
    // Color cyan to draw attention to where changes are located
    else if (currentLine.startsWith("@@")) {
      coloredLines.push(pc.cyan(currentLine));
    }
    // Additions (+) represent new content being added
    // Green indicates positive/constructive changes
    else if (currentLine.startsWith("+")) {
      coloredLines.push(pc.green(currentLine));
    }
    // Deletions (-) represent content being removed
    // Red indicates removal/destructive changes
    else if (currentLine.startsWith("-")) {
      coloredLines.push(pc.red(currentLine));
    }
    // Context lines (no prefix) are unchanged content for reference
    // Leave uncolored to reduce visual noise
    else {
      coloredLines.push(currentLine);
    }
  }

  // Step 4-6: Join all colored lines back together with newlines
  return coloredLines.join("\n");
};

/**
 * <Summary>
 * What it does:
 *   Convenience helper: unified diff plus colored terminal output in one call.
 *   Combines createUnifiedDiff and colorUnifiedDiff into a single operation.
 *
 * How it does it (step by step):
 *   1. Accept old content, new content, and file path.
 *   2. Generate raw unified diff via createUnifiedDiff.
 *   3. Generate colored version of same diff via colorUnifiedDiff.
 *   4. Return both versions in object:
 *      - patch: plain text (for logging, storage, plain display)
 *      - colored: ANSI-colored (for terminal display with colors)
 *
 * Parameters:
 *   @param {string} filePath — Relative workspace path for diff headers.
 *   @param {string} previousFileContent — Previous file contents (empty for new files).
 *   @param {string} newFileContent — Proposed new contents.
 *
 * Returns:
 *   @returns {{ patch: string; colored: string }} — Object with two diff versions:
 *     - patch: Raw unified diff (no colors, suitable for logs or plain text)
 *     - colored: ANSI-colored diff (with terminal colors, suitable for CLI display)
 *
 * Usage:
 *   const { patch, colored } = formatWritePreview('src/app.ts', oldContent, newContent);
 *   console.log(patch);     // Log plain text version
 *   console.log(colored);   // Show colored version to user in terminal
 *
 * Dependants:
 *   - WorkspaceManager.writeFile (supplies diff to user for approval).
 * </Summary>
 */
export const formatWritePreview = (
  filePath: string,
  previousFileContent: string,
  newFileContent: string,
): { patch: string; colored: string } => {
  // Step 1-2: Generate raw unified diff (no colors)
  const plainTextPatch = createUnifiedDiff(
    filePath,
    previousFileContent,
    newFileContent,
  );

  // Step 3: Apply terminal colors to the same diff for display
  const coloredDiffForTerminal = colorUnifiedDiff(plainTextPatch);

  // Step 4: Return both versions for different use cases
  // - patch: for logging, storage, or plain text output
  // - colored: for terminal display with ANSI colors
  return {
    patch: plainTextPatch,
    colored: coloredDiffForTerminal,
  };
};
