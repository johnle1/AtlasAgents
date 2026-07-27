/**
 * Constants for skill manager configuration and text processing.
 *
 * @remarks
 * Provides configuration values for skills directory path, stop words for text processing, and scoring thresholds for skill selection.
 */

/** Relative skills directory under the server data root. */
export const SKILLS_REL_DIR = "user-data/skills";

/**
 * Stop words used for tokenization.
 * These common English words are filtered out when analyzing task text
 * to improve skill matching relevance scoring. Words shorter than 3 chars
 * are also excluded to focus on meaningful keywords.
 */
export const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "if",
  "not",
  "no",
  "so",
  "up",
  "out",
  "about",
  "into",
  "over",
  "after",
  "before",
  "between",
  "through",
  "during",
  "without",
  "within",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "just",
  "also",
  "now",
  "only",
  "own",
  "same",
  "then",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "both",
  "new",
  "old",
  "use",
  "using",
  "used",
  "make",
  "made",
  "get",
  "set",
  "add",
  "run",
  "file",
  "files",
  "code",
  "task",
]);

/** Minimum keyword score to include a second (domain) skill alongside the stack skill. */
export const DOMAIN_MIN_SCORE = 3;

/** Invalid filesystem characters regex for sanitizing skill filenames. */
export const INVALID_FS_CHARS = /[<>:"|?*\x00-\x1f]/g;
