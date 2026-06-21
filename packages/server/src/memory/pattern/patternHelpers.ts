/**
 * <Summary>
 * What it does:
 *   Helper functions for pattern extraction including JSON parsing, text truncation,
 *   diff formatting, keyword extraction, and confidence parsing.
 *
 * How it fits in the system:
 *   Provides utility functions for processing experience records and extracting
 *   preference rules.
 *
 * Dependencies:
 *   - patternConstants.ts - uses budget constants.
 *   - @loopycode/shared - computeDiff, formatDiffPlain.
 *   - orchestration/interfaces.js - PreferenceConfidence.
 *   - types.js - UserEditEntry.
 *
 * Dependants:
 *   - patternExtractor.ts - uses these helpers in the PatternExtractor class.
 * </Summary>
 */

import * as path from "node:path";

import type { PreferenceConfidence } from "../../orchestration/interfaces.js";
import { computeDiff, formatDiffPlain } from "@loopycode/shared";
import type { UserEditEntry } from "../types.js";
import {
  MAX_USER_EDITS_IN_PROMPT,
  USER_EDIT_DIFF_BUDGET,
} from "./patternConstants.js";

/**
 * <Summary>
 * What it does:
 *   Extracts a JSON array string from a raw advisor/LLM response. The
 *   assistant may return the array either raw or wrapped inside a Markdown
 *   code fence (optionally labeled "json"). This helper returns the
 *   substring that looks like a JSON array (including brackets) so callers
 *   can safely `JSON.parse()` it.
 *
 * How it does it (step by step):
 *   1. Trim surrounding whitespace from the raw response.
 *   2. Attempt to capture the first fenced code block using a regex that
 *      accepts an optional "json" language label.
 *   3. If a fenced block is found, use its inner contents as the body;
 *      otherwise use the trimmed raw text.
 *   4. Find the first `[` and the last `]` in the body.
 *   5. If both brackets exist and the end index is after the start index,
 *      return the substring from `[` to `]` inclusive (the JSON array).
 *   6. If a plausible array can't be located, return the full body so the
 *      caller can still attempt to parse or log the raw response.
 *
 * Parameters:
 *   @param {string} raw — Raw text returned by the advisor/LLM.
 *
 * Returns:
 *   {string} — The extracted JSON array text (or the original body if no
 *   well-formed array boundaries were found).
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - PatternExtractor.run — parses advisor response for preference rules.
 * </Summary>
 */
export const extractJsonArray = (raw: string): string => {
  // Step 1: Trim surrounding whitespace/newlines
  // LLM responses often have leading/trailing whitespace that interferes with parsing
  const trimmedResponse = raw.trim();

  // Step 2: Try to capture a fenced code block. Supports both ```json and ```
  // The regex is non-greedy and captures content between fences
  // Handles both ```json and ``` formats, case-insensitive
  const codeFenceMatch = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/i.exec(
    trimmedResponse,
  );

  // Step 3: Prefer the fenced block content when present, otherwise use raw
  // LLMs often wrap JSON in code blocks for formatting, so we extract the inner content
  const extractedBody = codeFenceMatch
    ? codeFenceMatch[1].trim()
    : trimmedResponse;

  // Step 4: Locate the first opening bracket and the last closing bracket.
  // This is a pragmatic way to extract the outermost JSON array in the body.
  // We use first/last to handle cases where the array contains nested arrays
  const arrayStartIndex = extractedBody.indexOf("[");
  const arrayEndIndex = extractedBody.lastIndexOf("]");

  // Step 5: If a matching pair of brackets exists and the end comes after
  // the start, slice out that range (include the closing bracket). This
  // returns a string like "[ {...}, {...} ]" which callers can parse.
  if (
    arrayStartIndex !== -1 &&
    arrayEndIndex !== -1 &&
    arrayEndIndex > arrayStartIndex
  ) {
    return extractedBody.slice(arrayStartIndex, arrayEndIndex + 1);
  }

  // Step 6: Fallback — return the full body so caller can decide how to
  // handle malformed or unexpected responses (logging, retries, etc.).
  // This is safer than throwing an error - let the caller decide how to handle it
  return extractedBody;
};

/**
 * <Summary>
 * What it does:
 *   Truncates a string to a maximum length and appends an ellipsis when
 *   the text is longer than the allowed maximum.
 *
 * How it does it (step by step):
 *   1. Check if `text.length` is less than or equal to `max`.
 *   2. If yes, return the original `text` untouched.
 *   3. Otherwise, take the first `max` characters and append `…`.
 *
 * Parameters:
 *   @param {string} text — Input string to trim.
 *   @param {number} max — Maximum allowed length before truncation.
 *
 * Returns:
 *   {string} — Either the original text (if short) or a truncated version
 *   with a trailing ellipsis.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - Logging and user-visible message formatting elsewhere in the module.
 *   - plainDiffFromEdit — truncates diff output to budget.
 *   - PatternExtractor.run — truncates escalation reasons, guidance, and diffs.
 * </Summary>
 */
export const truncate = (text: string, max: number): string => {
  // Step 1: If the text already fits, return it directly.
  // No truncation needed, avoid unnecessary processing
  if (text.length <= max) {
    return text;
  }

  // Step 2: Otherwise return the prefix + ellipsis to indicate truncation.
  // We use a single unicode ellipsis character (…) rather than "..." for cleaner output
  return `${text.slice(0, max)}…`;
};

/**
 * <Summary>
 * What it does:
 *   Builds a plain-text line diff from before/after file contents for prompts.
 *
 * How it does it (step by step):
 *   1. Run computeDiff on before and after strings.
 *   2. Format with formatDiffPlain (no ANSI colors).
 *   3. Truncate to max length when provided.
 *
 * Parameters:
 *   @param {string} before — Content before edit.
 *   @param {string} after — Content after edit.
 *   @param {string} filePath — Path for optional header in diff output.
 *   @param {number} [maxLen] — Optional character budget; omit for full diff.
 *
 * Returns:
 *   @returns {string} — Plain diff text.
 *
 * Dependencies:
 *   - @loopycode/shared/computeDiff — computes diff chunks.
 *   - @loopycode/shared/formatDiffPlain — formats diff as plain text.
 *   - truncate — limits output length when maxLen is provided.
 *
 * Dependants:
 *   - formatUserEditForPrompt — creates formatted edit blocks for prompts.
 *   - PatternExtractor.run — generates style rule diff snippets.
 * </Summary>
 */
export const plainDiffFromEdit = (
  before: string,
  after: string,
  filePath: string,
  maxLen?: number,
): string => {
  // Step 1: Compute diff chunks between before and after content
  // computeDiff returns an array of diff operations (insertions, deletions, unchanged)
  const diffChunks = computeDiff(before, after);

  // Step 2: Format the diff chunks as plain text (no ANSI colors)
  // formatDiffPlain adds the file path header and uses +/- prefixes for changes
  const plainDiffText = formatDiffPlain(diffChunks, filePath);

  // Step 3: Truncate to max length when provided
  // If no maxLen is specified, return the full diff
  if (maxLen === undefined) {
    return plainDiffText;
  }
  // Otherwise truncate to fit within the character budget
  return truncate(plainDiffText, maxLen);
};

/**
 * <Summary>
 * What it does:
 *   Formats one user edit as a prompt line with a plain diff (not before/after slices).
 *
 * How it does it (step by step):
 *   1. Generate a plain diff from the edit's before/after content.
 *   2. Format as a bullet point with the file path and indented diff lines.
 *
 * Parameters:
 *   @param {UserEditEntry} edit — User edit row from the experience record.
 *
 * Returns:
 *   @returns {string} — Multi-line block for the advisor prompt.
 *
 * Dependencies:
 *   - plainDiffFromEdit — generates the diff text.
 *   - USER_EDIT_DIFF_BUDGET — limits diff length.
 *
 * Dependants:
 *   - PatternExtractor.run — creates editBlock for advisor prompt.
 * </Summary>
 */
export const formatUserEditForPrompt = (edit: UserEditEntry): string => {
  // Step 1: Generate a plain diff from the edit's before/after content
  // We use USER_EDIT_DIFF_BUDGET to keep each edit's diff concise
  const diffText = plainDiffFromEdit(
    edit.before,
    edit.after,
    edit.path,
    USER_EDIT_DIFF_BUDGET,
  );

  // Step 2: Format as a bullet point with the file path and indented diff lines
  // The format is: "- filepath\n  Diff:\n    line 1\n    line 2\n    ..."
  // This creates a clean, readable structure for the advisor prompt
  return `- ${edit.path}\n  Diff:\n${diffText
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")}`;
};

/**
 * <Summary>
 * What it does:
 *   Limits user edits included in the advisor prompt to avoid huge prompts.
 *
 * How it does it (step by step):
 *   1. If total edits fit within the limit, return all edits.
 *   2. Otherwise, return only the first MAX_USER_EDITS_IN_PROMPT edits
 *      and report how many were omitted.
 *
 * Parameters:
 *   @param {UserEditEntry[]} edits — All user edits on the record.
 *
 * Returns:
 *   @returns {{ edits: UserEditEntry[]; omitted: number }} — Sample and omit count.
 *
 * Dependencies:
 *   - MAX_USER_EDITS_IN_PROMPT — defines the sampling limit.
 *
 * Dependants:
 *   - PatternExtractor.run — samples edits before building advisor prompt.
 * </Summary>
 */
export const sampleUserEdits = (
  edits: UserEditEntry[],
): { edits: UserEditEntry[]; omitted: number } => {
  // Step 1: If total edits fit within the limit, return all edits
  // No sampling needed when the total is manageable
  if (edits.length <= MAX_USER_EDITS_IN_PROMPT) {
    return { edits, omitted: 0 };
  }

  // Step 2: Otherwise, return only the first MAX_USER_EDITS_IN_PROMPT edits
  // and report how many were omitted for transparency
  // We take the first N edits as a representative sample
  return {
    edits: edits.slice(0, MAX_USER_EDITS_IN_PROMPT),
    omitted: edits.length - MAX_USER_EDITS_IN_PROMPT,
  };
};

/**
 * <Summary>
 * What it does:
 *   Determines a language scope string from a file path's extension. This
 *   maps common file extensions to higher-level language identifiers used
 *   for scoping preference rules.
 *
 * How it does it (step by step):
 *   1. Extract the file extension using `path.extname` and normalize to
 *      lower-case.
 *   2. Look up the extension in a predefined `map` from extensions to
 *      language scope strings.
 *   3. If the extension is unknown, return the fallback scope `all`.
 *
 * Parameters:
 *   @param {string} filePath — The path to the file whose language should
 *   be determined.
 *
 * Returns:
 *   {string} — A scope identifier such as `typescript`, `python`, or `all`.
 *
 * Dependencies:
 *   - node:path — for extracting file extensions.
 *
 * Dependants:
 *   - topicsFromPath — uses scope for topic generation.
 *   - PatternExtractor.run — scopes style preference rules by language.
 * </Summary>
 */
export const scopeFromPath = (filePath: string): string => {
  // Step 1: Extract the extension and normalize to lower-case
  // path.extname returns the extension including the dot (e.g., ".ts")
  // Normalizing to lower-case ensures case-insensitive matching
  const fileExtension = path.extname(filePath).toLowerCase();

  // Step 2: Map common extensions to language scopes
  // This map covers the most common programming languages and frameworks
  // Extensions that map to the same language are grouped (e.g., .ts and .tsx both map to typescript)
  const extensionToScopeMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".c": "c",
    ".swift": "swift",
    ".kt": "kotlin",
  };

  // Step 3: Return mapped scope or fallback to 'all'
  // If the extension is not in our map, we return 'all' to indicate the rule applies globally
  // This is a safe default that ensures rules don't get lost for unknown file types
  return extensionToScopeMap[fileExtension] ?? "all";
};

/**
 * <Summary>
 * What it does:
 *   Produces a list of topic strings derived from a file path. For now this
 *   is a thin wrapper that returns the language scope (unless it's `all`).
 *
 * How it does it (step by step):
 *   1. Call `scopeFromPath` to determine the language scope for `filePath`.
 *   2. If the scope is `all`, return an empty array (no specific topics).
 *   3. Otherwise return an array containing the single scope string.
 *
 * Parameters:
 *   @param {string} filePath — File path used to derive topics.
 *
 * Returns:
 *   {string[]} — Array of topic strings (commonly a single language scope).
 *
 * Dependencies:
 *   - scopeFromPath — determines the language scope from file path.
 *
 * Dependants:
 *   - Creation of `style` preference rules that tag rules with topics.
 *   - PatternExtractor.run — generates topics for fix and style rules.
 * </Summary>
 */
export const topicsFromPath = (filePath: string): string[] => {
  // Step 1: Get the language scope
  // scopeFromPath returns a language identifier like "typescript" or "all"
  const languageScope = scopeFromPath(filePath);

  // Step 2: Return either an empty list for 'all' or the single-topic array
  // If the scope is "all", we return an empty array because "all" isn't a useful topic tag
  // Topics are meant to be specific categories like "typescript", "react", "testing", etc.
  return languageScope === "all" ? [] : [languageScope];
};

/**
 * <Summary>
 * What it does:
 *   Extracts up to eight short, lower-cased keyword tokens from an error
 *   reason string. These keywords are used as `topics` for fix rules so
 *   that errors can be matched by common words.
 *
 * How it does it (step by step):
 *   1. Normalize the input to lower-case.
 *   2. Split on any character that is not a letter, digit, `+`, or `#`.
 *   3. Filter out tokens shorter than 3 characters to avoid noise.
 *   4. Deduplicate while preserving first-seen order using `Set` and then
 *      limit the result to the first 8 tokens.
 *
 * Parameters:
 *   @param {string} reason — Human-readable error reason or message.
 *
 * Returns:
 *   {string[]} — Up to eight deduplicated keyword tokens.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - PatternExtractor.run — generates topics for fix rules from escalations.
 * </Summary>
 */
export const errorKeywords = (reason: string): string[] => {
  // Step 1 & 2: Normalize and split on non-alphanumeric/+/# characters
  // We preserve + and # as they are meaningful in error messages (e.g., C++, C#, HTTP 404)
  // Lower-casing ensures case-insensitive matching
  const keywordTokens = reason
    .toLowerCase()
    .split(/[^a-z0-9+#]+/g)
    .filter((keyword) => keyword.length >= 3); // Step 3: Remove very short tokens

  // Step 4: Deduplicate and limit to 8 entries
  // Using Set removes duplicates while preserving insertion order
  // We limit to 8 tokens to avoid overwhelming the topic system
  return [...new Set(keywordTokens)].slice(0, 8);
};

/**
 * <Summary>
 * What it does:
 *   Normalizes an untrusted `confidence` value from the advisor output into
 *   the `PreferenceConfidence` union type expected by the preference store.
 *
 * How it does it (step by step):
 *   1. Check whether `raw` strictly equals one of the accepted strings
 *      `'high'`, `'medium'`, or `'low'`.
 *   2. If so, return it unchanged (typed to `PreferenceConfidence`).
 *   3. Otherwise, fall back to the safe default `'medium'`.
 *
 * Parameters:
 *   @param {unknown} raw — The untrusted value produced by the advisor.
 *
 * Returns:
 *   {PreferenceConfidence} — One of `'high'|'medium'|'low'`.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - PatternExtractor.run — validates confidence from advisor responses.
 *   - Creating `NewPreferenceRule` objects stored in the preference store.
 * </Summary>
 */
export const parseConfidence = (raw: unknown): PreferenceConfidence => {
  // Step 1: Accept only the three explicit string values
  // We use strict equality to ensure type safety - only exact string matches are accepted
  // This prevents accidental acceptance of similar-looking values
  if (raw === "high" || raw === "medium" || raw === "low") {
    return raw;
  }

  // Step 2: Default to 'medium' for anything else (missing or malformed)
  // 'medium' is a safe default when we can't determine the intended confidence level
  // It's neither overly confident nor dismissive of the rule's validity
  return "medium";
};
