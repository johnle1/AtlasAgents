/**
 * Display-only cleanup for advisor/agent “think” text before UI rendering.
 *
 * @remarks
 * These helpers **do not** change what the server plans — they only make the
 * streamed think boxes readable (collapse stutter loops, drop markdown fences,
 * hide the advisor `UNDERSTAND:` preamble).
 */

/**
 * Collapses stuttering token loops like `and-and-and-and` or `the the the the`.
 *
 * @remarks
 * Models occasionally emit hyphen- or space-separated repeats. Requiring
 * **three or more** repeats (`{3,}`) avoids rewriting legitimate doubled words.
 *
 * @param text - Raw think text.
 * @returns Text with long degenerate runs folded to a single token.
 *
 * @example
 * ```ts
 * collapseDegenerateRepetition("wait-wait-wait-wait now");
 * → "wait now"
 * ```
 */
export const collapseDegenerateRepetition = (text: string): string =>
  text
    .replace(/(\b[\w/]+)(?:-\1){3,}/gi, "$1")
    .replace(/(\b\w+\b)(?:\s+\1){3,}/gi, "$1");

/**
 * Removes markdown code-fence lines (``` …) from think text for display.
 *
 * @param text - Raw think text that may include fenced sections.
 * @returns Fence lines stripped; trimmed.
 */
const stripMarkdownFencesFromText = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
    .trim();

/**
 * Formats advisor think output for the CLI think box.
 *
 * @remarks
 * After fence stripping and repetition collapse, removes a leading
 * `UNDERSTAND:` section up to the next `EXPLORATION` / `PLAN` / `SELF-CHECK`
 * heading so users see planning, not internal grounding prose. Empty results
 * fall back to `"Planning..."`.
 *
 * @param thinkText - Raw advisor think stream text.
 * @returns Display string suitable for a think card.
 *
 * @example
 * ```ts
 * formatAdvisorThinkForDisplay("UNDERSTAND: …\nPLAN:\n1. Fix tests");
 * // → "PLAN:\n1. Fix tests" (fences/repetition also cleaned)
 * ```
 */
export const formatAdvisorThinkForDisplay = (thinkText: string): string => {
  const stripped = collapseDegenerateRepetition(
    stripMarkdownFencesFromText(thinkText),
  )
    // Drop the UNDERSTAND preamble only — keep EXPLORATION / PLAN / SELF-CHECK.
    .replace(
      /^\s*UNDERSTAND:\s*[\s\S]*?(?=\n\s*(?:EXPLORATION|PLAN|SELF-CHECK):)/im,
      "",
    )
    .trim();
  return stripped.length > 0 ? stripped : "Planning...";
};

/**
 * Formats agent think output for the CLI think box (fence stripping only).
 *
 * @param thinkText - Raw agent think stream text.
 * @returns Fence-stripped text for display.
 *
 * @example
 * ```ts
 * formatAgentThinkForDisplay("```\\nthought\\n```");
 * → "thought"
 * ```
 */
export const formatAgentThinkForDisplay = (thinkText: string): string =>
  stripMarkdownFencesFromText(thinkText);
