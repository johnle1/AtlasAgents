/**
 * Types and loaders for language hints that enable framework/language recognition.
 *
 * @remarks
 * Language hints are user-editable rows in `user-data/language-hints.json`,
 * seeded from `packages/server/default-data` on first server start. Used by
 * {@link ContextBuilder} to detect programming languages and frameworks mentioned
 * in task descriptions, enriching keyword extraction for preference rule matching.
 *
 * Example hint: `{ "needle": "typescript", "tag": "typescript" }`
 * allows rules tagged "typescript" to match tasks mentioning "TypeScript".
 */

// ===== FILESYSTEM IMPORTS =====
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ===== TYPE DEFINITION IMPORTS =====
import type { LanguageHint } from "../../orchestration/interfaces.js";

export const LANGUAGE_HINTS_FILENAME = "language-hints.json";

/**
 * Validates parsed JSON into a list of normalized LanguageHint rows.
 *
 * @param rawInput - Parsed JSON root (could be any type)
 * @returns Normalized hints with invalid rows dropped
 *
 * @remarks
 * Filters input for valid hint objects, extracting and sanitizing `needle` (search term)
 * and `tag` (topic label). Requires both fields to be non-empty strings.
 * Returns empty array if input is not an array or contains no valid hints.
 *
 * @example
 * ```ts
 * parseLanguageHints([
 *   { needle: "typescript", tag: "TypeScript" },
 *   { needle: "react", tag: "React" },
 *   { needle: "", tag: "invalid" }, // Skipped: empty needle
 * ])
 *  [
 *   { needle: "typescript", tag: "typescript" },
 *   { needle: "react", tag: "react" }
 * ]
 * ```
 */
export const parseLanguageHints = (rawInput: unknown): LanguageHint[] => {
  if (!Array.isArray(rawInput)) {
    return [];
  }

  const validatedHints: LanguageHint[] = [];

  for (const rawHintItem of rawInput) {
    if (typeof rawHintItem !== "object" || rawHintItem === null) {
      continue;
    }

    const hintObject = rawHintItem as Record<string, unknown>;
    const searchSubstring =
      typeof hintObject.needle === "string" ? hintObject.needle.trim() : "";
    const topicTag =
      typeof hintObject.tag === "string"
        ? hintObject.tag.trim().toLowerCase()
        : "";

    // Skip invalid hints (both needle and tag required and non-empty)
    if (searchSubstring.length === 0 || topicTag.length === 0) {
      continue;
    }

    validatedHints.push({
      needle: searchSubstring,
      tag: topicTag,
    });
  }

  return validatedHints;
};

/**
 * Reads and parses language hints from `user-data/language-hints.json`.
 *
 * @param rootDirectory - Server data root directory (usually process.cwd())
 * @returns Parsed and normalized hints; empty array if file missing or unreadable
 *
 * @remarks
 * **Error handling:**
 * - Missing file (ENOENT): Returns `[]` — expected on first server start
 * - Other read errors (permission, I/O): Re-throws to surface real problems
 * - Corrupted JSON: Returns `[]` — file preserved for manual recovery
 *
 * Validates parsed JSON via `parseLanguageHints()` before returning.
 * Gracefully degraded behavior ensures system continues with zero hints
 * if file is unavailable.
 *
 * @example
 * ```ts
 * const hints = await loadLanguageHints(process.cwd());
 *  [
 *   { needle: "typescript", tag: "typescript" },
 *   { needle: "react", tag: "react" }
 * ]
 * ```
 */
export const loadLanguageHints = async (
  rootDirectory: string,
): Promise<LanguageHint[]> => {
  const absoluteFilePath = path.join(
    rootDirectory,
    "user-data",
    LANGUAGE_HINTS_FILENAME,
  );

  let fileContents = "";

  try {
    fileContents = await fs.readFile(absoluteFilePath, "utf-8");
  } catch (readError) {
    const errorCode = (readError as NodeJS.ErrnoException).code;

    // File not found on first start — graceful fallback
    if (errorCode === "ENOENT") {
      return [];
    }

    // Real errors (permission, I/O) should propagate
    throw readError;
  }

  try {
    return parseLanguageHints(JSON.parse(fileContents) as unknown);
  } catch {
    // Corrupted JSON — return empty array, preserve file for recovery
    return [];
  }
};
