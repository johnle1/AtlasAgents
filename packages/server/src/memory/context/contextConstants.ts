/**
 * Configuration constants for the context building system.
 *
 * @remarks
 * Defines fallback values, stop words for keyword filtering, and task type
 * keywords used during context construction. These ensure consistent behavior
 * across context builder operations and preference rule matching.
 */

/**
 * Fallback context window size (tokens) when model metadata is unavailable.
 *
 * @remarks
 * Used by `contextHelpers.resolveContextLength()` as a last-resort fallback
 * when Ollama does not return `context_length` metadata for a model.
 *
 * In normal operation, `ContextBuilder.getContextWindow()` queries Ollama's
 * model API and caches the actual value, overriding this constant.
 *
 * **Why 128,000 tokens?**
 * - Covers modern large context window models (Claude 3, GPT-4, Llama 3)
 * - Provides ample space for complex tasks (even after 20% memory budget reservation)
 * - Conservative default that works across model sizes
 * - Typically overridden by actual model capability within seconds of first use
 *
 * @defaultValue 128000
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Stop words to filter during keyword extraction.
 *
 * @remarks
 * Common English words that appear frequently but carry little semantic value
 * for preference rule matching. Filtering these improves matching accuracy by
 * focusing on meaningful technical and domain-specific terms.
 *
 * Used by `contextHelpers.extractKeywords()` to produce a cleaner set of
 * task-relevant keywords from user task descriptions.
 *
 * **Benefits:**
 * - Reduces noise in keyword matching
 * - Improves accuracy of preference rule selection
 * - Focuses on meaningful technical terminology
 * - Prevents common words from triggering irrelevant rules
 */
export const HIGHLIGHT_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "has",
  "was",
  "were",
  "are",
  "you",
  "your",
  "into",
  "about",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "would",
  "could",
  "should",
  "their",
  "there",
  "then",
  "than",
  "them",
  "also",
  "using",
  "use",
  "used",
  "need",
  "just",
  "like",
  "make",
  "made",
  "each",
  "some",
  "such",
  "very",
  "more",
  "most",
  "other",
  "only",
  "over",
  "after",
  "before",
  "between",
  "under",
  "again",
  "here",
  "how",
  "why",
  "who",
  "can",
  "not",
  "but",
  "all",
  "any",
  "our",
  "out",
  "off",
  "its",
  "his",
  "her",
  "she",
  "him",
  "they",
  "them",
  "too",
  "per",
  "via",
]);

/**
 * Task type keywords recognized during context building.
 *
 * @remarks
 * Words identifying common software development activities that trigger
 * task-specific preference rules and fix rules.
 *
 * Used by `contextHelpers.extractKeywords()` to categorize user tasks and
 * match them to relevant preference rules. For example, tasks containing
 * "test" will match rules tagged with the "test" topic.
 *
 * **Coverage:**
 * - Development activities: add, create, implement, build, remove, delete, update
 * - Quality/maintenance: test, debug, refactor, optimize, document, review
 * - System operations: migrate, explain
 *
 * These cover most common scenarios; extend as needed for domain-specific tasks.
 */
export const TASK_TYPE_WORDS = new Set([
  "refactor",
  "fix",
  "add",
  "test",
  "debug",
  "implement",
  "migrate",
  "update",
  "remove",
  "delete",
  "create",
  "build",
  "review",
  "optimize",
  "document",
  "explain",
]);

/**
 * Weight contributed by a rule's `confidence` to its value-density ranking score.
 *
 * @remarks
 * Used by `contextHelpers.sortRules()`. Before this, `confidence` was
 * persisted and merge-compared but never actually influenced which rules
 * got selected into the context header — ranking was driven by
 * `timesApplied` alone, which in practice was almost always 0 (nothing
 * called `markApplied` in production), so rules effectively ranked by
 * insertion order. Folding `confidence` into density means an explicit,
 * high-trust rule outranks a low-confidence guess even before either has
 * accumulated any usage.
 *
 * Values are on the same rough scale as `Math.log1p(timesApplied)` (which
 * ranges ~0–3 for realistic usage counts) so neither term dominates by
 * construction alone.
 */
export const CONFIDENCE_DENSITY_WEIGHT: Record<"high" | "medium" | "low", number> = {
  high: 3,
  medium: 2,
  low: 1,
};
