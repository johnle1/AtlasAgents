/**
 * <Summary>
 * What it does:
 *   Persists user preference rules as JSON under user-data/preferences.json with
 *   atomic renames and in-process read/write helpers.
 *
 * How it fits in the system:
 *   Implements IPreferenceStore for ContextBuilder and future memory commands.
 *
 * Dependencies:
 *   - node:fs/promises, node:path, node:crypto — filesystem and ids.
 *   - ../orchestration/interfaces.js — IPreferenceStore, PreferenceRule.
 *
 * Dependants:
 *   - ContextBuilder — getAll at task start.
 * </Summary>
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  IPreferenceStore,
  PreferenceRule,
} from "../orchestration/interfaces.js";

const DEFAULT_FILE = "user-data/preferences.json";

/**
 * <Summary>
 * What it does:
 *   On-disk shape for the preferences file (versioned wrapper around rules).
 *
 * Used by:
 *   - PreferenceStore — serialises and parses atomically.
 *
 * Produced by:
 *   - PreferenceStore initial empty write.
 * </Summary>
 */
type PreferencesFile = {
  version: 1;
  rules: PreferenceRule[];
};

/**
 * <Summary>
 * What it does:
 *   Ensures a directory exists before writing files inside it.
 *
 * Parameters:
 *   @param {string} dir — Absolute directory path.
 *
 * Returns:
 *   @returns {Promise<void>} — Completes after mkdir -p.
 *
 * Dependants:
 *   - PreferenceStore persistence helpers.
 * </Summary>
 */
const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true });
};

/**
 * <Summary>
 * What it does:
 *   Validates unknown JSON into a PreferencesFile or returns an empty file object.
 *
 * How it does it (step by step):
 *   1. Check if input is an object with a rules array property.
 *   2. For each unknown rule in the array, validate and extract each field.
 *   3. Type-check and sanitize: id, text, topics, timesApplied, createdAt.
 *   4. Discard any rule missing required fields (id, text, or createdAt).
 *   5. Return normalized file with validated rules or empty array.
 *
 * Parameters:
 *   @param {unknown} raw — Parsed JSON root (could be malformed).
 *
 * Returns:
 *   @returns {PreferencesFile} — Normalised file contents with validated rules.
 *
 * Dependants:
 *   - PreferenceStore.load.
 * </Summary>
 */
const normaliseFile = (raw: unknown): PreferencesFile => {
  // Step 1: Check if input is an object with a rules array property
  if (
    typeof raw === "object" &&
    raw !== null &&
    "rules" in raw &&
    Array.isArray((raw as { rules: unknown }).rules)
  ) {
    // Step 2: Process each rule in the rules array
    const rules = (raw as { rules: unknown[] }).rules
      .map((unknownRule) => {
        // Step 3a: Verify the rule is an object (not null, string, number, etc.)
        if (typeof unknownRule !== "object" || unknownRule === null) {
          return null;
        }

        // Step 3b: Cast to a typed object for safe property access
        const ruleObj = unknownRule as Record<string, unknown>;

        // Step 4a: Extract id (must be a string)
        // If id is not a string, default to empty string (will be filtered out)
        const id = typeof ruleObj.id === "string" ? ruleObj.id : "";

        // Step 4b: Extract text (must be a string)
        // If text is not a string, default to empty string (will be filtered out)
        const text = typeof ruleObj.text === "string" ? ruleObj.text : "";

        // Step 4c: Extract and validate topics (must be an array of strings)
        // Filter out non-string elements, default to empty array if not an array
        const topics = Array.isArray(ruleObj.topics)
          ? ruleObj.topics.filter(
              (topic): topic is string => typeof topic === "string",
            )
          : [];

        // Step 4d: Extract timesApplied (must be a non-negative integer)
        // Validate it's a finite number, floor it, and ensure it's not negative
        const timesApplied =
          typeof ruleObj.timesApplied === "number" &&
          Number.isFinite(ruleObj.timesApplied)
            ? Math.max(0, Math.floor(ruleObj.timesApplied))
            : 0;

        // Step 4e: Extract createdAt (must be a string, typically ISO timestamp)
        // If createdAt is not a string, default to empty string (will be filtered out)
        const createdAt =
          typeof ruleObj.createdAt === "string" ? ruleObj.createdAt : "";

        // Step 5a: Validate required fields are not empty
        // A rule must have id, text, and createdAt to be valid
        // If any required field is empty, return null (rule will be filtered out)
        if (id.length === 0 || text.length === 0 || createdAt.length === 0) {
          return null;
        }

        // Step 5b: Return the validated and sanitized rule
        return {
          id,
          text,
          topics,
          timesApplied,
          createdAt,
        } satisfies PreferenceRule;
      })
      // Step 5c: Filter out all null entries (invalid rules)
      // Only keep valid PreferenceRule objects
      .filter(
        (validatedRule): validatedRule is PreferenceRule =>
          validatedRule !== null,
      );

    // Step 6: Return the normalized file structure with validated rules
    return { version: 1, rules } satisfies PreferencesFile;
  }

  // Step 7: If input is not a valid object with rules array, return empty file
  // This handles: null input, wrong shape, missing rules property, non-array rules
  return { version: 1, rules: [] } satisfies PreferencesFile;
};

export class PreferenceStore implements IPreferenceStore {
  private readonly absPath: string;

  /**
   * <Summary>
   * What it does:
   *   Initializes PreferenceStore with an absolute file path.
   *
   * How it does it (step by step):
   *   1. Accept optional rootDir parameter (base directory path).
   *   2. Use rootDir if provided, otherwise default to current working directory.
   *   3. Construct the absolute file path by joining base directory with DEFAULT_FILE.
   *   4. Store the absolute path for all future file operations.
   *
   * Parameters:
   *   @param {string} [rootDir] — Optional base directory for user-data. Defaults to process.cwd() if omitted.
   *
   * Dependants:
   *   - All PreferenceStore instance methods (getAll, add, remove, etc.).
   * </Summary>
   */
  constructor(rootDir?: string) {
    // Step 1: Accept optional rootDir parameter (base directory path)
    // rootDir could be undefined, in which case we use the default cwd

    // Step 2: Use rootDir if provided, otherwise default to current working directory
    // The nullish coalescing operator (??) ensures we always have a valid base path
    // process.cwd() returns the directory where the Node.js process was started
    const base = rootDir ?? process.cwd();

    // Step 3: Construct the absolute file path by joining base directory with DEFAULT_FILE
    // DEFAULT_FILE is 'user-data/preferences.json'
    // path.join() normalizes the path (handles forward/backward slashes across platforms)
    // Example: if base is '/home/user' and DEFAULT_FILE is 'user-data/preferences.json'
    //          result is '/home/user/user-data/preferences.json'
    this.absPath = path.join(base, DEFAULT_FILE);

    // Step 4: Store the absolute path for all future file operations
    // All methods (getAll, add, remove, load, save) use this.absPath for consistency
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Reads preferences.json or returns an empty list when missing.
   *
   * How it does it (step by step):
   *   1. Initialize a variable to hold the raw file contents.
   *   2. Attempt to read preferences.json from disk as UTF-8 text.
   *   3. If file is missing (ENOENT), return an empty array (graceful fallback).
   *   4. If any other error occurs, re-throw it (real problems should propagate).
   *   5. Initialize a variable to hold the parsed JSON object.
   *   6. Attempt to parse the raw text as JSON.
   *   7. If JSON is malformed or invalid, return an empty array (graceful fallback).
   *   8. Pass parsed JSON to normaliseFile() for validation and sanitization.
   *   9. Extract and return just the rules array from the normalized file.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<PreferenceRule[]>} — All validated rules, or empty array on any error.
   *
   * Error handling strategy:
   *   - Missing file (ENOENT): Return [] (file will be created on first write).
   *   - Invalid JSON: Return [] (file is corrupted but won't be overwritten).
   *   - Other file errors: Re-throw (permission denied, disk full, etc.).
   *
   * Dependants:
   *   - ContextBuilder.build.
   * </Summary>
   */
  getAll = async (): Promise<PreferenceRule[]> => {
    // Step 1: Initialize a variable to hold the raw file contents
    // This will store the entire file as a UTF-8 string
    let rawText = "";

    // Step 2: Attempt to read preferences.json from disk as UTF-8 text
    // this.absPath points to 'user-data/preferences.json'
    // The await keyword pauses execution until the file read completes
    try {
      rawText = await fs.readFile(this.absPath, "utf-8");
    } catch (err) {
      // Step 3: Check what kind of error occurred
      // Extract the error code (ENOENT = "Error No ENTry" = file not found)
      const code = (err as NodeJS.ErrnoException).code;

      // Step 4: If file is missing, return empty array (graceful fallback)
      // This is expected on first run before any rules are saved
      // Returning [] instead of throwing allows the system to continue normally
      if (code === "ENOENT") {
        return [];
      }

      // Step 5: If any other error occurs, re-throw it
      // Other errors (permission denied, disk read failure) indicate real problems
      // These should propagate so the caller can handle them appropriately
      throw err;
    }

    // Step 6: Initialize a variable to hold the parsed JSON object
    // Type is 'unknown' because we haven't validated it yet
    let parsed: unknown;

    // Step 7: Attempt to parse the raw text as JSON
    // JSON.parse() converts the string into a JavaScript object
    // The 'as unknown' tells TypeScript we're doing defensive parsing
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      // Step 8: If JSON is malformed or invalid, return empty array
      // This handles: truncated files, invalid syntax, corrupted data
      // Returning [] instead of throwing prevents the system from crashing
      // The file won't be overwritten, allowing recovery later if needed
      return [];
    }

    // Step 9a: Pass parsed JSON to normaliseFile() for validation and sanitization
    // normaliseFile() validates the structure, checks all fields, and filters invalid rules
    // It returns a PreferencesFile object: { version: 1, rules: PreferenceRule[] }
    const normalizedFile = normaliseFile(parsed);

    // Step 9b: Extract and return just the rules array from the normalized file
    // This returns only the validated PreferenceRule[] to the caller
    return normalizedFile.rules;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Appends a rule with a new UUID, ISO timestamp, and zero timesApplied.
   *
   * How it does it (step by step):
   *   1. Load the current preferences file from disk (or empty if missing).
   *   2. Generate a unique identifier for the new rule.
   *   3. Sanitize the rule text (trim leading/trailing whitespace).
   *   4. Sanitize the topics array (trim each topic, filter out empty strings).
   *   5. Initialize the timesApplied counter at 0.
   *   6. Capture the current timestamp in ISO format for audit trail.
   *   7. Create the rule object with all validated and sanitized fields.
   *   8. Append the new rule to the file's rules array.
   *   9. Write the updated file to disk atomically.
   *   10. Return the persisted rule to the caller.
   *
   * Parameters:
   *   @param {string} text — Rule text (will be trimmed).
   *   @param {string[]} topics — Topic tags (will be trimmed and filtered).
   *
   * Returns:
   *   @returns {Promise<PreferenceRule>} — The newly persisted rule with id, timestamp, etc.
   *
   * Dependants:
   *   - Future memory.add route.
   * </Summary>
   */
  add = async (text: string, topics: string[]): Promise<PreferenceRule> => {
    // Step 1: Load the current preferences file from disk
    // If file is missing or corrupted, load() returns { version: 1, rules: [] }
    // This ensures we always have a valid file to append to
    const preferencesFile = await this.load();

    // Step 2: Generate a unique identifier for the new rule
    // randomUUID() from node:crypto creates a UUID v4 (128-bit random)
    const ruleId = randomUUID();

    // Step 3: Sanitize the rule text (trim leading/trailing whitespace)
    // text.trim() removes spaces, tabs, newlines from both ends
    // Example: "  my rule  " becomes "my rule"
    const sanitizedText = text.trim();

    // Step 4: Sanitize the topics array (trim each topic, filter out empty strings)
    // This is a two-step process:
    //   - topics.map((topic) => topic.trim()) removes whitespace from each topic
    //   - .filter((topic) => topic.length > 0) removes empty strings after trimming
    // Example: ["  tag1  ", " ", "tag2"] becomes ["tag1", "tag2"]
    const sanitizedTopics = topics
      .map((topic) => topic.trim())
      .filter((topic) => topic.length > 0);

    // Step 5: Initialize the timesApplied counter at 0
    // This tracks how many times this rule has been applied
    // Incremented by markApplied() method when rule is used
    const initialTimesApplied = 0;

    // Step 6: Capture the current timestamp in ISO format for audit trail
    // new Date().toISOString() returns format: "2026-05-18T14:30:45.123Z"
    // Used to track when the rule was created (immutable after creation)
    const creationTimestamp = new Date().toISOString();

    // Step 7: Create the rule object with all validated and sanitized fields
    // All fields must match PreferenceRule interface:
    //   - id: string (unique identifier)
    //   - text: string (rule text, trimmed)
    //   - topics: string[] (tag array, trimmed and filtered)
    //   - timesApplied: number (usage counter)
    //   - createdAt: string (ISO timestamp)
    const newRule: PreferenceRule = {
      id: ruleId,
      text: sanitizedText,
      topics: sanitizedTopics,
      timesApplied: initialTimesApplied,
      createdAt: creationTimestamp,
    };

    // Step 8: Append the new rule to the file's rules array
    // This adds the rule to the in-memory file object (not yet persisted to disk)
    preferencesFile.rules.push(newRule);

    // Step 9: Write the updated file to disk atomically
    // save() uses temp file + rename pattern to prevent corruption:
    //   - Write to `.preferences-{UUID}.tmp` first
    //   - Rename to actual file on success
    //   - If process crashes during write, tmp file is left behind but main file is safe
    await this.save(preferencesFile);

    // Step 10: Return the persisted rule to the caller
    // The caller can use this rule's id and metadata immediately
    // without needing to call getAll() again
    return newRule;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Removes a rule by id when present.
   *
   * How it does it (step by step):
   *   1. Load the current preferences file from disk (or empty if missing).
   *   2. Capture the initial rule count before any filtering.
   *   3. Filter the rules array to remove the rule with matching id.
   *   4. Check if any rule was actually removed (compare before/after counts).
   *   5. If no rule was removed, return false immediately without saving.
   *   6. If a rule was removed, write the updated file to disk atomically.
   *   7. Return true to indicate successful removal.
   *
   * Parameters:
   *   @param {string} id — The unique identifier of the rule to remove.
   *
   * Returns:
   *   @returns {Promise<boolean>} — True if a rule was removed, false if id not found.
   *
   * Note:
   *   - This method uses rule count comparison to detect successful removal.
   *   - No error is thrown if rule id is not found; false is returned instead.
   *   - Only saves to disk if a rule was actually removed (optimization).
   *
   * Dependants:
   *   - Future memory command handlers.
   * </Summary>
   */
  remove = async (id: string): Promise<boolean> => {
    // Step 1: Load the current preferences file from disk
    // If file is missing or corrupted, load() returns { version: 1, rules: [] }
    // This ensures we have a valid file object to work with
    const preferencesFile = await this.load();

    // Step 2: Capture the initial rule count before any filtering
    // We'll use this to detect if a rule was actually removed
    // Example: if there are 5 rules initially, initialRuleCount = 5
    const initialRuleCount = preferencesFile.rules.length;

    // Step 3: Filter the rules array to remove the rule with matching id
    // Array.filter() creates a new array with only rules that DON'T match the id
    // If a rule has the matching id, it's excluded from the new array
    // Example: if removing id "abc-123", filter keeps only rules where rule.id !== "abc-123"
    preferencesFile.rules = preferencesFile.rules.filter(
      (rule) => rule.id !== id,
    );

    // Step 4: Check if any rule was actually removed (compare before/after counts)
    // Get the new rule count after filtering
    const finalRuleCount = preferencesFile.rules.length;

    // Step 5a: Determine if the rule was found and removed
    // If rule count stayed the same, the id didn't exist in the file
    const wasRuleRemoved = finalRuleCount < initialRuleCount;

    // Step 5b: If no rule was removed, return false immediately without saving
    // This avoids unnecessary disk writes when the rule wasn't found
    if (!wasRuleRemoved) {
      return false;
    }

    // Step 6: If a rule was removed, write the updated file to disk atomically
    // save() uses temp file + rename pattern to prevent corruption during write
    // The file now has one fewer rule than before
    await this.save(preferencesFile);

    // Step 7: Return true to indicate successful removal
    // The caller knows the rule was found and deleted
    return true;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Clears all rules from disk (PERMANENT deletion, cannot be undone).
   *
   * How it does it (step by step):
   *   1. Create an empty PreferencesFile structure with no rules.
   *   2. Write the empty file to disk atomically.
   *   3. Complete the operation (all rules are now permanently deleted).
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes after atomic write.
   *
   * WARNING:
   *   This operation is PERMANENT and cannot be undone.
   *   All preference rules are deleted from disk.
   *   Consider implementing a confirmation mechanism before calling this.
   *
   * Dependants:
   *   - Future memory.clear route.
   * </Summary>
   */
  clear = async (): Promise<void> => {
    // Step 1: Create an empty PreferencesFile structure with no rules
    // This object represents a completely cleared preferences file
    // Structure: { version: 1, rules: [] }
    const emptyPreferencesFile = {
      version: 1,
      rules: [],
    } satisfies PreferencesFile;

    // Step 2: Write the empty file to disk atomically
    // save() replaces the entire file with the empty structure
    // This is permanent—there is no undo or recovery mechanism
    await this.save(emptyPreferencesFile);

    // Step 3: Operation complete
    // All preference rules have been permanently deleted from disk
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Increments timesApplied counter for a rule when that rule exists.
   *
   * How it does it (step by step):
   *   1. Load the current preferences file from disk.
   *   2. Search for the rule with the matching id.
   *   3. If the rule is not found, return early without saving.
   *   4. If the rule is found, increment its timesApplied counter by 1.
   *   5. Write the updated file to disk atomically.
   *
   * Parameters:
   *   @param {string} id — The unique identifier of the rule to mark as applied.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes after optional save (silent if id not found).
   *
   * Note:
   *   - If the rule id is not found, nothing happens (no error thrown).
   *   - The counter is incremented in-place and then persisted to disk.
   *   - Used for tracking learning/preference history.
   *
   * Dependants:
   *   - Future learning hooks.
   * </Summary>
   */
  markApplied = async (id: string): Promise<void> => {
    // Step 1: Load the current preferences file from disk
    // If file is missing or corrupted, load() returns { version: 1, rules: [] }
    // This ensures we have a valid file object to search
    const preferencesFile = await this.load();

    // Step 2: Search for the rule with the matching id
    // Array.find() returns the first rule where rule.id === id, or undefined if not found
    // Example: searching for id "xyz-789" in rules with ids ["abc-123", "xyz-789", "def-456"]
    //          returns the rule object with id "xyz-789"
    const foundRule = preferencesFile.rules.find((rule) => rule.id === id);

    // Step 3: If the rule is not found, return early without saving
    // This is an optimization—no need to save if nothing changed
    // The caller doesn't know if the id was found or not (silent failure)
    if (!foundRule) {
      return;
    }

    // Step 4: If the rule is found, increment its timesApplied counter by 1
    // timesApplied tracks how many times this rule has been used
    // Example: if timesApplied was 5, it becomes 6
    foundRule.timesApplied += 1;

    // Step 5: Write the updated file to disk atomically
    // save() persists the modified file with the incremented counter
    // The rule's timesApplied is now permanently recorded on disk
    await this.save(preferencesFile);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Loads the preferences file from disk or returns an empty in-memory object.
   *
   * How it does it (step by step):
   *   1. Initialize variable to hold raw file contents.
   *   2. Attempt to read preferences.json from disk as UTF-8 text.
   *   3. If file is missing (ENOENT), return empty PreferencesFile immediately.
   *   4. If any other error occurs, re-throw it (real problem, not recoverable).
   *   5. Initialize variable to hold parsed JSON object.
   *   6. Attempt to parse the raw text as JSON.
   *   7. If JSON parsing fails, return empty PreferencesFile (corrupted file).
   *   8. Pass parsed JSON to normaliseFile() for validation and sanitization.
   *   9. Return the validated PreferencesFile object.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<PreferencesFile>} — Validated file or empty {version: 1, rules: []}.
   *
   * Used by:
   *   - All PreferenceStore mutator methods (add, remove, clear, markApplied).
   * </Summary>
   */
  private load = async (): Promise<PreferencesFile> => {
    // Step 1: Initialize variable to hold raw file contents
    // This stores the entire file as a UTF-8 string
    let rawFileContents = "";

    // Step 2: Attempt to read preferences.json from disk as UTF-8 text
    // this.absPath points to 'user-data/preferences.json'
    // The await keyword pauses execution until file read completes
    try {
      rawFileContents = await fs.readFile(this.absPath, "utf-8");
    } catch (err) {
      // Step 3: Check what kind of error occurred
      // Extract error code (ENOENT = "Error No ENTry" = file not found)
      const errorCode = (err as NodeJS.ErrnoException).code;

      // Step 4: If file is missing, return empty PreferencesFile immediately
      // This is expected on first run before any rules are saved
      // Returning empty object instead of throwing allows system to continue
      if (errorCode === "ENOENT") {
        return { version: 1, rules: [] } satisfies PreferencesFile;
      }

      // Step 5: If any other error occurs, re-throw it
      // Other errors (permission denied, disk failure) indicate real problems
      // These should propagate so caller can handle them appropriately
      throw err;
    }

    // Step 6: Initialize variable to hold parsed JSON object
    // Type is 'unknown' because we haven't validated it yet
    let parsedJsonObject: unknown;

    // Step 7: Attempt to parse the raw text as JSON
    // JSON.parse() converts the string into a JavaScript object
    // The 'as unknown' tells TypeScript we're doing defensive parsing
    try {
      parsedJsonObject = JSON.parse(rawFileContents) as unknown;
    } catch {
      // Step 8: If JSON parsing fails, return empty PreferencesFile
      // This handles: truncated files, invalid syntax, corrupted data
      // Returning empty object instead of throwing prevents crash
      // File won't be overwritten, allowing potential recovery later
      return { version: 1, rules: [] } satisfies PreferencesFile;
    }

    // Step 9a: Pass parsed JSON to normaliseFile() for validation and sanitization
    // normaliseFile() validates structure, checks all fields, filters invalid rules
    // It returns a PreferencesFile object: { version: 1, rules: PreferenceRule[] }
    const validatedFile = normaliseFile(parsedJsonObject);

    // Step 9b: Return the validated PreferencesFile object
    // Guaranteed to have valid structure and all rules pass validation
    return validatedFile;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Writes JSON atomically via temp file + rename in the user-data directory.
   *
   * How it does it (step by step):
   *   1. Extract the directory path from the absolute file path.
   *   2. Ensure the directory exists (create if missing).
   *   3. Generate a unique temporary file name using UUID.
   *   4. Construct the full path to the temporary file.
   *   5. Convert PreferencesFile object to formatted JSON string.
   *   6. Append newline to the JSON payload for unix convention.
   *   7. Write the JSON payload to the temporary file.
   *   8. Atomically rename the temporary file to the actual file.
   *   9. Atomic rename ensures file is never in corrupted state.
   *
   * Atomic write pattern (prevents corruption):
   *   - If process crashes during write: temp file is left behind, main file is safe.
   *   - If rename succeeds: old file is replaced atomically (no partial state).
   *   - This prevents disk corruption from interrupted writes.
   *
   * Parameters:
   *   @param {PreferencesFile} file — Full file payload to persist (with version and rules).
   *
   * Returns:
   *   @returns {Promise<void>} — Completes after atomic rename.
   *
   * Used by:
   *   - PreferenceStore.add, remove, clear, markApplied.
   * </Summary>
   */
  private save = async (file: PreferencesFile): Promise<void> => {
    // Step 1: Extract the directory path from the absolute file path
    // this.absPath is something like '/home/user/user-data/preferences.json'
    // path.dirname() extracts '/home/user/user-data'
    const directoryPath = path.dirname(this.absPath);

    // Step 2: Ensure the directory exists (create if missing)
    // ensureDir() uses fs.mkdir() with recursive: true to create parent directories
    // If directory already exists, this is a no-op (safe to call repeatedly)
    // Example: if directory '/home/user/user-data' doesn't exist, it creates it
    await ensureDir(directoryPath);

    // Step 3: Generate a unique temporary file name using UUID
    // randomUUID() creates a UUID v4 (128-bit random)
    // Example UUID: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    const uniqueUuid = randomUUID();

    // Step 4: Construct the full path to the temporary file
    // Pattern: '.preferences-{UUID}.tmp'
    // This creates files like: '.preferences-a1b2c3d4-e5f6-7890-abcd-ef1234567890.tmp'
    // Hidden files (starting with .) won't show in normal directory listings
    const tempFilePath = path.join(
      directoryPath,
      `.preferences-${uniqueUuid}.tmp`,
    );

    // Step 5: Convert PreferencesFile object to formatted JSON string
    // JSON.stringify(file, null, 2) creates nicely indented JSON:
    //   - First param: object to stringify
    //   - Second param: null (no custom replacer)
    //   - Third param: 2 (indent 2 spaces for readability)
    // Example output:
    //   {
    //     "version": 1,
    //     "rules": [
    //       { "id": "...", "text": "...", ... }
    //     ]
    //   }
    const jsonString = JSON.stringify(file, null, 2);

    // Step 6: Append newline to the JSON payload for unix convention
    // Unix text files traditionally end with a newline character
    // This makes the file more compatible with unix tools (cat, grep, etc.)
    const jsonPayloadWithNewline = `${jsonString}\n`;

    // Step 7: Write the JSON payload to the temporary file
    // fs.writeFile(tempFilePath, data, encoding)
    //   - Writes to temp file first (not main file)
    //   - If process crashes here, temp file is lost but main file is safe
    // The await pauses execution until write completes
    await fs.writeFile(tempFilePath, jsonPayloadWithNewline, "utf-8");

    // Step 8: Atomically rename the temporary file to the actual file
    // fs.rename() is atomic on most file systems (Linux, macOS, Windows)
    // This means the rename either fully succeeds or fully fails—no partial state
    // Example: '.preferences-{UUID}.tmp' becomes 'preferences.json'
    // If old file exists, it's replaced; if it doesn't, the temp becomes the new file
    await fs.rename(tempFilePath, this.absPath);

    // Step 9: Atomic rename ensures file is never in corrupted state
    // Why this pattern is important:
    //   - Direct write to file: if crash during write, file is partially written (corrupted)
    //   - Temp file + atomic rename: if crash during write, old file untouched (safe)
    //   - Only risk: temp files left behind on crash (safe to delete later)
  };
}
