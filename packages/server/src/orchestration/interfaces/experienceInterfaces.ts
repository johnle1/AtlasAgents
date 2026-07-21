/**
 * Records the lifecycle of orchestrated tasks and extracts reusable patterns and preferences.
 *
 * @remarks
 * Captures comprehensive information about each completed task (inputs, outputs, edits, escalations)
 * and feeds that experience into the preference learning system. Future tasks can then leverage
 * these learned preferences for better planning and execution.
 */

import type { CommandOutput, ExperienceRecord } from "../../memory/types.js";
import type { OrchestrationOutcome } from "../types.js";

/**
 * Records the complete lifecycle of one orchestrated task for learning and replay.
 *
 * @remarks
 * Starts when a task begins and accumulates data as the task progresses: file operations,
 * command execution, escalations, and user edits. When the task finishes, all recorded
 * information is persisted and optionally analyzed for preference extraction (fire-and-forget).
 *
 * **Typical flow:**
 * 1. `start()` — open a new record at task start.
 * 2. `logRead()`, `logWrite()`, `logCommand()` — append operations as they happen.
 * 3. `logEscalation()`, `logUserEdit()` — record escalations and user corrections.
 * 4. `finish()` — close the record and trigger async pattern extraction.
 *
 * @example
 * ```ts
 * await recorder.start("task-123", "Fix the login form");
 * await recorder.logRead("task-123", "src/forms/login.tsx");
 * ... execution happens ...
 * await recorder.finish("task-123", { status: "completed" });
 * ```
 */
export interface IExperienceRecorder {
  /**
   * Opens a new in-memory experience record when a task begins.
   *
   * @remarks
   * Must be called before any `log*` operations. Initializes a fresh record with
   * the task ID and task text. Subsequent log operations reference this task ID.
   *
   * @param taskId - Unique identifier for this task (typically UUID or numeric ID).
   * @param taskText - Original user task request text.
   *
   * @example
   * ```ts
   * await recorder.start("task-abc123", "Fix the header styling in the landing page");
   * ```
   */
  start(taskId: string, taskText: string): Promise<void>;

  /**
   * Records a file read operation.
   *
   * @remarks
   * Appends the file path to the task's recorded inputs. This tracks which files
   * were consulted. No-op if the task is unknown (not started).
   *
   * @param taskId - Task identifier from `start()`.
   * @param path - File path read (can be absolute or workspace-relative).
   *
   * @example
   * ```ts
   * recorder.logRead("task-abc123", "src/styles/header.css");
   * ```
   */
  logRead(taskId: string, path: string): void;

  /**
   * Records a file write operation with a unified diff.
   *
   * @remarks
   * Captures file modifications for output tracking and style learning.
   * The diff shows the exact changes made (before/after lines).
   *
   * @param taskId - Task identifier from `start()`.
   * @param path - File path that was modified.
   * @param diff - Unified diff string showing the changes (e.g., output from `git diff`).
   *
   * @example
   * ```ts
   * const diff = `--- a/src/button.tsx\n+++ b/src/button.tsx\n@@ -1,3 +1,4 @@\n...`;
   * recorder.logWrite("task-abc123", "src/button.tsx", diff);
   * ```
   */
  logWrite(taskId: string, path: string, diff: string): void;

  /**
   * Records a shell command execution and its output.
   *
   * @remarks
   * Captures what commands were run and what they produced (stdout, stderr, exit code).
   * Useful for understanding the execution path and for replay.
   *
   * @param taskId - Task identifier from `start()`.
   * @param command - The command executed (e.g., `"npm test"`, `"git commit ..."`).
   * @param output - Command result including stdout, stderr, and exit code.
   *
   * @example
   * ```ts
   * recorder.logCommand("task-abc123", "npm run test", {
   *   stdout: "PASS all tests",
   *   stderr: "",
   *   exitCode: 0
   * });
   * ```
   */
  logCommand(taskId: string, command: string, output: CommandOutput): void;

  /**
   * Records an agent escalation and the user's guidance response.
   *
   * @remarks
   * Escalations occur when the agent cannot proceed autonomously and needs clarification.
   * The user's guidance response is captured for preference and pattern learning.
   *
   * @param taskId - Task identifier from `start()`.
   * @param reason - Why the agent escalated (e.g., `"ambiguous task requirements"`).
   * @param guidance - The user's clarification or correction (used for learning).
   *
   * @example
   * ```ts
   * recorder.logEscalation(
   *   "task-abc123",
   *   "Unclear whether to use Bootstrap or Tailwind CSS",
   *   "Use Tailwind CSS for new components"
   * );
   * ```
   */
  logEscalation(taskId: string, reason: string, guidance: string): void;

  /**
   * Records a user's manual edit to agent output for style learning.
   *
   * @remarks
   * When a user modifies the agent's output, the before/after snapshot is recorded
   * and used to extract code style and pattern preferences.
   *
   * @param taskId - Task identifier from `start()`.
   * @param path - File path the user edited.
   * @param before - Original content generated by the agent.
   * @param after - Modified content after user editing.
   *
   * @example
   * ```ts
   * recorder.logUserEdit(
   *   "task-abc123",
   *   "src/component.tsx",
   *   "const x = 1;",
   *   "const x: number = 1;"
   * );
   * Learns: prefer explicit TypeScript type annotations
   * ```
   */
  logUserEdit(
    taskId: string,
    path: string,
    before: string,
    after: string,
  ): void;

  /**
   * Persists the completed task record and triggers async pattern extraction.
   *
   * @remarks
   * Closes the task record and saves it to storage. Asynchronously extracts patterns
   * and preferences from the recorded experience (fire-and-forget, returns immediately).
   * Optionally appends a summary to the session file for multi-task continuity.
   *
   * @param taskId - Task identifier from `start()`.
   * @param outcome - Final outcome of the task (success, partial, escalation, error).
   * @param sessionSummary - Optional summary to append to the session file.
   *
   * @example
   * ```ts
   * await recorder.finish("task-abc123", { status: "completed" }, {
   *   title: "Fix header styling",
   *   status: "completed"
   * });
   * Record is persisted; pattern extraction happens in background
   * ```
   */
  finish(
    taskId: string,
    outcome: OrchestrationOutcome,
    sessionSummary?: unknown,
  ): Promise<void>;
}

/**
 * Asynchronously extracts reusable preference rules and patterns from completed task experiences.
 *
 * @remarks
 * Called asynchronously (fire-and-forget) after each task completes. Analyzes the recorded
 * task experience (file operations, commands, user edits, escalations) to extract learnable
 * patterns: coding style preferences, common fixes, task domain hints, etc.
 * Extracted patterns are stored in the preference store for future task context building.
 *
 * @example
 * ```ts
 * Called implicitly during recorder.finish()
 * extractor.extract(experienceRecord);
 * No await needed; extraction happens in background
 * ```
 */
export interface IPatternExtractor {
  /**
   * Asynchronously extracts patterns from a completed task experience.
   *
   * @remarks
   * Must not block the caller — this method schedules extraction and returns immediately.
   * Extraction runs in the background using the configured model for analysis (if needed).
   * Extracted patterns are persisted to the preference store automatically.
   *
   * @param record - Completed experience record containing all logged operations and outcomes.
   *
   * @example
   * ```ts
   * After task completes
   * extractor.extract(record);
   * Extraction begins asynchronously; function returns immediately
   * User can continue with the next task without waiting
   * ```
   */
  extract(record: ExperienceRecord): void;
}
