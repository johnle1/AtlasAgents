/**
 * Helper functions for text processing and similarity comparison.
 *
 * @remarks
 * Provides utilities for tokenizing text, calculating Jaccard similarity,
 * and extracting JSON arrays from agent/LLM responses. Used by
 * {@link PreferenceManager} for rule deduplication and consolidation.
 */

import { STOP_WORDS } from "./preferenceConstants.js";

/**
 * Tokenizes text into meaningful words for similarity comparison.
 *
 * @param text - Input text to tokenize
 * @returns Set of meaningful word tokens (deduped, no stop words or short words)
 *
 * @remarks
 * Filters for tokens ≥ 3 characters and excludes stop words (the, and, is, etc.).
 * Preserves technical symbols (C++, C#) by splitting on non-alphanumeric except +#.
 * Case-insensitive. Returns as Set for O(1) lookup and automatic deduplication.
 *
 * @example
 * ```ts
 * tokenise("Use TypeScript for debugging") // Set(3) {"use", "typescript", "debugging"}
 * ```
 */
export const tokenise = (text: string): Set<string> => {
  // Split on non-alphanumeric (except +# for C++, C#); filter noise and stop words
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/g)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return new Set(words);
};

/**
 * Calculates Jaccard similarity between two text strings.
 *
 * @param textA - First text string
 * @param textB - Second text string
 * @returns Jaccard similarity coefficient (0–1, where 1 = identical tokens)
 *
 * @remarks
 * **Algorithm:** Jaccard = |A ∩ B| / |A ∪ B| (shared tokens / unique tokens).
 * Both empty strings return 1 (identical). One empty returns 0 (no similarity).
 *
 * Used by {@link PreferenceManager.add} to deduplicate rules via text similarity ≥ 0.8.
 *
 * @example
 * ```ts
 * textSimilarity("Use TypeScript", "Use TypeScript") // 1
 * textSimilarity("Use TypeScript", "Use Python")     // 0.5
 * textSimilarity("Use TypeScript", "Python")         // 0
 * ```
 */
export const textSimilarity = (textA: string, textB: string): number => {
  const tokenSetA = tokenise(textA);
  const tokenSetB = tokenise(textB);

  // Edge cases: both empty = identical; one empty = no similarity
  if (tokenSetA.size === 0 && tokenSetB.size === 0) {
    return 1;
  }
  if (tokenSetA.size === 0 || tokenSetB.size === 0) {
    return 0;
  }

  // Count shared tokens (intersection)
  let intersectionCount = 0;
  for (const word of tokenSetA) {
    if (tokenSetB.has(word)) {
      intersectionCount += 1;
    }
  }

  // Union = |A| + |B| - |A ∩ B|
  const unionSize = tokenSetA.size + tokenSetB.size - intersectionCount;

  // Return Jaccard index
  return unionSize === 0 ? 0 : intersectionCount / unionSize;
};

/**
 * Extracts a JSON array string from a raw agent/LLM response.
 *
 * @param raw - Raw text returned by the agent/LLM
 * @returns Extracted JSON array string (or full body if not found)
 *
 * @remarks
 * **Process:**
 * 1. Unwraps markdown code fences (```json ... ```)
 * 2. Finds outermost `[` and `]` in the body
 * 3. Returns substring between brackets, or full body if not found
 *
 * Handles agents that wrap JSON in markdown, leading/trailing whitespace,
 * and relaxes to return full body if brackets not found (lets caller handle
 * parse errors). Used by {@link PreferenceManager.consolidate}.
 *
 * @example
 * ```ts
 * extractJsonArray("```json\n[{...}]\n```")  // "[{...}]"
 * extractJsonArray("[{...}]")                 // "[{...}]"
 * extractJsonArray("some text [{...}]")       // "[{...}]"
 * ```
 */
export const extractJsonArray = (raw: string): string => {
  const trimmedResponse = raw.trim();

  // Unwrap markdown code fences (```json ... ``` or ``` ... ```)
  const codeFenceMatch = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/i.exec(
    trimmedResponse,
  );
  const extractedBody = codeFenceMatch
    ? codeFenceMatch[1].trim()
    : trimmedResponse;

  // Find outermost array brackets
  const arrayStartIndex = extractedBody.indexOf("[");
  const arrayEndIndex = extractedBody.lastIndexOf("]");

  // Return bracketed substring if found, else return full body
  if (
    arrayStartIndex !== -1 &&
    arrayEndIndex !== -1 &&
    arrayEndIndex > arrayStartIndex
  ) {
    return extractedBody.slice(arrayStartIndex, arrayEndIndex + 1);
  }

  return extractedBody;
};
