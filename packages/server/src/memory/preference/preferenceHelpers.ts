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
 * Calculates Jaccard similarity between two pre-tokenized word sets.
 *
 * @param tokenSetA - First token set (from {@link tokenise})
 * @param tokenSetB - Second token set (from {@link tokenise})
 * @returns Jaccard similarity coefficient (0–1, where 1 = identical tokens)
 *
 * @remarks
 * **Algorithm:** Jaccard = |A ∩ B| / |A ∪ B| (shared tokens / unique tokens).
 * Both empty sets return 1 (identical). One empty returns 0 (no similarity).
 * Iterates the smaller set for the intersection so cost is O(min(|A|,|B|))
 * rather than always O(|A|).
 *
 * Split out from {@link textSimilarity} so callers that already hold cached
 * token sets (e.g. an inverted-index similarity search) don't re-tokenize
 * the same text on every comparison.
 *
 * @example
 * ```ts
 * jaccardFromTokenSets(tokenise("Use TypeScript"), tokenise("Use TypeScript")) // 1
 * jaccardFromTokenSets(tokenise("Use TypeScript"), tokenise("Use Python"))     // 0.5
 * ```
 */
export const jaccardFromTokenSets = (
  tokenSetA: Set<string>,
  tokenSetB: Set<string>,
): number => {
  // Edge cases: both empty = identical; one empty = no similarity
  if (tokenSetA.size === 0 && tokenSetB.size === 0) {
    return 1;
  }
  if (tokenSetA.size === 0 || tokenSetB.size === 0) {
    return 0;
  }

  // Count shared tokens (intersection), iterating the smaller set
  const [smaller, larger] =
    tokenSetA.size <= tokenSetB.size ? [tokenSetA, tokenSetB] : [tokenSetB, tokenSetA];
  let intersectionCount = 0;
  for (const word of smaller) {
    if (larger.has(word)) {
      intersectionCount += 1;
    }
  }

  // Union = |A| + |B| - |A ∩ B|
  const unionSize = tokenSetA.size + tokenSetB.size - intersectionCount;

  // Return Jaccard index
  return unionSize === 0 ? 0 : intersectionCount / unionSize;
};

/**
 * Calculates Jaccard similarity between two text strings.
 *
 * @param textA - First text string
 * @param textB - Second text string
 * @returns Jaccard similarity coefficient (0–1, where 1 = identical tokens)
 *
 * @remarks
 * Tokenizes both strings and delegates to {@link jaccardFromTokenSets}.
 * Used by {@link PreferenceManager.add} to deduplicate rules via text similarity ≥ 0.8.
 *
 * @example
 * ```ts
 * textSimilarity("Use TypeScript", "Use TypeScript") // 1
 * textSimilarity("Use TypeScript", "Use Python")     // 0.5
 * textSimilarity("Use TypeScript", "Python")         // 0
 * ```
 */
export const textSimilarity = (textA: string, textB: string): number =>
  jaccardFromTokenSets(tokenise(textA), tokenise(textB));

/**
 * Checks whether a candidate token-set size could possibly reach a Jaccard
 * similarity threshold against a target token-set size, without computing
 * the actual intersection.
 *
 * @param candidateSize - Token count of the candidate set being tested
 * @param targetSize - Token count of the set being matched against
 * @param threshold - Minimum Jaccard similarity required (e.g. 0.8)
 * @returns `false` if similarity ≥ `threshold` is mathematically impossible
 *   for these sizes; `true` if it's still possible (does not guarantee it)
 *
 * @remarks
 * For J(A,B) ≥ t to hold, |B| must fall within
 * `[ceil(t·|A|), floor(|A|/t)]` — derived from `|A∩B| ≤ min(|A|,|B|)` and
 * `J = |A∩B| / (|A|+|B|-|A∩B|)`. Used as an O(1) pre-filter before the O(n)
 * exact {@link jaccardFromTokenSets} check, so an inverted-index similarity
 * search can discard most candidates without touching their token sets.
 *
 * @example
 * ```ts
 * passesLengthFilter(10, 3, 0.8)  // false — 3 is too small to reach 0.8 vs 10
 * passesLengthFilter(9, 10, 0.8)  // true — worth an exact check
 * ```
 */
export const passesLengthFilter = (
  candidateSize: number,
  targetSize: number,
  threshold: number,
): boolean => {
  if (targetSize === 0) {
    return candidateSize === 0;
  }
  const minSize = Math.ceil(threshold * targetSize);
  const maxSize = Math.floor(targetSize / threshold);
  return candidateSize >= minSize && candidateSize <= maxSize;
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
