/**
 * <Summary>
 * What it does:
 *   Types and loaders for user-editable language hint rows in user-data/language-hints.json.
 *
 * How it fits in the system:
 *   Seeded from packages/server/default-data on first server start; read by ContextBuilder.
 *   Provides language/framework detection for keyword extraction, enabling the system
 *   to recognize programming languages and frameworks mentioned in task descriptions.
 * </Summary>
 */

// ===== FILESYSTEM IMPORTS =====
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ===== TYPE DEFINITION IMPORTS =====
import type { LanguageHint } from "../../orchestration/interfaces.js";

export const LANGUAGE_HINTS_FILENAME = "language-hints.json";

/**
 * <Summary>
 * What it does:
 *   Validates parsed JSON into a list of LanguageHint rows.
 *
 * How it does it (step by step):
 *   1. Check if input is an array (must be to process hints).
 *   2. Create an output array to accumulate validated hints.
 *   3. Iterate through each item in the input array.
 *   4. Skip non-object items (strings, numbers, null, etc.).
 *   5. Extract and sanitize needle (search substring).
 *   6. Extract and sanitize tag (topic label).
 *   7. Skip hints with empty needle or tag.
 *   8. Add validated hint to output array.
 *   9. Return the array of validated hints.
 *
 * Parameters:
 *   @param rawInput - Parsed JSON root (could be any type).
 *
 * Returns:
 *   @returns Normalised hints (invalid rows dropped).
 * </Summary>
 */
export const parseLanguageHints = (rawInput: unknown): LanguageHint[] => {
  // Step 1: Check if input is an array
  // LanguageHints must be stored as an array in JSON
  // If it's an object, null, string, etc., return empty array (graceful fallback)
  if (!Array.isArray(rawInput)) {
    return [];
  }

  // Step 2: Create output array to accumulate validated hints
  // This will hold only the hints that pass all validation checks
  const validatedHints: LanguageHint[] = [];

  // Step 3: Iterate through each item in the input array
  // We need to validate every item individually before adding to output
  for (const rawHintItem of rawInput) {
    // Step 4a: Check if current item is an object (not null or primitive)
    // null is technically typeof 'object' in JavaScript, so we explicitly check for it
    if (typeof rawHintItem !== "object" || rawHintItem === null) {
      continue;
    }

    // Step 4b: Cast to Record for safe property access
    // This tells TypeScript "treat this as an object with string keys"
    // It doesn't validate — just allows us to access arbitrary properties safely
    const hintObject = rawHintItem as Record<string, unknown>;

    // Step 5: Extract and sanitize needle (the substring to search for)
    // Needle must be a string; if not, default to empty string
    // trim() removes leading/trailing whitespace
    // Empty needles will be filtered out in step 7
    const searchSubstring =
      typeof hintObject.needle === "string" ? hintObject.needle.trim() : "";

    // Step 6: Extract and sanitize tag (the topic label to assign)
    // Tag must be a string; if not, default to empty string
    // trim() removes whitespace, toLowerCase() normalizes for case-insensitive matching
    // Empty tags will be filtered out in step 7
    const topicTag =
      typeof hintObject.tag === "string"
        ? hintObject.tag.trim().toLowerCase()
        : "";

    // Step 7: Skip hints with empty needle or tag
    // Both fields are required and meaningful (non-empty) to be useful
    // This prevents waste: "typescript" with empty tag is useless
    if (searchSubstring.length === 0 || topicTag.length === 0) {
      continue;
    }

    // Step 8: Add validated hint to output array
    // At this point, searchSubstring and topicTag are both guaranteed non-empty
    validatedHints.push({
      needle: searchSubstring,
      tag: topicTag,
    });
  }

  // Step 9: Return the array of validated hints
  // Only valid hints (non-empty needle and tag) are included
  return validatedHints;
};

/**
 * @async
 * <Summary>
 * What it does:
 *   Reads language hints from user-data/language-hints.json under rootDir.
 *
 * How it does it (step by step):
 *   1. Construct absolute file path from rootDir and filename.
 *   2. Initialize variable to hold raw file contents.
 *   3. Attempt to read the file from disk as UTF-8 text.
 *   4. If file is missing (ENOENT), return empty array (graceful fallback).
 *   5. If other error occurs, re-throw it (real problems propagate).
 *   6. Attempt to parse raw text as JSON.
 *   7. Pass parsed JSON to parseLanguageHints() for validation.
 *   8. If JSON parsing fails, return empty array (corrupted file handled).
 *
 * Parameters:
 *   @param rootDirectory - Server data root (usually process.cwd()).
 *
 * Returns:
 *   @returns Parsed hints, or empty when file missing/unreadable.
 * </Summary>
 */
export const loadLanguageHints = async (
  rootDirectory: string,
): Promise<LanguageHint[]> => {
  // Step 1: Construct absolute file path from rootDir and filename
  // rootDir: base directory for server data (e.g., '/home/user')
  // LANGUAGE_HINTS_FILENAME: 'language-hints.json'
  // path.join() combines them with OS-appropriate separators
  // Result example: '/home/user/user-data/language-hints.json'
  const absoluteFilePath = path.join(
    rootDirectory,
    "user-data",
    LANGUAGE_HINTS_FILENAME,
  );

  // Step 2: Initialize variable to hold raw file contents
  // This will store the entire file as a UTF-8 string before JSON parsing
  let fileContents = "";

  // Step 3: Attempt to read the file from disk as UTF-8 text
  // fs.readFile() is async; await pauses execution until read completes
  try {
    fileContents = await fs.readFile(absoluteFilePath, "utf-8");
  } catch (readError) {
    // Step 4a: Extract error code to determine what went wrong
    // NodeJS.ErrnoException has a 'code' property with error type
    // ENOENT = "Error No ENTry" = file not found
    const errorCode = (readError as NodeJS.ErrnoException).code;

    // Step 4b: If file is missing, return empty array (graceful fallback)
    // This is expected on first server start before hints file is created
    // Returning [] instead of throwing allows system to continue normally
    // ContextBuilder will work with empty hints and adapt behavior
    if (errorCode === "ENOENT") {
      return [];
    }

    // Step 5: If other error occurs, re-throw it (real problems must propagate)
    // Other errors (permission denied, disk I/O failure, etc.) indicate real issues
    // These should propagate to the caller for proper error handling
    // Examples: EACCES (permission), EIO (hardware failure)
    throw readError;
  }

  // Step 6: Attempt to parse raw text as JSON
  // JSON.parse() converts the UTF-8 string into JavaScript object/array
  // Type assertion 'as unknown' tells TypeScript we're doing defensive parsing
  try {
    // Step 7: Pass parsed JSON to parseLanguageHints() for validation
    // parseLanguageHints() checks structure, sanitizes fields, filters invalid rows
    // Returns only valid LanguageHint objects
    return parseLanguageHints(JSON.parse(fileContents) as unknown);
  } catch (parseError) {
    // Step 8: If JSON parsing fails, return empty array (corrupted file handled)
    // JSON.parse() can fail on: truncated files, invalid syntax, bad UTF-8
    // Returning [] instead of throwing prevents system crash
    // File is not overwritten; corrupted file can be recovered manually later
    // Examples: '{ invalid json', '[1, 2, ', '\x00\x01\x02' (bad encoding)
    return [];
  }
};
