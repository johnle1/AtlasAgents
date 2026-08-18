/**
 * Helper functions for pattern extraction and rule learning.
 *
 * @remarks
 * This module provides utilities used by {@link PatternExtractor} to process
 * experience records and extract preference rules. Functions handle JSON parsing
 * from LLM responses, text truncation for token budgeting, diff formatting,
 * keyword extraction for topic categorization, and confidence normalization.
 */

import * as path from "node:path";

import type { PreferenceConfidence } from "../../orchestration/interfaces.js";
import { computeDiff, formatDiffPlain } from "@atlasagents/shared";
import type { UserEditEntry } from "../types.js";
import {
  MAX_USER_EDITS_IN_PROMPT,
  USER_EDIT_DIFF_BUDGET,
} from "./patternConstants.js";

/**
 * Extracts a JSON array string from a raw LLM response.
 *
 * @remarks
 * LLMs often return JSON wrapped in markdown code blocks (with or without
 * a "json" language label) or embedded in conversational text. This function
 * handles both formats by first extracting code block content, then locating
 * the outermost JSON array brackets to return a parseable string.
 *
 * If no well-formed array boundaries are found, returns the full body so
 * callers can log the raw response or attempt alternative parsing strategies.
 *
 * @param raw - Raw text returned by the agent/LLM.
 * @returns The extracted JSON array text, or the original body if no array boundaries were found.
 *
 * @example
 * ```ts
 * Extract from markdown-wrapped JSON
 * extractJsonArray('```json\n[{"text": "rule"}]\n```'); // "[{\"text\": \"rule\"}]"
 *
 * Extract from plain JSON
 * extractJsonArray('[{"text": "rule"}]'); // "[{\"text\": \"rule\"}]"
 *
 * Handle conversational text
 * extractJsonArray('Here are the rules: [{"text": "rule"}]'); // "[{\"text\": \"rule\"}]"
 * ```
 */
export const extractJsonArray = (raw: string): string => {
  const trimmedResponse = raw.trim();
  const codeFenceMatch = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/i.exec(
    trimmedResponse,
  );
  const extractedBody = codeFenceMatch
    ? codeFenceMatch[1].trim()
    : trimmedResponse;

  const arrayStartIndex = extractedBody.indexOf("[");
  const arrayEndIndex = extractedBody.lastIndexOf("]");

  if (
    arrayStartIndex !== -1 &&
    arrayEndIndex !== -1 &&
    arrayEndIndex > arrayStartIndex
  ) {
    return extractedBody.slice(arrayStartIndex, arrayEndIndex + 1);
  }

  return extractedBody;
};

/**
 * Truncates a string to a maximum length with an ellipsis suffix.
 *
 * @remarks
 * Used to manage token budgets when sending experience data to the agent model.
 * If the text fits within the limit, returns it unchanged. Otherwise returns
 * the first `max` characters with a Unicode ellipsis (…) appended to indicate
 * truncation.
 *
 * @param text - Input string to truncate.
 * @param max - Maximum allowed length before truncation.
 * @returns Either the original text (if short) or a truncated version with a trailing ellipsis.
 *
 * @example
 * ```ts
 * truncate("short text", 20); // "short text"
 * truncate("this is a very long string that exceeds the limit", 20); // "this is a very lo…"
 * ```
 */
export const truncate = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
};

/**
 * Builds a plain-text line diff from before/after file contents.
 *
 * @remarks
 * Computes the diff between two file contents, formats it without ANSI colors
 * (suitable for LLM prompts), and optionally truncates to a character budget.
 * Used by {@link formatUserEditForPrompt} to show user corrections in agent prompts.
 *
 * @param before - Content before the edit.
 * @param after - Content after the edit.
 * @param filePath - File path for the diff header.
 * @param maxLen - Optional character budget; if omitted, returns the full diff.
 * @returns Plain diff text with +/- line prefixes.
 *
 * @example
 * ```ts
 * plainDiffFromEdit("old line", "new line", "file.ts", 100);
 * Returns:
 * "--- a/file.ts\n+++ b/file.ts\n-old line\n+new line"
 * ```
 */
export const plainDiffFromEdit = (
  before: string,
  after: string,
  filePath: string,
  maxLen?: number,
): string => {
  const diffChunks = computeDiff(before, after);
  const plainDiffText = formatDiffPlain(diffChunks, filePath);
  if (maxLen === undefined) {
    return plainDiffText;
  }
  return truncate(plainDiffText, maxLen);
};

/**
 * Formats a user edit as a prompt block with a plain diff.
 *
 * @remarks
 * Converts a user edit record into a readable format for agent prompts.
 * Shows the file path followed by an indented diff (truncated to
 * {@link USER_EDIT_DIFF_BUDGET}). Used by {@link PatternExtractor} to
 * demonstrate user corrections when extracting style preferences.
 *
 * @param edit - User edit entry from the experience record.
 * @returns Multi-line string formatted as a bullet point with indented diff lines.
 *
 * @example
 * ```ts
 * formatUserEditForPrompt({
 *   path: "file.ts",
 *   before: "old",
 *   after: "new",
 *   timestamp: "2024-01-01T00:00:00.000Z"
 * });
 * Returns:
 * "- file.ts\n  Diff:\n    --- a/file.ts\n    +++ b/file.ts\n    -old\n    +new"
 * ```
 */
export const formatUserEditForPrompt = (edit: UserEditEntry): string => {
  const diffText = plainDiffFromEdit(
    edit.before,
    edit.after,
    edit.path,
    USER_EDIT_DIFF_BUDGET,
  );
  return `- ${edit.path}\n  Diff:\n${diffText
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")}`;
};

/**
 * Samples user edits to avoid overwhelming the agent prompt.
 *
 * @remarks
 * If the total number of edits exceeds {@link MAX_USER_EDITS_IN_PROMPT},
 * returns only the first N edits and reports how many were omitted.
 * This prevents token budget overruns while providing transparency about
 * the sampling. When the total fits within the limit, returns all edits.
 *
 * @param edits - All user edits from the experience record.
 * @returns An object containing the sampled edits and the count of omitted edits.
 *
 * @example
 * ```ts
 * When edits fit within the limit
 * sampleUserEdits([edit1, edit2]); // { edits: [edit1, edit2], omitted: 0 }
 *
 * When edits exceed the limit (assuming MAX_USER_EDITS_IN_PROMPT = 5)
 * sampleUserEdits([edit1, edit2, edit3, edit4, edit5, edit6, edit7]);
 * { edits: [edit1, edit2, edit3, edit4, edit5], omitted: 2 }
 * ```
 */
export const sampleUserEdits = (
  edits: UserEditEntry[],
): { edits: UserEditEntry[]; omitted: number } => {
  if (edits.length <= MAX_USER_EDITS_IN_PROMPT) {
    return { edits, omitted: 0 };
  }
  return {
    edits: edits.slice(0, MAX_USER_EDITS_IN_PROMPT),
    omitted: edits.length - MAX_USER_EDITS_IN_PROMPT,
  };
};

/**
 * Determines a language scope identifier from a file path's extension.
 *
 * @remarks
 * Maps common file extensions to language scope strings used for scoping
 * preference rules. For example, `.ts` and `.tsx` map to `"typescript"`,
 * `.py` maps to `"python"`. Unknown extensions fall back to `"all"` to
 * indicate the rule applies globally. Used by {@link PatternExtractor} to
 * scope style rules to specific languages.
 *
 * @param filePath - The file path whose language should be determined.
 * @returns A scope identifier such as `"typescript"`, `"python"`, or `"all"`.
 *
 * @example
 * ```ts
 * scopeFromPath("src/index.ts"); // "typescript"
 * scopeFromPath("app.py"); // "python"
 * scopeFromPath("README.md"); // "all"
 * ```
 */
export const scopeFromPath = (filePath: string): string => {
  const fileExtension = path.extname(filePath).toLowerCase();
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
  return extensionToScopeMap[fileExtension] ?? "all";
};

/**
 * Derives topic tags from a file path.
 *
 * @remarks
 * Currently a thin wrapper around {@link scopeFromPath} that returns the
 * language scope as a topic array. If the scope is `"all"`, returns an empty
 * array since `"all"` is not a useful topic tag. Topics are used to categorize
 * preference rules for matching (e.g., `"typescript"`, `"react"`, `"testing"`).
 *
 * @param filePath - File path used to derive topics.
 * @returns Array of topic strings, commonly a single language scope or empty.
 *
 * @example
 * ```ts
 * topicsFromPath("src/index.ts"); // ["typescript"]
 * topicsFromPath("app.py"); // ["python"]
 * topicsFromPath("README.md"); // []
 * ```
 */
export const topicsFromPath = (filePath: string): string[] => {
  const languageScope = scopeFromPath(filePath);
  return languageScope === "all" ? [] : [languageScope];
};

/**
 * Extracts keyword tokens from an error reason for topic categorization.
 *
 * @remarks
 * Splits an error message into meaningful keywords (3+ characters) used
 * as topic tags for fix rules. Preserves `+` and `#` symbols (e.g., "C++",
 * "C#", "HTTP 404"). Returns up to 8 deduplicated tokens in first-seen order.
 * Used by {@link PatternExtractor} to categorize escalation-based fix rules.
 *
 * @param reason - Human-readable error reason or message.
 * @returns Up to eight deduplicated keyword tokens.
 *
 * @example
 * ```ts
 * errorKeywords("TypeError: Cannot read property 'x' of undefined");
 * ["typeerror", "cannot", "read", "property", "undefined"]
 *
 * errorKeywords("C++ compilation error in module");
 * ["c++", "compilation", "error", "module"]
 * ```
 */
export const errorKeywords = (reason: string): string[] => {
  const keywordTokens = reason
    .toLowerCase()
    .split(/[^a-z0-9+#]+/g)
    .filter((keyword) => keyword.length >= 3);
  return [...new Set(keywordTokens)].slice(0, 8);
};

/**
 * Normalizes an untrusted confidence value to the PreferenceConfidence type.
 *
 * @remarks
 * Validates that the input is exactly one of the accepted confidence
 * strings (`"high"`, `"medium"`, `"low"`). If the value is missing, malformed,
 * or not one of the three accepted strings, falls back to the safe default
 * `"medium"`. Used by {@link PatternExtractor} to sanitize agent output before
 * storing rules.
 *
 * @param raw - The untrusted value produced by the agent.
 * @returns One of `"high"`, `"medium"`, or `"low"`.
 *
 * @example
 * ```ts
 * parseConfidence("high"); // "high"
 * parseConfidence("medium"); // "medium"
 * parseConfidence("low"); // "low"
 * parseConfidence("invalid"); // "medium" (fallback)
 * parseConfidence(null); // "medium" (fallback)
 * ```
 */
export const parseConfidence = (raw: unknown): PreferenceConfidence => {
  if (raw === "high" || raw === "medium" || raw === "low") {
    return raw;
  }
  return "medium";
};
