/**
 * <Summary>
 * What it does:
 *   Constants for preference store configuration and text processing.
 *
 * How it fits in the system:
 *   Provides configuration values for similarity thresholds, consolidation rules,
 *   and stop words for text processing used throughout the preference store.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Default file path for storing user preference rules relative to the project root.
 *
 * How it fits in the system:
 *   Used by the PreferenceStore constructor to determine where to persist rules.
 *   The file is stored under user-data/ to keep user-generated data separate from source code.
 * </Summary>
 */
export const DEFAULT_FILE = "user-data/preferences.json";

/**
 * <Summary>
 * What it does:
 *   Jaccard similarity threshold for detecting duplicate preference rules.
 *
 * How it fits in the system:
 *   When adding a new rule, the store checks if an existing rule has similarity >= 0.8.
 *   If so, the new rule is merged into the existing one instead of creating a duplicate.
 * </Summary>
 */
export const SIMILARITY_THRESHOLD = 0.8;

/**
 * <Summary>
 * What it does:
 *   Minimum number of rules required before consolidation is triggered.
 *
 * How it fits in the system:
 *   Consolidation uses an AI advisor to merge duplicate rules, which is expensive.
 *   This threshold ensures consolidation only runs when there are enough rules to benefit.
 * </Summary>
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
