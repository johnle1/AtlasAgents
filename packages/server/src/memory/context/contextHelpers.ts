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
 * Sorts preference rules by usage frequency (descending), then creation time (ascending).
 *
 * @param rules - Unsorted preference rules to prioritize
 * @returns New sorted array; original unmodified
 *
 * @remarks
 * **Sort order:**
 * 1. Primary: highest usage (timesApplied) first — proven rules come first
 * 2. Tiebreaker: oldest first (ISO timestamp) — FIFO for same usage level
 *
 * Does not mutate the input array. Most-used rules are prioritized in the context
 * header to maximize coverage within token budget.
 *
 * @example
 * ```ts
 * const unsorted = [
 *   { id: "a", timesApplied: 2, timestamp: "2025-01-05", ... },
 *   { id: "b", timesApplied: 5, timestamp: "2025-01-01", ... },
 *   { id: "c", timesApplied: 2, timestamp: "2025-01-01", ... },
 * ];
 * const sorted = sortRules(unsorted);
 *  [b (5x), c (2x, older), a (2x, newer)]
 * ```
 */
export const sortRules = (rules: PreferenceRule[]): PreferenceRule[] => {
  return [...rules].sort((firstRule, secondRule) => {
    // Sort by usage frequency descending (higher count wins)
    if (secondRule.timesApplied !== firstRule.timesApplied) {
      return secondRule.timesApplied - firstRule.timesApplied;
    }
    // Tiebreaker: sort by timestamp ascending (older first for predictable FIFO)
    return firstRule.timestamp.localeCompare(secondRule.timestamp);
  });
};
