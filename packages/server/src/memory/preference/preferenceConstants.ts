/**
 * Configuration constants for preference rule storage and management.
 *
 * @remarks
 * Defines paths, thresholds, and limits for the preference store.
 * Used by {@link PreferenceStore} for deduplication, consolidation,
 * and rule lifecycle management.
 */

/**
 * Default file path for persisting preference rules.
 *
 * @remarks
 * Relative to the data root directory (typically the project root).
 * Stored under `user-data/` to keep user-generated data separate from source code.
 *
 * @defaultValue "user-data/preferences.json"
 */
export const DEFAULT_FILE = "user-data/preferences.json";

/**
 * Jaccard similarity threshold for detecting duplicate rules.
 *
 * @remarks
 * When adding a new rule, {@link PreferenceStore.add} compares it against
 * existing rules using Jaccard similarity. If similarity ≥ this threshold,
 * the new rule is merged (not added as duplicate).
 *
 * **Value: 0.8**
 * - Catches rephrased versions of the same rule
 * - Avoids false negatives from minor wording changes
 * - Merges increment `timesApplied` counter
 *
 * @defaultValue 0.8
 */
export const SIMILARITY_THRESHOLD = 0.8;

/**
 * Minimum rule count before triggering agent-driven consolidation.
 *
 * @remarks
 * {@link scheduleConsolidation} and manual `/consolidate` commands only
 * run the agent consolidation when rule count ≥ this threshold.
 * Consolidation uses the subagent model (expensive), so batching is important.
 *
 * **Value: 20**
 * - Avoids frequent expensive agent calls
 * - Allows deduplication to reduce count naturally
 * - Triggered weekly by background scheduler
 *
 * @defaultValue 20
 */
export const CONSOLIDATE_MIN_RULES = 20;

/**
 * <Summary>
 * What it does:
 *   Set of common English stop words to ignore during text tokenization.
 *
 * How it fits in the system:
 *   Used by the tokenise function to filter out noise words that don't contribute
 *   to meaningful similarity comparisons (e.g., "the", "and", "for").
 * </Summary>
 */
export const STOP_WORDS = new Set([
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
  "always",
  "never",
]);
