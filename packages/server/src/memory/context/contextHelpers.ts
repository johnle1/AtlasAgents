/**
 * <Summary>
 * What it does:
 *   Helper functions for context builder including token estimation, keyword extraction,
 *   context window resolution, and rule sorting.
 *
 * How it fits in the system:
 *   Provides utility functions for token budgeting, keyword matching, and rule prioritization.
 *   These functions encapsulate complex logic for context building, making the main
 *   ContextBuilder class cleaner and more maintainable.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Approximates token count from raw string length for budgeting.
 *
 * How it does it (step by step):
 *   1. Check if input text is empty to handle edge case efficiently.
 *   2. Calculate estimated tokens using simplified character-to-token ratio.
 *   3. Round up the result to ensure conservative budget estimates.
 *
 * Parameters:
 *   @param textContent - Text content to measure and estimate tokens for.
 *
 * Returns:
 *   @returns Estimated token count (>= 0).
 *
 * Note:
 *   Uses 1 token per 4 characters as a common LLM tokenizer approximation.
 *   This is a rough estimate and may vary by actual tokenizer implementation.
 *   Conservative rounding up ensures we never exceed actual token limits.
 * </Summary>
 */
export const approxTokens = (textContent: string): number => {
  // Step 1: Check if input text is empty
  // Empty strings require 0 tokens; return early to avoid unnecessary calculation
  if (textContent.length === 0) {
    return 0;
  }

  // Step 2: Estimate tokens using simplified character-to-token ratio
  // Most LLM tokenizers approximate 1 token per 4 characters
  // This is a rough but reasonable heuristic for budget planning
  const estimatedTokens = textContent.length / 4;

  // Step 3: Round up the result to ensure conservative budget estimates
  // Math.ceil() ensures we never underestimate token cost when budgeting
  // Example: "hello" = 5 chars / 4 = 1.25 tokens → rounded to 2 tokens
  return Math.ceil(estimatedTokens);
};

/**
 * <Summary>
 * What it does:
 *   Tokenises a task string into a deduped lowercase keyword set with language
 *   and task-type tags when detected.
 *
 * How it does it (step by step):
 *   1. Convert task text to lowercase for case-insensitive matching.
 *   2. Split into word tokens using regex (preserving programming symbols).
 *   3. Create output Set to accumulate unique keywords (auto-deduplicates).
 *   4. Filter and add general keywords (skip short words and filler words).
 *   5. Match language/framework hints and add their tags.
 *   6. Match task type words and add them to the set.
 *   7. Return the deduplicated set of all keywords found.
 *
 * Parameters:
 *   @param taskText - Raw user task (may have mixed case, punctuation).
 *   @param languageHints - Rows from user-data/language-hints.json.
 *
 * Returns:
 *   @returns Keywords for overlap scoring against preference rules.
 * </Summary>
 */
export const extractKeywords = (
  taskText: string,
  languageHints: LanguageHint[],
): Set<string> => {
  // Step 1: Convert task text to lowercase for case-insensitive matching
  // Allows "TypeScript", "typescript", "TYPESCRIPT" to all match the same rules
  // Example: "Refactor TypeScript+React code" → "refactor typescript+react code"
  const lowercaseTaskText = taskText.toLowerCase();

  // Step 2: Split into word tokens using regex pattern
  // Pattern /[^a-z0-9+#]+/g means "split on anything NOT in [a-z0-9+#]"
  // This preserves programming symbols: C++, C#, TypeScript+React
  // Removes punctuation and whitespace as delimiters
  // Example: "Refactor TypeScript+React code" → ["refactor", "typescript+react", "code"]
  const wordTokens = lowercaseTaskText.split(/[^a-z0-9+#]+/g);

  // Step 3: Create output Set to accumulate unique keywords
  // Set automatically deduplicates; if "test" appears twice, stored only once
  // This prevents bias from keywords that appear multiple times
  const extractedKeywords = new Set<string>();

  // Step 4a: Filter and add general keywords from word tokens
  for (const wordToken of wordTokens) {
    // Step 4a-i: Skip very short words (noise filtering)
    // Words < 3 characters like "a", "to", "is" are too generic
    // They don't help identify task type or programming language
    if (wordToken.length < 3) {
      continue;
    }

    // Step 4a-ii: Skip common filler words
    // HIGHLIGHT_WORDS contains: "the", "and", "for", "with", "is", "are", etc.
    // These grammatical words don't indicate task type or domain
    if (HIGHLIGHT_WORDS.has(wordToken)) {
      continue;
    }

    // Step 4a-iii: Add the meaningful keyword to the set
    // Example keywords: "refactor", "typescript", "react", "component", "login"
    extractedKeywords.add(wordToken);
  }

  // Step 5: Match language/framework hints and add their tags
  // LanguageHints are from user-data/language-hints.json
  // Each hint: { needle: "typescript", tag: "typescript" } or { needle: "c++", tag: "cpp" }
  for (const { needle: searchNeedle, tag: topicTag } of languageHints) {
    // Step 5a: Check if the hint's search term appears anywhere in the task
    // Example: if hint.needle = "typescript", check if lowercaseTaskText contains "typescript"
    if (lowercaseTaskText.includes(searchNeedle.toLowerCase())) {
      // Step 5b: Add the topic tag to allow rule matching
      // Tags are usually the language/framework name in lowercase
      // This enables rules tagged with "typescript" to match this task
      extractedKeywords.add(topicTag);
    }
  }

  // Step 6: Match task type words and add them to the set
  // TASK_TYPE_WORDS contains: "refactor", "fix", "add", "test", "debug", "implement", etc.
  for (const taskTypeWord of TASK_TYPE_WORDS) {
    // Step 6a: Check if task type word appears anywhere in the task text
    // These indicate the kind of work being requested
    if (lowercaseTaskText.includes(taskTypeWord)) {
      // Step 6b: Add the task type word
      // This enables rules tagged with "refactor" to match refactoring tasks
      extractedKeywords.add(taskTypeWord);
    }
  }

  // Step 7: Return the deduplicated set of all keywords found
  // This set is used in ContextBuilder.build() to find matching preference rules
  // Example: { "refactor", "login", "component", "typescript", "react" }
  return extractedKeywords;
};

/**
 * <Summary>
 * What it does:
 *   Resolves context window tokens from Ollama model metadata with a fallback chain.
 *
 * How it does it (step by step):
 *   1. Check for top-level context_length property (most direct case).
 *   2. Validate it's a positive finite number.
 *   3. If top-level found, convert to integer and return immediately.
 *   4. Fallback: Search nested model_info object for *context_length keys.
 *   5. Verify model_info exists and is an object.
 *   6. Iterate through all properties looking for keys ending with "context_length".
 *   7. If nested context_length found, convert to integer and return.
 *   8. Final fallback: Return DEFAULT_CONTEXT_WINDOW (128k) when nothing available.
 *
 * Parameters:
 *   @param ollamaModelInfo - Parsed /api/show response from Ollama.
 *
 * Returns:
 *   @returns Context length in tokens (always positive).
 * </Summary>
 */
export const resolveContextLength = (ollamaModelInfo: ModelInfo): number => {
  // Step 1-2: Try to extract context_length from top-level of response
  // This is the most direct/common case from Ollama API
  // Validate three conditions:
  //   - typeof ollamaModelInfo.context_length === "number" (is it a number type?)
  //   - Number.isFinite(ollamaModelInfo.context_length) (not NaN or Infinity?)
  //   - ollamaModelInfo.context_length > 0 (is it a positive value?)
  if (
    typeof ollamaModelInfo.context_length === "number" &&
    Number.isFinite(ollamaModelInfo.context_length) &&
    ollamaModelInfo.context_length > 0
  ) {
    // Step 3: If top-level found, convert to integer and return immediately
    // Math.floor() removes any decimal places (e.g., 8192.5 → 8192)
    // Return early to avoid unnecessary nested searches
    return Math.floor(ollamaModelInfo.context_length);
  }

  // Step 4-5: Fallback to nested model_info object
  // Some Ollama models store metadata nested inside a model_info property
  // Example: { model_info: { "llama2.context_length": 4096 } }
  const nestedModelInfo = ollamaModelInfo.model_info;

  // Step 5: Verify model_info exists and is an object
  // Check both existence (truthy) and type (must be object)
  // This prevents errors when trying to iterate non-objects
  if (nestedModelInfo && typeof nestedModelInfo === "object") {
    // Step 6: Iterate through all properties of nested model_info
    // Object.entries() returns [[key, value], [key, value], ...]
    // This allows us to search all properties for context_length patterns
    for (const [propertyKey, propertyValue] of Object.entries(
      nestedModelInfo,
    )) {
      // Step 6a: Check if property key ends with "context_length"
      // This matches: "context_length", "llama2.context_length", "model.context_length", etc.
      // Flexible matching handles different Ollama model formats
      // Step 6b: Validate the value is a positive finite number (same checks as top-level)
      if (
        propertyKey.endsWith("context_length") &&
        typeof propertyValue === "number" &&
        Number.isFinite(propertyValue) &&
        propertyValue > 0
      ) {
        // Step 7: If nested context_length found, convert to integer and return
        // Math.floor() ensures consistent integer result
        return Math.floor(propertyValue);
      }
    }
  }

  // Step 8: Final fallback when nothing found in response
  // Return hardcoded 128k tokens if all extraction attempts failed
  // This ensures the system always has SOME budget instead of crashing
  // 128k is a conservative estimate for most modern LLMs
  // Used as default when Ollama model metadata is missing or incomplete
  return DEFAULT_CONTEXT_WINDOW;
};

/**
 * <Summary>
 * What it does:
 *   Sorts preference rules by popularity (usage frequency) then creation time.
 *
 * How it does it (step by step):
 *   1. Create shallow copy of input array to avoid mutation.
 *   2. Compare rules pairwise using sort comparator function.
 *   3. Primary sort: rules with higher timesApplied come first (descending order).
 *   4. Tiebreaker: if usage counts are equal, sort by timestamp ascending (older first).
 *   5. Return new sorted array with original unchanged.
 *
 * Parameters:
 *   @param rules - Unsorted preference rules to prioritize.
 *
 * Returns:
 *   @returns New sorted array (original unmodified).
 *
 * Note:
 *   Stable sort by creation date ensures predictable ordering when frequencies match.
 *   Most-used rules appear first; within same usage level, older rules come first.
 * </Summary>
 */
export const sortRules = (rules: PreferenceRule[]): PreferenceRule[] => {
  // Step 1: Create shallow copy of input array
  // [...rules] spreads all elements into a new array reference
  // Calling .sort() on the copy prevents mutating the original input parameter
  // Example: sortRules([rule1, rule2]) returns new array; original unaffected
  return [...rules].sort((firstRule, secondRule) => {
    // Step 2: Compare usage frequency (timesApplied count)
    // Check if the two rules have different usage counts before falling back to date
    if (secondRule.timesApplied !== firstRule.timesApplied) {
      // Step 3: Primary sort by usage frequency descending (higher count = higher priority)
      // Calculation: secondRule.timesApplied - firstRule.timesApplied
      // Positive result: secondRule sorts before firstRule (secondRule used more often, more proven)
      // Negative result: firstRule sorts before secondRule (firstRule used more often, more proven)
      // Example: secondRule=5 uses, firstRule=2 uses → return 3 (positive, secondRule comes first)
      // Example: secondRule=1 use,  firstRule=4 uses → return -3 (negative, firstRule comes first)
      // This ensures most-frequently-applied rules get included in the context first
      return secondRule.timesApplied - firstRule.timesApplied;
    }

    // Step 4: Tiebreaker: sort by creation time ascending (older rules first)
    // Only reaches here if both rules have identical timesApplied counts
    // localeCompare() performs lexicographic (date-string) comparison
    // Returns: -1 (firstRule earlier), 0 (equal), or 1 (firstRule later)
    // Example: firstRule.timestamp="2025-01-01", secondRule.timestamp="2025-01-05"
    //          "2025-01-01".localeCompare("2025-01-05") = -1 (firstRule sorts first)
    // This ensures FIFO-like ordering as tiebreaker for reproducible results
    return firstRule.timestamp.localeCompare(secondRule.timestamp);
  });
};
