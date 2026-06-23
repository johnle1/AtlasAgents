/**
 * <Summary>
 * What it does:
 *   Helper functions for text processing and similarity comparison.
 *
 * How it fits in the system:
 *   Provides utility functions for tokenizing text, calculating similarity,
 *   and extracting JSON arrays from advisor responses.
 * </Summary>
 */

import { STOP_WORDS } from "./preferenceConstants.js";

/**
 * <Summary>
 * What it does:
 *   Tokenizes text into meaningful words for similarity comparison.
 *
 * How it does it (step by step):
 *   1. Convert text to lowercase for case-insensitive comparison.
 *   2. Split on non-alphanumeric characters to extract words.
 *   3. Filter out short words (< 3 chars) and stop words.
 *   4. Return as Set for efficient lookup and deduplication.
 *
 * Parameters:
 *   @param text - Input text to tokenize.
 *
 * Returns:
 *   @returns Set of meaningful word tokens.
 * </Summary>
 */
export const tokenise = (text: string): Set<string> => {
  // Step 1: Convert text to lowercase for case-insensitive comparison
  // This ensures "TypeScript" and "typescript" are treated the same
  // Step 2: Split on non-alphanumeric characters to extract words
  // We preserve + and # as they're meaningful in technical terms (C++, C#, etc.)
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/g)
    // Step 3: Filter out short words (< 3 chars) and stop words
    // Short words are usually noise (e.g., "a", "an", "in")
    // Stop words are common words that don't add meaning (e.g., "the", "and", "is")
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  // Step 4: Return as Set for efficient lookup and deduplication
  // Sets automatically remove duplicates and provide O(1) lookup performance
  return new Set(words);
};

/**
 * <Summary>
 * What it does:
 *   Calculates Jaccard similarity between two text strings using token sets.
 *
 * How it does it (step by step):
 *   1. Tokenize both texts into sets of meaningful words.
 *   2. Handle edge cases for empty sets (both empty = identical, one empty = no similarity).
 *   3. Count intersection (tokens present in both sets).
 *   4. Calculate union size (unique tokens across both sets).
 *   5. Return Jaccard index (intersection / union).
 *
 * Parameters:
 *   @param textA - First text string.
 *   @param textB - Second text string.
 *
 * Returns:
 *   @returns Jaccard similarity (0-1, where 1 = identical).
 * </Summary>
 */
export const textSimilarity = (textA: string, textB: string): number => {
  // Step 1: Tokenize both texts into sets of meaningful words
  // Converting to sets allows efficient set operations
  const tokenSetA = tokenise(textA);
  const tokenSetB = tokenise(textB);

  // Step 2: Handle edge cases for empty sets
  // Both empty = considered identical (both have no meaningful content)
  // This is a reasonable assumption for empty strings
  if (tokenSetA.size === 0 && tokenSetB.size === 0) {
    return 1;
  }
  // One empty = no similarity (one has content, other doesn't)
  // Empty vs non-empty should have zero similarity
  if (tokenSetA.size === 0 || tokenSetB.size === 0) {
    return 0;
  }

  // Step 3: Count intersection (tokens present in both sets)
  // Intersection represents shared vocabulary between the two texts
  let intersectionCount = 0;
  for (const word of tokenSetA) {
    if (tokenSetB.has(word)) {
      intersectionCount += 1;
    }
  }

  // Step 4: Calculate union size (unique tokens across both sets)
  // Union represents total unique vocabulary across both texts
  // Formula: |A ∪ B| = |A| + |B| - |A ∩ B|
  const unionSize = tokenSetA.size + tokenSetB.size - intersectionCount;

  // Step 5: Return Jaccard index (intersection / union)
  // Jaccard similarity = |A ∩ B| / |A ∪ B|
  // Returns 0 if union is 0 (shouldn't happen given earlier checks)
  return unionSize === 0 ? 0 : intersectionCount / unionSize;
};

/**
 * <Summary>
 * What it does:
 *   Extracts a JSON array string from a raw advisor/LLM response.
 *
 * How it does it (step by step):
 *   1. Trim surrounding whitespace from the raw response.
 *   2. Attempt to capture a fenced code block (```json or ```).
 *   3. If fenced block found, use its inner contents; otherwise use trimmed text.
 *   4. Find the first '[' and last ']' in the body.
 *   5. If both brackets exist and end > start, return the substring.
 *   6. Otherwise, return the full body for caller to handle.
 *
 * Parameters:
 *   @param raw - Raw text returned by the advisor/LLM.
 *
 * Returns:
 *   @returns Extracted JSON array text (or original body if not found).
 * </Summary>
 */
export const extractJsonArray = (raw: string): string => {
  // Step 1: Trim surrounding whitespace from the raw response
  // LLM responses often have leading/trailing whitespace that interferes with parsing
  const trimmedResponse = raw.trim();

  // Step 2: Attempt to capture a fenced code block (```json or ```)
  // The regex is non-greedy and captures content between fences
  // Handles both ```json and ``` formats, case-insensitive
  const codeFenceMatch = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/i.exec(
    trimmedResponse,
  );

  // Step 3: If fenced block found, use its inner contents; otherwise use trimmed text
  // LLMs often wrap JSON in code blocks for formatting, so we extract the inner content
  const extractedBody = codeFenceMatch
    ? codeFenceMatch[1].trim()
    : trimmedResponse;

  // Step 4: Find the first '[' and last ']' in the body
  // This is a pragmatic way to extract the outermost JSON array in the body
  const arrayStartIndex = extractedBody.indexOf("[");
  const arrayEndIndex = extractedBody.lastIndexOf("]");

  // Step 5: If both brackets exist and end > start, return the substring
  // This returns a string like "[ {...}, {...} ]" which callers can parse
  if (
    arrayStartIndex !== -1 &&
    arrayEndIndex !== -1 &&
    arrayEndIndex > arrayStartIndex
  ) {
    return extractedBody.slice(arrayStartIndex, arrayEndIndex + 1);
  }

  // Step 6: Otherwise, return the full body for caller to handle
  // This is safer than throwing an error - let the caller decide how to handle it
  return extractedBody;
};
