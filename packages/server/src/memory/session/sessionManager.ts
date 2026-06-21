/**
 * <Summary>
 * What it does:
 *   Manages user-data/session/current.md so agents know what was built in prior
 *   tasks during the same working session (multi-task continuity).
 *
 * How it fits in the system:
 *   Implements ISessionManager for ContextBuilder, ExperienceRecorder, and Router.
 *
 * Dependencies:
 *   - node:fs/promises, node:path, node:crypto — filesystem only.
 *
 * Dependants:
 *   - ContextBuilder (read), ExperienceRecorder (append), Router (exists/clear).
 * </Summary>
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ISessionManager } from "../../orchestration/interfaces.js";
import type { SessionSummary } from "../types.js";

/** Relative session file under the server data root. */
const SESSION_REL_PATH = "user-data/session/current.md";

/** Regular expression to match task headers in the session file. */
const TASK_HEADER_RE = /^Task \d+/gm;

/**
 * <Summary>
 * What it does:
 *   Ensures a directory exists, creating it and any parent directories if needed.
 *
 * How it does it (step by step):
 *   1. Call fs.mkdir with the recursive option set to true.
 *   2. The recursive option creates parent directories as needed.
 *
 * Parameters:
 *   @param {string} directoryPath — The directory path to ensure exists.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when directory is guaranteed to exist.
 *
 * Dependencies:
 *   - node:fs/promises.mkdir — creates directories with recursive option.
 *
 * Dependants:
 *   - saveSnapshot — ensures session directory exists before writing.
 *   - append — ensures session directory exists before appending.
 * </Summary>
 */
const ensureDir = async (directoryPath: string): Promise<void> => {
  // Step 1: Create directory with recursive option to create parent directories as needed
  // The recursive option ensures we don't fail if parent directories don't exist
  await fs.mkdir(directoryPath, { recursive: true });
};

/**
 * <Summary>
 * What it does:
 *   Formats an array of items as a comma-separated string or returns "(none)" if empty.
 *
 * How it does it (step by step):
 *   1. Check if items array is undefined or empty.
 *   2. If so, return "(none)" as a placeholder.
 *   3. Otherwise, join the items with ", " separator.
 *
 * Parameters:
 *   @param {string[] | undefined} items — Array of strings to format, or undefined.
 *
 * Returns:
 *   {string} — Comma-separated string or "(none)" if empty/undefined.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - formatBlock — formats files written and commands run arrays.
 * </Summary>
 */
const formatList = (items: string[] | undefined): string => {
  // Step 1: Check if items array is undefined or empty
  if (!items || items.length === 0) {
    // Step 2: Return "(none)" as a placeholder for empty/undefined arrays
    return "(none)";
  }
  // Step 3: Join the items with ", " separator for readable list format
  return items.join(", ");
};

/**
 * <Summary>
 * What it does:
 *   Counts the number of task blocks in the session content by matching task headers.
 *
 * How it does it (step by step):
 *   1. Use regex to find all matches of task header pattern.
 *   2. Return the count of matches, or 0 if none found.
 *
 * Parameters:
 *   @param {string} content — The session file content to analyze.
 *
 * Returns:
 *   {number} — Number of task blocks found in the content.
 *
 * Dependencies:
 *   - TASK_HEADER_RE — regex pattern for matching task headers.
 *
 * Dependants:
 *   - append — determines the next task number when appending a new task.
 * </Summary>
 */
const countTasks = (content: string): number => {
  // Step 1: Use regex to find all matches of task header pattern
  // The global flag (g) finds all occurrences, not just the first
  const taskHeaderMatches = content.match(TASK_HEADER_RE);
  // Step 2: Return the count of matches, or 0 if none found
  return taskHeaderMatches?.length ?? 0;
};

/**
 * <Summary>
 * What it does:
 *   Formats a session summary as a markdown task block with task number, description, files, commands, and outcome.
 *
 * How it does it (step by step):
 *   1. Extract and validate the task description from the summary.
 *   2. Extract and validate the files written array from the summary.
 *   3. Extract and validate the commands run array from the summary.
 *   4. Extract and validate the outcome from the summary.
 *   5. Format these into a markdown block with the task number.
 *
 * Parameters:
 *   @param {number} taskNumber — The sequential task number (1-indexed).
 *   @param {SessionSummary} summary — The task summary object to format.
 *
 * Returns:
 *   {string} — Formatted markdown task block.
 *
 * Dependencies:
 *   - formatList — formats arrays for display.
 *
 * Dependants:
 *   - append — formats new task blocks before writing to session file.
 * </Summary>
 */
const formatBlock = (taskNumber: number, summary: SessionSummary): string => {
  // Step 1: Extract and validate the task description from the summary
  // Default to "Unknown task" if the task field is missing or empty
  const taskDescription =
    typeof summary.task === "string" && summary.task.length > 0
      ? summary.task
      : "Unknown task";

  // Step 2: Extract and validate the files written array from the summary
  // Ensure all items are strings before formatting
  const filesWritten =
    Array.isArray(summary.filesWritten) &&
    summary.filesWritten.every((filePath) => typeof filePath === "string")
      ? (summary.filesWritten as string[])
      : undefined;

  // Step 3: Extract and validate the commands run array from the summary
  // Ensure all items are strings before formatting
  const commandsRun =
    Array.isArray(summary.commandsRun) &&
    summary.commandsRun.every((command) => typeof command === "string")
      ? (summary.commandsRun as string[])
      : undefined;

  // Step 4: Extract and validate the outcome from the summary
  // Default to "unknown" if the outcome field is missing or empty
  const taskOutcome =
    typeof summary.outcome === "string" && summary.outcome.length > 0
      ? summary.outcome
      : "unknown";

  // Step 5: Format these into a markdown block with the task number
  // The format creates a structured, readable record of what was accomplished
  return [
    `Task ${taskNumber} — "${taskDescription}"`,
    `  Files written: ${formatList(filesWritten)}`,
    `  Commands run: ${formatList(commandsRun)}`,
    `  Outcome: ${taskOutcome}`,
  ].join("\n");
};

/**
 * <Summary>
 * What it does:
 *   Reads, appends to, and clears the session markdown file to maintain
 *   continuity across multiple tasks in the same working session.
 *
 * How it fits in the system:
 *   Implements ISessionManager interface for ContextBuilder, ExperienceRecorder,
 *   and Router to provide a shared session state that persists across tasks.
 *   The session file contains a chronological record of what was built in prior
 *   tasks, allowing agents to understand context without re-exploring the codebase.
 *
 * Dependencies:
 *   - node:fs/promises — filesystem operations (read, write, unlink, rename).
 *   - node:path — path manipulation for file paths.
 *   - node:crypto — randomUUID for atomic write temp files.
 *   - ensureDir — ensures session directory exists.
 *   - formatBlock — formats task summaries as markdown.
 *   - countTasks — counts existing tasks for numbering.
 *
 * Dependants:
 *   - ContextBuilder — reads session to provide context to agents.
 *   - ExperienceRecorder — appends task summaries to session.
 *   - Router — checks if session exists and clears it on request.
 * </Summary>
 */
export class SessionManager implements ISessionManager {
  /** Full path to the session markdown file. */
  private readonly sessionPath: string;

  /**
   * Constructor
   *
   * How it does it (step by step):
   *   1. Extract the root directory from deps or default to current working directory.
   *   2. Join the root directory with the relative session path to get the full path.
   *
   * Parameters:
   *   @param {Object} deps — Dependency object with optional configuration.
   *     @param {string} [deps.rootDir] — Optional data root directory. Defaults to process.cwd().
   *
   * Returns:
   *   void — Constructor does not return a value.
   *
   * Dependencies:
   *   - node:path — for joining path components.
   *   - process.cwd — for default root directory.
   *
   * Dependants:
   *   - Router — instantiates SessionManager for session management.
   */
  constructor(readonly deps: { rootDir?: string } = {}) {
    // Step 1: Extract the root directory from deps or default to current working directory
    // This allows flexibility in where session data is stored
    const rootDirectory = deps.rootDir ?? process.cwd();

    // Step 2: Join the root directory with the relative session path to get the full path
    // This creates the absolute path to the session markdown file
    this.sessionPath = path.join(rootDirectory, SESSION_REL_PATH);
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns full session file contents or empty string when missing.
   *
   * How it does it (step by step):
   *   1. Attempt to read the session file as UTF-8 text.
   *   2. If the file doesn't exist (ENOENT), return empty string.
   *   3. If another error occurs, re-throw it for the caller to handle.
   *
   * Returns:
   *   @returns {Promise<string>} — The session file contents, or empty string if file doesn't exist.
   *
   * Throws:
   *   @throws {Error} — Re-throws filesystem errors other than ENOENT.
   *
   * Dependencies:
   *   - node:fs/promises.readFile — reads file contents.
   *
   * Dependants:
   *   - ContextBuilder — reads session to provide context to agents.
   *   - append — reads existing content before appending new task.
   * </Summary>
   */
  read = async (): Promise<string> => {
    try {
      // Step 1: Attempt to read the session file as UTF-8 text
      // This returns the full content of the session markdown file
      return await fs.readFile(this.sessionPath, "utf-8");
    } catch (error) {
      // Extract the error code to determine what went wrong
      const errorCode = (error as NodeJS.ErrnoException).code;

      // Step 2: If the file doesn't exist (ENOENT), return empty string
      // This is expected behavior for new sessions or after clearing
      if (errorCode === "ENOENT") {
        return "";
      }

      // Step 3: If another error occurs, re-throw it for the caller to handle
      // This includes permission errors, disk errors, etc.
      throw error;
    }
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns whether user-data/session/current.md exists and has content.
   *
   * How it does it (step by step):
   *   1. Attempt to read the session file as UTF-8 text.
   *   2. If the file doesn't exist (ENOENT), return false.
   *   3. If the file exists but is empty, return false.
   *   4. If the file has content, return true.
   *   5. If another error occurs, re-throw it.
   *
   * Returns:
   *   @returns {Promise<boolean>} — True if session file exists with content, false otherwise.
   *
   * Throws:
   *   @throws {Error} — Re-throws filesystem errors other than ENOENT.
   *
   * Dependencies:
   *   - node:fs/promises.readFile — reads file contents.
   *
   * Dependants:
   *   - Router — checks if session exists before clearing or displaying.
   * </Summary>
   */
  exists = async (): Promise<boolean> => {
    try {
      // Step 1: Attempt to read the session file as UTF-8 text
      const fileContent = await fs.readFile(this.sessionPath, "utf-8");

      // Step 3: If the file exists but is empty, return false
      // An empty session file is treated as non-existent for practical purposes
      return fileContent.length > 0;
    } catch (error) {
      // Extract the error code to determine what went wrong
      const errorCode = (error as NodeJS.ErrnoException).code;

      // Step 2: If the file doesn't exist (ENOENT), return false
      if (errorCode === "ENOENT") {
        return false;
      }

      // Step 5: If another error occurs, re-throw it
      throw error;
    }
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Overwrites the session file with a codebase exploration snapshot.
   *
   * How it does it (step by step):
   *   1. Add a timestamp header to the snapshot content.
   *   2. Ensure the session directory exists.
   *   3. Write the content to a temporary file with a unique name.
   *   4. Atomically rename the temp file to the actual session path.
   *
   * Parameters:
   *   @param {string} snapshot — The codebase exploration snapshot content to save.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the snapshot is saved.
   *
   * Throws:
   *   @throws {Error} — Throws filesystem errors if directory creation or write fails.
   *
   * Dependencies:
   *   - ensureDir — ensures session directory exists.
   *   - node:crypto.randomUUID — generates unique temp file names.
   *   - node:fs/promises.writeFile — writes content to temp file.
   *   - node:fs/promises.rename — atomically moves temp file to final location.
   *
   * Dependants:
   *   - Router — saves codebase exploration snapshots.
   * </Summary>
   */
  saveSnapshot = async (snapshot: string): Promise<void> => {
    // Step 1: Add a timestamp header to the snapshot content
    // This helps identify when the snapshot was taken and provides context
    const timestampedContent = `[Codebase snapshot — ${new Date().toISOString()}]\n\n${snapshot}\n`;

    // Step 2: Ensure the session directory exists
    // We get the directory path from the session file path
    const sessionDirectory = path.dirname(this.sessionPath);
    await ensureDir(sessionDirectory);

    // Step 3: Write the content to a temporary file with a unique name
    // Using a temp file ensures atomic writes and prevents corruption
    // If the process crashes during write, the original file remains intact
    const tempFilePath = path.join(
      sessionDirectory,
      `.session-${randomUUID()}.tmp`,
    );
    await fs.writeFile(tempFilePath, timestampedContent, "utf-8");

    // Step 4: Atomically rename the temp file to the actual session path
    // rename is atomic on most filesystems, ensuring no partial writes
    await fs.rename(tempFilePath, this.sessionPath);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Appends one formatted task block to the session file with atomic write.
   *
   * How it does it (step by step):
   *   1. Read the existing session content.
   *   2. Count existing tasks to determine the next task number.
   *   3. Format the new task summary as a markdown block.
   *   4. Determine the appropriate separator (blank line or empty string).
   *   5. Concatenate existing content, separator, and new block.
   *   6. Ensure the session directory exists.
   *   7. Write the new content to a temporary file.
   *   8. Atomically rename the temp file to the session path.
   *
   * Parameters:
   *   @param {SessionSummary} summary — The task summary to append to the session.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the task summary is appended.
   *
   * Throws:
   *   @throws {Error} — Throws filesystem errors if directory creation or write fails.
   *
   * Dependencies:
   *   - this.read — reads existing session content.
   *   - countTasks — determines next task number.
   *   - formatBlock — formats the summary as markdown.
   *   - ensureDir — ensures session directory exists.
   *   - node:crypto.randomUUID — generates unique temp file names.
   *   - node:fs/promises.writeFile — writes content to temp file.
   *   - node:fs/promises.rename — atomically moves temp file to final location.
   *
   * Dependants:
   *   - ExperienceRecorder — appends task summaries after completion.
   * </Summary>
   */
  append = async (summary: SessionSummary): Promise<void> => {
    // Step 1: Read the existing session content
    // We need to preserve existing tasks when appending the new one
    const existingContent = await this.read();

    // Step 2: Count existing tasks to determine the next task number
    // Tasks are 1-indexed, so we add 1 to the count of existing tasks
    const nextTaskNumber = countTasks(existingContent) + 1;

    // Step 3: Format the new task summary as a markdown block
    // This creates a standardized, readable format for the task record
    const taskBlock = formatBlock(nextTaskNumber, summary);

    // Step 4: Determine the appropriate separator (blank line or empty string)
    // If there's existing content, add a blank line for separation
    // If the file is empty, no separator is needed
    const separator = existingContent.trim().length > 0 ? "\n\n" : "";

    // Step 5: Concatenate existing content, separator, and new block
    // This creates the new complete session content
    const newSessionContent = `${existingContent}${separator}${taskBlock}\n`;

    // Step 6: Ensure the session directory exists
    const sessionDirectory = path.dirname(this.sessionPath);
    await ensureDir(sessionDirectory);

    // Step 7: Write the new content to a temporary file
    // Using a temp file ensures atomic writes and prevents corruption
    const tempFilePath = path.join(
      sessionDirectory,
      `.session-${randomUUID()}.tmp`,
    );
    await fs.writeFile(tempFilePath, newSessionContent, "utf-8");

    // Step 8: Atomically rename the temp file to the session path
    // rename is atomic on most filesystems, ensuring no partial writes
    await fs.rename(tempFilePath, this.sessionPath);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deletes the session file when present and returns a confirmation string.
   *
   * How it does it (step by step):
   *   1. Attempt to delete the session file using fs.unlink.
   *   2. If the file doesn't exist (ENOENT), ignore the error (already cleared).
   *   3. If another error occurs, re-throw it for the caller to handle.
   *   4. Return a confirmation message regardless of whether file existed.
   *
   * Returns:
   *   @returns {Promise<string>} — Confirmation message "Session cleared".
   *
   * Throws:
   *   @throws {Error} — Re-throws filesystem errors other than ENOENT.
   *
   * Dependencies:
   *   - node:fs/promises.unlink — deletes the session file.
   *
   * Dependants:
   *   - Router — clears the session when requested by user.
   * </Summary>
   */
  clear = async (): Promise<string> => {
    try {
      // Step 1: Attempt to delete the session file using fs.unlink
      // This removes the file from the filesystem
      await fs.unlink(this.sessionPath);
    } catch (error) {
      // Extract the error code to determine what went wrong
      const errorCode = (error as NodeJS.ErrnoException).code;

      // Step 2: If the file doesn't exist (ENOENT), ignore the error
      // The session is already cleared, which is the desired state
      if (errorCode !== "ENOENT") {
        // Step 3: If another error occurs, re-throw it
        // This includes permission errors, disk errors, etc.
        throw error;
      }
    }
    // Step 4: Return a confirmation message regardless of whether file existed
    // This provides consistent user feedback
    return "Session cleared";
  };
}
