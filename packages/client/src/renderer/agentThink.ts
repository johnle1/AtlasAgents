/**
 * Formats agent think text for display by removing boilerplate sections.
 *
 * @remarks
 * The agent's internal planning process outputs structured sections:
 * - UNDERSTAND: raw analysis of the task (verbose, not user-facing)
 * - CONTEXT FROM SESSION: session history (also verbose)
 * - (rest): strategic reasoning and final plan (relevant to user)
 *
 * This function removes the UNDERSTAND section to keep the UI concise, leaving
 * the session context and reasoning visible. The server never modifies the think
 * text itself; this is client-side display cleanup only.
 *
 * @param thinkText - Raw think text from agent's internal planning output
 *
 * @returns Formatted think text with UNDERSTAND section removed, or fallback message
 *
 * @example
 * ```ts
 * const raw = "UNDERSTAND:\nAnalyzing user request...\nCONTEXT FROM SESSION:\nPrior work...\nPLAN:\nStrategy...";
 * formatAgentThinkForDisplay(raw);
 * // → "CONTEXT FROM SESSION:\nPrior work...\nPLAN:\nStrategy..."
 * ```
 */
export const formatAgentThinkForDisplay = (thinkText: string): string => {
  // Regex pattern explanation:
  // ^         = start of string
  // \s*       = zero or more whitespace (handles leading newlines)
  // UNDERSTAND: = literal section header
  // \s*       = optional whitespace after header
  // [\s\S]*?  = non-greedy match of any characters (including newlines)
  //             stops at first match of lookahead, preventing over-consumption
  // (?=...)   = positive lookahead (doesn't consume the matched text)
  // \n\s*     = newline followed by optional indentation
  // CONTEXT FROM SESSION: = next section header (lookahead target)
  // i flag    = case-insensitive matching (handles "understand", "UNDERSTAND", etc.)
  // m flag    = multiline mode (^ and $ match line boundaries, not just string boundaries)
  const stripped = thinkText
    .replace(/^\s*UNDERSTAND:\s*[\s\S]*?(?=\n\s*CONTEXT FROM SESSION:)/im, "")
    .trim();

  // Return the cleaned text if anything remains after stripping,
  // otherwise return a placeholder to avoid empty state confusion.
  // Edge cases: think text with no UNDERSTAND section, or only UNDERSTAND section.
  return stripped.length > 0 ? stripped : "Planning...";
};
