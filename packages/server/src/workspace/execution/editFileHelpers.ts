/**
 * Helpers for surgical file editing operations, particularly for generating helpful error messages
 * when an edit anchor (search text) cannot be found in a file.
 *
 * @remarks
 * When a user specifies an anchor text to find and replace via {@link WorkspaceManager.editFile},
 * the search may fail if the anchor has been modified, doesn't exist, or contains typos.
 * This module provides utilities to construct informative error hints by searching for
 * similar text patterns in the file and returning nearby context to help the user understand
 * what went wrong and how to fix it.
 *
 * @example
 * const content = fs.readFileSync("index.ts", "utf-8");
 * const anchor = "const oldValue = 42";
 * const hint = buildEditAnchorHint(content, anchor);
 * // Returns something like:
 * // "\n\nNearby lines:\nconst oldVariable = 42\n---\nconst value = 100"
 */

/**
 * Generates a helpful hint message showing nearby lines when an edit anchor (search text) is not found.
 *
 * @remarks
 * This function helps users debug failed edits by:
 * 1. Extracting a needle (first 12 chars of trimmed anchor, lowercased)
 * 2. Searching for lines containing that needle substring
 * 3. Returning those lines with 1 line of context above and below each match (up to 5 matches)
 * 4. If no matches found, returning the first 8 lines of the file as context
 *
 * **Why this helps:** When an edit anchor doesn't match, it's usually because:
 * - The user's anchor text is slightly outdated (e.g. "const value = 1" but file has "const val = 1")
 * - The anchor is too generic (e.g. "function" which appears everywhere)
 * - The file was modified since the edit was written
 *
 * By showing what's actually in the file near similar text, users can copy the exact anchor.
 *
 * **Needle strategy:** We use only the first 12 characters of the anchor to maximize chances
 * of finding _something_ related to what the user was trying to match, even if their anchor
 * is off by a few characters.
 *
 * @param content - The complete file content as a single string (lines separated by "\n").
 *   Empty strings are valid (will return empty hint).
 * @param anchor - The text the user tried to find and edit. This is the "search anchor" from
 *   the failed edit operation. Can be empty or very short.
 * @returns A formatted hint string prefixed with newlines, suitable for appending to an
 *   error message. Returns empty string if anchor is too short (less than 3 chars after trimming).
 *   Otherwise returns either:
 *   - "\\n\\nNearby lines:\\n{lines}" if similar lines found in file
 *   - "\\n\\nFile starts with:\\n{first 8 lines}" if no similar lines found
 *
 * @example
 * // Case 1: Anchor found (similar text exists)
 * const hint = buildEditAnchorHint(
 *   "function greet() {\n  console.log('hi');\n}\nfunction farewell() {",
 *   "console.log('hello')"
 * );
 * // Returns: "\n\nNearby lines:\nfunction greet() {\n  console.log('hi');\n}\n---\nfunction farewell() {"
 *
 * // Case 2: No matches found
 * const hint = buildEditAnchorHint("line1\nline2\nline3", "xyz123");
 * // Returns: "\n\nFile starts with:\nline1\nline2\nline3"
 *
 * // Case 3: Anchor too short
 * const hint = buildEditAnchorHint("content", "ab");
 * // Returns: "" (empty string — no hint generated)
 */
export const buildEditAnchorHint = (
  content: string,
  anchor: string,
): string => {
  // Split the file into individual lines for line-by-line searching.
  const lines = content.split("\n");

  // Extract and normalize the search needle: take first 40 chars, trim, lowercase for case-insensitive matching.
  // Limiting to 40 chars prevents searching for extremely long needles that are unlikely to match.
  const needle = anchor.trim().slice(0, 40).toLowerCase();

  // If the needle is too short (less than 3 chars), it's too generic to produce useful hints.
  // Return empty string to avoid polluting the error message with irrelevant context.
  if (needle.length < 3) {
    return "";
  }

  // Search for lines containing a portion of the needle (first 12 chars).
  // We use only 12 chars to balance specificity (to reduce false positives) with generality
  // (to match even if the anchor text is slightly different from what's in the file).
  const nearby: string[] = [];
  for (let i = 0; i < lines.length && nearby.length < 5; i += 1) {
    // Check if this line contains the start of our needle (case-insensitive).
    // The non-null assertion (!) is safe here because we're iterating within bounds.
    if (lines[i]!.toLowerCase().includes(needle.slice(0, 12))) {
      // Found a match! Include this line plus context: one line before and one after.
      // This gives the user enough context to understand the match.
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      // Collect the context block (start line, match line, end line) as a single string.
      nearby.push(lines.slice(start, end).join("\n"));
    }
  }

  // If we didn't find any matching lines, fall back to showing the beginning of the file.
  // This helps the user understand the structure and encoding of the file they're editing.
  if (nearby.length === 0) {
    const preview = lines.slice(0, 8).join("\n");
    return `\n\nFile starts with:\n${preview}`;
  }

  // Join all matching context blocks with a visual separator (---) so the user can distinguish
  // between different matches when multiple are found.
  return `\n\nNearby lines:\n${nearby.join("\n---\n")}`;
};
