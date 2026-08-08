/**
 * Utility functions for context building operations.
 *
 * @remarks
 * Encapsulates token estimation, keyword extraction, context window resolution,
 * and rule sorting logic. These functions support {@link ContextBuilder} operations
 * while keeping the main class focused and testable.
 *
 * **Functions:**
 * - Token estimation for budget calculations
 * - Keyword extraction with stop-word filtering
 * - Context window resolution from model metadata
 * - Rule sorting by usage and recency
 */

// ===== OLLAMA TYPE IMPORTS =====
import type { ModelInfo } from "../../ollama/types.js";

// ===== ORCHESTRATION TYPE IMPORTS =====
import type {
  LanguageHint,
  PreferenceRule,
} from "../../orchestration/interfaces.js";

// ===== CONSTANTS IMPORTS =====
import {
  CONFIDENCE_DENSITY_WEIGHT,
  DEFAULT_CONTEXT_WINDOW,
  HIGHLIGHT_WORDS,
  TASK_TYPE_WORDS,
} from "./contextConstants.js";

/**
 * Approximates token count from raw string length for budgeting.
 *
 * @param textContent - Text content to measure
 * @returns Estimated token count (>= 0)
 *
 * @remarks
 * Uses 1 token per 4 characters as a common LLM tokenizer approximation.
 * Results are rounded up (Math.ceil) to ensure conservative budget estimates
 * that never underestimate token cost. This is a rough heuristic and may vary
 * by actual tokenizer implementation.
 *
 * @example
 * ```ts
 * approxTokens("hello world") // 3 tokens
 * approxTokens("")             // 0 tokens
 * ```
 */
export const approxTokens = (textContent: string): number => {
  if (textContent.length === 0) {
    return 0;
  }
  // 1 token per 4 chars; round up for conservative budget
  return Math.ceil(textContent.length / 4);
};

/**
 * Truncates a pattern body to fit a token budget alongside a fixed header.
 *
 * @param body - The pattern text to truncate
 * @param header - Fixed text that will be prepended to `body` and counted
 *   against the same budget (e.g. a `"- filename.md\n"` heading)
 * @param tokenBudget - Total tokens available for `header + body` combined
 * @returns The largest prefix of `body`, cut at the last newline at or
 *   before the character budget, that fits `header + body` within
 *   `tokenBudget`; `""` if nothing fits or `body` fits entirely, `body`
 *   unchanged if it already fits
 *
 * @remarks
 * Computes the cutoff directly from {@link approxTokens}'s inverse rather
 * than trimming a few characters at a time in a loop — `approxTokens` is
 * `Math.ceil(length / 4)`, and for an integer `tokenBudget`,
 * `header.length + s.length <= tokenBudget * 4` is exactly equivalent to
 * `approxTokens(header + s) <= tokenBudget`. This is O(1) instead of
 * O(originalLength) for the previous trim-16-chars-at-a-time loop.
 *
 * Always backs off to the last newline within the character budget rather
 * than cutting mid-line, so truncation never splits a word or a markdown
 * construct (e.g. a code fence) — which means a single very long line with
 * no newline inside the budget truncates to `""` (the caller skips the
 * pattern entirely) rather than returning a partial, potentially-corrupted
 * line.
 *
 * @example
 * ```ts
 * truncateToTokenBudget("line one\nline two\nline three", "- doc.md\n", 5)
 * //  "line one" (cut at the newline before the char budget)
 * ```
 */
export const truncateToTokenBudget = (
  body: string,
  header: string,
  tokenBudget: number,
): string => {
  const maxBodyChars = Math.max(0, tokenBudget * 4 - header.length);

  if (body.length <= maxBodyChars) {
    return body;
  }

  const candidate = body.slice(0, maxBodyChars);
  const lastNewline = candidate.lastIndexOf("\n");
  return lastNewline === -1 ? "" : candidate.slice(0, lastNewline);
};

/**
 * Extracts task keywords with language, framework, and task-type tags.
 *
 * @param taskText - Raw user task (may have mixed case, punctuation)
 * @param languageHints - Language/framework hints from user-data/language-hints.json
 * @returns Deduped set of keywords for preference rule matching
 *
 * @remarks
 * Filters task text for meaningful keywords (>= 3 chars, excluding filler words),
 * then enriches with language tags (e.g., "TypeScript" → "typescript" tag) and
 * task-type keywords (e.g., "refactor", "debug"). Set deduplication ensures
 * keywords appearing multiple times have equal priority.
 *
 * Programming symbols (C++, C#, TypeScript+React) are preserved during tokenization
 * to capture meaningful compound terms.
 *
 * @example
 * ```ts
 * const keywords = extractKeywords(
 *   "Refactor TypeScript+React component",
 *   languageHints
 * );
 *  { "refactor", "typescript", "react", "component" }
 * ```
 */
export const extractKeywords = (
  taskText: string,
  languageHints: LanguageHint[],
): Set<string> => {
  const lowercaseTaskText = taskText.toLowerCase();

  // Split on non-alphanumeric except +# (preserves C++, C#, TypeScript+React)
  const wordTokens = lowercaseTaskText.split(/[^a-z0-9+#]+/g);

  const extractedKeywords = new Set<string>();

  // Add meaningful general keywords (filter noise words)
  for (const wordToken of wordTokens) {
    if (wordToken.length < 3 || HIGHLIGHT_WORDS.has(wordToken)) {
      continue;
    }
    extractedKeywords.add(wordToken);
  }

  // Add language/framework tags when hints match task text
  for (const { needle: searchNeedle, tag: topicTag } of languageHints) {
    if (lowercaseTaskText.includes(searchNeedle.toLowerCase())) {
      extractedKeywords.add(topicTag);
    }
  }

  // Add task-type keywords (refactor, fix, test, debug, etc.)
  for (const taskTypeWord of TASK_TYPE_WORDS) {
    if (lowercaseTaskText.includes(taskTypeWord)) {
      extractedKeywords.add(taskTypeWord);
    }
  }

  return extractedKeywords;
};

/**
 * Resolves context window size from Ollama model metadata with fallback chain.
 *
 * @param ollamaModelInfo - Parsed `/api/show` response from Ollama
 * @returns Context length in tokens (always positive)
 *
 * @remarks
 * Tries three strategies in order:
 * 1. Top-level `context_length` property (most common)
 * 2. Nested `model_info` object for `*context_length` keys (some model formats)
 * 3. Falls back to DEFAULT_CONTEXT_WINDOW (128k) if extraction fails
 *
 * Results are floored to integers. Tolerates partial/missing metadata
 * to avoid crashes when Ollama responses are incomplete.
 *
 * @example
 * ```ts
 * const window = resolveContextLength(ollamaModelInfo);
 * console.log(window); // 4096, 8192, or DEFAULT_CONTEXT_WINDOW
 * ```
 */
export const resolveContextLength = (ollamaModelInfo: ModelInfo): number => {
  // Try top-level context_length first (most common Ollama format)
  if (
    typeof ollamaModelInfo.context_length === "number" &&
    Number.isFinite(ollamaModelInfo.context_length) &&
    ollamaModelInfo.context_length > 0
  ) {
    return Math.floor(ollamaModelInfo.context_length);
  }

  // Fallback: search nested model_info for *context_length keys
  // Handles format: { model_info: { "llama2.context_length": 4096 } }
  const nestedModelInfo = ollamaModelInfo.model_info;
  if (nestedModelInfo && typeof nestedModelInfo === "object") {
    for (const [propertyKey, propertyValue] of Object.entries(
      nestedModelInfo,
    )) {
      if (
        propertyKey.endsWith("context_length") &&
        typeof propertyValue === "number" &&
        Number.isFinite(propertyValue) &&
        propertyValue > 0
      ) {
        return Math.floor(propertyValue);
      }
    }
  }

  // Final fallback: use safe default if metadata is missing/incomplete
  return DEFAULT_CONTEXT_WINDOW;
};

/**
 * Sorts preference rules by value density (descending), then creation time (ascending).
 *
 * @param rules - Unsorted preference rules to prioritize
 * @returns New sorted array; original unmodified
 *
 * @remarks
 * **Sort order:**
 * 1. Primary: highest value density first — a blend of `confidence` and
 *    proven usage (`Math.log1p(timesApplied)`) per token the rule costs to
 *    render (`score / approxTokens("- " + text + "\n")`), not raw usage
 *    count. A frequently-used rule that costs many tokens can still rank
 *    below a less-used but much cheaper rule, since the goal is maximizing
 *    useful coverage within a fixed token budget, not raw usage.
 *    `log1p` is used instead of the raw count so an occasionally-applied
 *    rule isn't drowned out by one applied hundreds of times — usage
 *    matters, but with diminishing returns, and confidence stays a
 *    meaningful signal even before a rule has accumulated any usage at all
 *    (previously `timesApplied` alone decided ranking, and in practice was
 *    almost always 0 in production, so ranking degenerated to insertion order).
 * 2. Tiebreaker: oldest first (ISO timestamp) — FIFO for equal density
 *
 * The token cost is computed against the exact same rendered line
 * (`"- " + text + "\n"`) that {@link ContextBuilder.build} later charges
 * against the budget, so the ranking matches actual cost exactly rather
 * than approximating from `text` alone.
 *
 * **Performance:** each rule's density is computed exactly once up front
 * (decorate-sort-undecorate) rather than recomputed inside the comparator on
 * every comparison — the previous approach paid the O(rule text length)
 * cost of `density()` roughly `2 · R log R` times for `R` rules; this pays
 * it `R` times, leaving only cheap numeric comparisons in the sort itself.
 *
 * Does not mutate the input array.
 *
 * @example
 * ```ts
 * const unsorted = [
 *   { id: "a", timesApplied: 2, text: "short rule", timestamp: "2025-01-05", ... },
 *   { id: "b", timesApplied: 5, text: "a very long, expensive rule ...", timestamp: "2025-01-01", ... },
 *   { id: "c", timesApplied: 2, text: "short rule", timestamp: "2025-01-01", ... },
 * ];
 * const sorted = sortRules(unsorted);
 *  [c, a] cheap-and-used rules can outrank b's raw usage count if b is expensive enough
 * ```
 */
export const sortRules = (rules: PreferenceRule[]): PreferenceRule[] => {
  const density = (rule: PreferenceRule): number => {
    const score = CONFIDENCE_DENSITY_WEIGHT[rule.confidence] + Math.log1p(rule.timesApplied);
    return score / Math.max(1, approxTokens(`- ${rule.text}\n`));
  };

  const decorated = rules.map((rule) => ({ rule, density: density(rule) }));

  decorated.sort((first, second) => {
    // Sort by value density descending (higher confidence/usage-per-token wins)
    const densityDifference = second.density - first.density;
    if (densityDifference !== 0) {
      return densityDifference;
    }
    // Tiebreaker: sort by timestamp ascending (older first for predictable FIFO)
    return first.rule.timestamp.localeCompare(second.rule.timestamp);
  });

  return decorated.map((entry) => entry.rule);
};
