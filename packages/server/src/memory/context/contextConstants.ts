/**
 * <Summary>
 * What it does:
 *   Constants for context builder configuration and keyword processing.
 *
 * How it fits in the system:
 *   Provides configuration values for context window sizing, stop words for
 *   text processing, and task type keywords for keyword extraction.
 *   These constants are used throughout the context building system to
 *   ensure consistent behavior and optimize keyword extraction quality.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Fallback context window size (tokens) when Ollama does not return context_length.
 *
 * How it fits in the system:
 *   Used by resolveContextLength() as the last resort if model metadata is missing or incomplete.
 *   In normal operation, getContextWindow() queries Ollama.showModel() and dynamically caches the actual value.
 *   This value represents a safe default for modern LLMs (128k tokens) that should
 *   work for most models when their actual context window cannot be determined.
 *
 * Why this value:
 *   - 128k tokens is a common context window for modern LLMs (e.g., Claude, GPT-4)
 *   - Provides enough space for complex tasks without being overly conservative
 *   - Will be overridden by actual model context windows when available
 * </Summary>
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * <Summary>
 * What it does:
 *   Set of common English stop words to ignore during keyword extraction.
 *
 * How it fits in the system:
 *   Used by extractKeywords to filter out noise words that don't contribute
 *   to meaningful keyword matching (e.g., "the", "and", "for").
 *   These words appear frequently in English text but carry little semantic
 *   value for matching user preferences or detecting task types.
 *
 * Why filter stop words:
 *   - Reduces noise in keyword matching
 *   - Improves accuracy of preference rule matching
 *   - Focuses on meaningful technical and domain-specific terms
 *   - Prevents common words from triggering irrelevant rules
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Set of task type words for keyword extraction.
 *
 * How it fits in the system:
 *   Used by extractKeywords to identify and add task type keywords
 *   (e.g., "refactor", "fix", "add", "test") to the keyword set.
 *   These words represent common software development task types and
 *   are used to match relevant preference rules and trigger appropriate
 *   agent behaviors.
 *
 * Why these task types:
 *   - Covers the most common software development activities
 *   - Enables the system to understand user intent
 *   - Helps match tasks with relevant preference rules
 *   - Improves context relevance for agent planning
 * </Summary>
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
