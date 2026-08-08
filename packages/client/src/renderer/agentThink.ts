/**
 * Formats agent think text for display.
 *
 * @remarks
 * Trims the text and substitutes a placeholder when empty. Previously also
 * stripped a leading `UNDERSTAND:` section, but that made the live streaming
 * view and the committed scrollback view disagree — text visibly vanished
 * the moment a block finished streaming. The server never modifies the
 * think text itself; this remains client-side display cleanup only, now
 * limited to changes that are safe to apply identically to both views.
 *
 * @param thinkText - Raw think text from the agent's internal planning output.
 *
 * @returns The trimmed text, or a placeholder if empty.
 *
 * @example
 * ```ts
 * formatAgentThinkForDisplay("PLAN:\nStrategy..."); // "PLAN:\nStrategy..."
 * formatAgentThinkForDisplay("   ");                 // "Planning..."
 * ```
 */
export const formatAgentThinkForDisplay = (thinkText: string): string => {
  const trimmed = thinkText.trim();
  return trimmed.length > 0 ? trimmed : "Planning...";
};
