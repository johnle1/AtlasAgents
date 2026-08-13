/**
 * Helpers for the additive `usage` TaskFrame (live context-window fill).
 *
 * @remarks
 * The server emits `{ kind: "usage", usedTokens, contextWindow }` after
 * model turns so the client footer can show remaining context %. Old
 * clients ignore unknown kinds; this module is the shared clamp so the
 * footer never renders `NaN%`.
 */

/**
 * Clamps a usage sample into a footer-safe pair, or `null` if it cannot
 * be shown (non-finite values, non-positive window).
 *
 * @param usedTokens - Tokens consumed so far. Rounded and clamped to
 *   `[0, contextWindow]`.
 * @param contextWindow - Resolved `num_ctx` (or equivalent) for the role.
 * @returns Clamped pair, or `null` to leave the footer at `—`.
 *
 * @example
 * ```ts
 * clampUsage(5000, 4096); // { usedTokens: 4096, contextWindow: 4096 }
 * clampUsage(10, 0);      // null
 * ```
 */
export const clampUsage = (
  usedTokens: number,
  contextWindow: number,
): { usedTokens: number; contextWindow: number } | null => {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  if (!Number.isFinite(usedTokens)) {
    return null;
  }
  return {
    usedTokens: Math.max(0, Math.min(Math.round(usedTokens), contextWindow)),
    contextWindow,
  };
};

/**
 * Rough token estimate from raw text (4 characters ≈ 1 token).
 *
 * @remarks
 * Used when the provider does not return exact eval counts. Good enough
 * for a live percentage; not a billing meter.
 *
 * @param text - Prompt, header, or model output.
 * @returns Estimated token count, at least 0.
 */
export const estimateTokensFromText = (text: string): number =>
  Math.max(0, Math.ceil(text.length / 4));
