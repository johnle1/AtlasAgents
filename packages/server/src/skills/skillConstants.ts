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

/**
 * Minimum score for the best domain-flagged skill, relative to the overall
 * best score, to include it as a second result alongside the stack skill.
 *
 * @remarks
 * Replaces a prior absolute threshold (`score >= 3`) that only made sense
 * against fixed integer weights. Once scoring is IDF-weighted (see
 * {@link scoreSkillForTask}), scores are floats on no fixed scale, so a
 * relative bar — "at least 30% as relevant as the best match" — is the one
 * that stays meaningful as the skill corpus and its vocabulary change.
 *
 * @defaultValue 0.3
 */
export const DOMAIN_RELATIVE_THRESHOLD = 0.3;

/** Score weight for a task word found in a skill's declared `keywords`. */
export const KEYWORD_FIELD_WEIGHT = 3;

/** Score weight for a task word found in the skill's name. */
export const NAME_FIELD_WEIGHT = 2;

/** Score weight for a task word found anywhere in the skill's body. */
export const BODY_FIELD_WEIGHT = 1;

/**
 * Floor applied to every token's IDF weight.
 *
 * @remarks
 * Plain IDF pushes near 0 as a token's document frequency approaches the
 * total skill count, which would nearly zero out a field match on a term
 * that's merely common (e.g. present in 2 of 8 skills) rather than useless.
 * Flooring keeps every matched field contributing a non-trivial amount
 * regardless of corpus size.
 *
 * @defaultValue 0.3
 */
export const MIN_IDF = 0.3;

/** Invalid filesystem characters regex for sanitizing skill filenames. */
export const INVALID_FS_CHARS = /[<>:"|?*\x00-\x1f]/g;
