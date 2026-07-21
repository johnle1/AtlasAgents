/**
 * Manages session continuity across multiple tasks in a working session.
 *
 * @remarks
 * Implements {@link ISessionManager} to provide agents with context about
 * prior work in the same session, enabling multi-task continuity and smarter
 * decision-making across sequential tasks.
 *
 * **Session File:**
 * - Persisted to `user-data/session/current.md` (markdown format for readability)
 * - Contains numbered task blocks with descriptions, files, commands, outcomes
 * - Read by {@link ContextBuilder} to populate "[Prior session]" context section
 * - Updated by {@link ExperienceRecorder.finish} after each task completes
 *
 * **Workflow:**
 * 1. `saveSnapshot(codebaseExploration)` — Initialize session with codebase snapshot
 * 2. `append(taskSummary)` — Add task record after execution (called by ExperienceRecorder)
 * 3. `read()` — Retrieve full session content for context building
 * 4. `clear()` — Delete session (reset between sessions)
 *
 * **Multi-Task Continuity:**
 * - Task 1 output → becomes input context for Task 2
 * - Agents see what was built, modified, and tested
 * - Reduces redundant exploration and rework
 * - Improves coherence across sequential improvements
 *
 * **Atomic Writes:**
 * - Uses temp file + rename pattern for crash safety
 * - Session never corrupted mid-append
 *
 * @see {@link ExperienceRecorder.finish} for how tasks are appended
 * @see {@link ContextBuilder.build} for how session is used in context
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
 * Ensures a directory exists, creating parent directories as needed.
 *
 * @param directoryPath - Directory path to ensure exists
 * @returns Promise that resolves when directory is guaranteed to exist
 */
const ensureDir = async (directoryPath: string): Promise<void> => {
  // Uses recursive option to create parent directories automatically
  await fs.mkdir(directoryPath, { recursive: true });
};

/**
 * Formats an array of items as a comma-separated string.
 *
 * Returns "(none)" placeholder when array is empty or undefined.
 *
 * @param items - Array of strings to format
 * @returns Comma-separated string or "(none)" if empty/undefined
 */
const formatList = (items: string[] | undefined): string => {
  if (!items || items.length === 0) {
    return "(none)";
  }
  return items.join(", ");
};

/**
 * Counts task blocks in session content by matching task headers.
 *
 * @param content - Session file content to analyze
 * @returns Number of task blocks found
 */
const countTasks = (content: string): number => {
  // Uses regex with global flag to find all task headers
  const taskHeaderMatches = content.match(TASK_HEADER_RE);
  return taskHeaderMatches?.length ?? 0;
};

/**
 * Formats a task summary as a markdown task block.
 *
 * Creates a structured markdown record showing task number, description, files, commands, and outcome.
 *
 * @param taskNumber - Sequential task number (1-indexed)
 * @param summary - Task summary object to format
 * @returns Formatted markdown task block
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

export class SessionManager implements ISessionManager {
  /** Absolute path to the session markdown file. */
  private readonly sessionPath: string;

  /**
   * Initializes the session manager with data root path.
   *
   * @param deps - Configuration dependencies
   * @param deps.rootDir - Optional data root directory (defaults to `process.cwd()`)
   */
  constructor(readonly deps: { rootDir?: string } = {}) {
    const rootDirectory = deps.rootDir ?? process.cwd();
    this.sessionPath = path.join(rootDirectory, SESSION_REL_PATH);
  }

  /**
   * Reads the session file contents.
   *
   * @returns Full session file contents, or empty string if file doesn't exist
   * @throws Filesystem errors other than ENOENT
   */
  read = async (): Promise<string> => {
    try {
      return await fs.readFile(this.sessionPath, "utf-8");
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") {
        return "";
      }
      throw error;
    }
  };

  /**
   * Checks whether a non-empty session file exists.
   *
   * @returns True if session file exists and has content, false otherwise
   * @throws Filesystem errors other than ENOENT
   */
  exists = async (): Promise<boolean> => {
    try {
      const fileContent = await fs.readFile(this.sessionPath, "utf-8");
      return fileContent.length > 0;
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") {
        return false;
      }
      throw error;
    }
  };

  /**
   * Overwrites the session file with a codebase exploration snapshot.
   *
   * @param snapshot - Codebase exploration snapshot content to save
   * @throws Filesystem errors if directory creation or write fails
   *
   * @remarks
   * Uses atomic write pattern (temp file + rename) for crash safety.
   * Adds timestamp header for snapshot identification.
   */
  saveSnapshot = async (snapshot: string): Promise<void> => {
    const timestampedContent = `[Codebase snapshot — ${new Date().toISOString()}]\n\n${snapshot}\n`;

    const sessionDirectory = path.dirname(this.sessionPath);
    await ensureDir(sessionDirectory);

    const tempFilePath = path.join(
      sessionDirectory,
      `.session-${randomUUID()}.tmp`,
    );
    await fs.writeFile(tempFilePath, timestampedContent, "utf-8");
    await fs.rename(tempFilePath, this.sessionPath);
  };

  /**
   * Appends a formatted task block to the session file.
   *
   * @param summary - Task summary to append to the session
   * @throws Filesystem errors if directory creation or write fails
   *
   * @remarks
   * Uses atomic write pattern (temp file + rename) for crash safety.
   * Auto-numbers tasks based on existing task count.
   * Adds blank line separator between tasks.
   */
  append = async (summary: SessionSummary): Promise<void> => {
    const existingContent = await this.read();
    const nextTaskNumber = countTasks(existingContent) + 1;
    const taskBlock = formatBlock(nextTaskNumber, summary);
    const separator = existingContent.trim().length > 0 ? "\n\n" : "";
    const newSessionContent = `${existingContent}${separator}${taskBlock}\n`;

    const sessionDirectory = path.dirname(this.sessionPath);
    await ensureDir(sessionDirectory);

    const tempFilePath = path.join(
      sessionDirectory,
      `.session-${randomUUID()}.tmp`,
    );
    await fs.writeFile(tempFilePath, newSessionContent, "utf-8");
    await fs.rename(tempFilePath, this.sessionPath);
  };

  /**
   * Deletes the session file and returns a confirmation message.
   *
   * @returns Confirmation message "Session cleared"
   * @throws Filesystem errors other than ENOENT (file not found)
   *
   * @remarks
   * Silently succeeds if session file doesn't exist (already cleared).
   */
  clear = async (): Promise<string> => {
    try {
      await fs.unlink(this.sessionPath);
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== "ENOENT") {
        throw error;
      }
    }
    return "Session cleared";
  };
}
