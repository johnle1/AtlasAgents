/**
 * Records task activity for experience persistence and pattern extraction.
 *
 * @remarks
 * Implements {@link IExperienceRecorder} for the orchestration layer.
 * Records everything the agent does during a task:
 * - Files read and written (with diffs)
 * - Shell commands executed (with output)
 * - Agent escalations and resolutions
 * - User corrections to subagent output
 *
 * **Workflow:**
 * 1. `start(taskId, taskText)` — Create in-memory record
 * 2. `log*(taskId, ...)` — Append events during execution (non-blocking)
 * 3. `finish(taskId, outcome)` — Persist to disk and trigger learning
 *
 * **Key Design:**
 * - Fire-and-forget learning: persist and extract asynchronously
 * - Experiences written to `user-data/experiences/<timestamp>-<taskId>.json`
 * - Snapshots cleaned up in background after successful tasks
 * - Session summaries appended to `user-data/session/current.md` for continuity
 *
 * @see {@link PatternExtractor} for how experiences are analyzed
 */

// ===== FILESYSTEM IMPORTS =====
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ===== INTERFACE IMPORTS =====
import type {
  IExperienceRecorder,
  IPatternExtractor,
} from "../../orchestration/interfaces.js";

// ===== TYPE DEFINITION IMPORTS =====
import type { OrchestrationOutcome } from "../../orchestration/types.js";
import type {
  CommandOutput,
  ExperienceRecord,
  SessionSummary,
  TaskOutcome,
} from "../types.js";

// ===== CONSTANTS IMPORTS =====
import { EXPERIENCES_DIR, SNAPSHOTS_DIR } from "./experienceConstants.js";

// ===== HELPER FUNCTIONS IMPORTS =====
import { deriveOutcome } from "./experienceHelpers.js";
import { logger } from "../../logger.js";
import { atomicWriteJson } from "../../utils/atomicWriteJson.js";

export class ExperienceRecorder implements IExperienceRecorder {
  /**
   * Base directory for user-data paths (defaults to process.cwd()).
   * Used as the root for constructing paths to experiences and snapshots directories.
   */
  private readonly rootDirectory: string;

  /**
   * Absolute path to user-data/experiences/.
   * Location where finished task records are persisted as JSON files.
   */
  private readonly experiencesDirectory: string;

  /**
   * Absolute path to user-data/snapshots/.
   * Location where temporary snapshots are stored for rollback capability.
   */
  private readonly snapshotsDirectory: string;

  /**
   * Active in-flight records keyed by taskId until finish removes them.
   * Map stores ExperienceRecord objects for tasks currently in progress.
   * Key is the taskId (UUID), value is the in-memory record object.
   */
  private readonly activeRecords = new Map<string, ExperienceRecord>();

  /**
   * Initializes recorder with storage paths and extraction dependencies.
   *
   * @param dependencies - Services for pattern extraction and session management
   * @param dependencies.rootDir - Optional data root (defaults to process.cwd())
   * @param dependencies.patternExtractor - Extractor to trigger on task completion
   * @param dependencies.sessionManager - Optional session manager for continuity
   */
  constructor(
    private readonly dependencies: {
      rootDir?: string;
      patternExtractor: IPatternExtractor;
      sessionManager?: {
        append: (summary: SessionSummary) => Promise<void> | void;
      };
    },
  ) {
    this.rootDirectory = dependencies.rootDir ?? process.cwd();
    this.experiencesDirectory = path.join(this.rootDirectory, EXPERIENCES_DIR);
    this.snapshotsDirectory = path.join(this.rootDirectory, SNAPSHOTS_DIR);
  }

  /**
   * Opens a new in-memory experience record for a task (no disk write).
   *
   * @param taskId - Unique task ID (UUID from orchestrator)
   * @param taskText - Original user task description
   * @returns Resolves when in-memory record is ready
   *
   * @remarks
   * Creates empty ExperienceRecord with all log arrays initialized.
   * Final fields (outcome, duration, sessionSummary) remain null until `finish()`.
   * Record is registered in activeRecords map for subsequent log* and finish calls.
   */
  start = async (taskId: string, taskText: string): Promise<void> => {
    const record: ExperienceRecord = {
      taskId,
      task: taskText,
      startTime: Date.now(),
      filesRead: [],
      filesWritten: [],
      commandsRun: [],
      escalations: [],
      userEdits: [],
      outcome: null,
      duration: null,
      sessionSummary: null,
    };
    this.activeRecords.set(taskId, record);
  };

  /**
   * Logs a file read event during task execution.
   *
   * @param taskId - Task ID from `start()`
   * @param filePath - Path that was read
   *
   * @remarks
   * Appends read entry with ISO timestamp. No-op if task not found (already finished
   * or never started). Timestamps enable audit trail and event ordering.
   */
  logRead = (taskId: string, filePath: string): void => {
    const record = this.activeRecords.get(taskId);
    if (!record) {
      return;
    }
    record.filesRead.push({
      path: filePath,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * Logs a file write event with diff during task execution.
   *
   * @param taskId - Task ID from `start()`
   * @param filePath - Path that was written
   * @param diffContent - Unified diff or change summary
   *
   * @remarks
   * Appends write entry with ISO timestamp. No-op if task not found.
   * Diffs are used by PatternExtractor to learn style preferences and by
   * upstream code for replay/verification.
   */
  logWrite = (taskId: string, filePath: string, diffContent: string): void => {
    const record = this.activeRecords.get(taskId);
    if (!record) {
      return;
    }
    record.filesWritten.push({
      path: filePath,
      diff: diffContent,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * Logs a shell command execution with output during task.
   *
   * @param taskId - Task ID from `start()`
   * @param command - Shell command string that ran
   * @param output - Captured stdout, stderr, and exit code
   *
   * @remarks
   * Appends command entry with ISO timestamp. No-op if task not found.
   * Full output (stdout, stderr, exitCode) is persisted for experience replay
   * and command-result pattern extraction.
   */
  logCommand = (
    taskId: string,
    command: string,
    output: CommandOutput,
  ): void => {
    const record = this.activeRecords.get(taskId);
    if (!record) {
      return;
    }
    record.commandsRun.push({
      command,
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: output.exitCode,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * Logs an agent escalation with user/agent resolution.
   *
   * @param taskId - Task ID from `start()`
   * @param reason - Why the agent escalated (error/blocker)
   * @param guidance - User or agent text that unblocked the agent
   *
   * @remarks
   * Appends escalation pair with ISO timestamp. No-op if task not found.
   * Escalations are analyzed by PatternExtractor to derive fix rules
   * (workarounds for similar issues in the future).
   */
  logEscalation = (taskId: string, reason: string, guidance: string): void => {
    const record = this.activeRecords.get(taskId);
    if (!record) {
      return;
    }
    record.escalations.push({
      reason,
      guidance,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * Logs a user correction to subagent output for style preference learning.
   *
   * @param taskId - Task ID from `start()`
   * @param filePath - File the user edited
   * @param before - Content before user change
   * @param after - Content after user change
   *
   * @remarks
   * Appends before/after pair with ISO timestamp. No-op if task not found.
   * User edits are analyzed by PatternExtractor to extract style preferences
   * (formatting, conventions, tone) that the agent should learn to match.
   */
  logUserEdit = (
    taskId: string,
    filePath: string,
    before: string,
    after: string,
  ): void => {
    const record = this.activeRecords.get(taskId);
    if (!record) {
      return;
    }
    record.userEdits.push({
      path: filePath,
      before,
      after,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * Finalizes task record, persists to disk, and triggers async learning.
   *
   * @param taskId - Same ID passed to `start()`
   * @param outcome - Orchestration result (ok flag, error, plan)
   * @param sessionSummary - Optional custom summary; auto-generated if omitted
   * @returns Resolves after persist and async triggers; does not await pattern extraction
   *
   * @remarks
   * **Fire-and-forget async operations:**
   * 1. Derives TaskOutcome from orchestrator result + logged activity
   * 2. Persists record to `user-data/experiences/<timestamp>-<taskId>.json` (atomic write)
   * 3. On success, schedules snapshot cleanup (background, non-blocking)
   * 4. On success/partial, appends session summary for continuity
   * 5. Triggers PatternExtractor.extract() without awaiting (learning is async)
   * 6. Removes record from activeRecords to free memory
   *
   * Persist failures are logged but do not break orchestrator. Extraction and cleanup
   * errors are logged separately and don't block return.
   */
  finish = async (
    taskId: string,
    outcome: OrchestrationOutcome,
    sessionSummary?: SessionSummary,
  ): Promise<void> => {
    const record = this.activeRecords.get(taskId);
    if (!record) {
      return;
    }

    // Derive outcome from orchestrator result + logged activity
    const taskOutcome = deriveOutcome(outcome, record);
    record.outcome = taskOutcome;
    record.duration = Date.now() - record.startTime;
    const summary: SessionSummary = sessionSummary ?? {
      task: record.task,
      filesWritten: record.filesWritten.map((w) => w.path),
      commandsRun: record.commandsRun.map((c) => c.command),
      outcome: taskOutcome,
    };
    record.sessionSummary = summary;
    record.ok = outcome.ok;
    record.error = outcome.error;

    // Persist to disk with atomic write pattern
    const timestampValue = Date.now();
    const fileName = `${timestampValue}-${taskId}.json`;
    const destinationPath = path.join(this.experiencesDirectory, fileName);

    try {
      await atomicWriteJson(destinationPath, record, "experience");
    } catch (error) {
      // Persist failure must not break orchestrator
      logger.error({ taskId, err: error }, "Failed to persist experience");
      // Early return: don't proceed with cleanup/session/learning if persist failed
      this.activeRecords.delete(taskId);
      return;
    }

    // Clean up snapshots for successful tasks (background, non-blocking)
    if (taskOutcome === "success") {
      void this.cleanupSnapshots(taskId).catch((error) => {
        logger.error({ taskId, err: error }, "Snapshot cleanup failed");
      });
    }

    // Append to session file for continuity on useful outcomes
    if (
      (taskOutcome === "success" || taskOutcome === "partial") &&
      this.dependencies.sessionManager
    ) {
      try {
        await Promise.resolve(this.dependencies.sessionManager.append(summary));
      } catch (error) {
        logger.error({ taskId, err: error }, "sessionManager.append failed");
      }
    }

    // Free memory
    this.activeRecords.delete(taskId);

    // Trigger learning asynchronously (fire-and-forget)
    try {
      this.dependencies.patternExtractor.extract(record);
    } catch (error) {
      logger.error({ taskId, err: error }, "patternExtractor.extract failed");
    }
  };

  /**
   * Deletes snapshot files for a completed task from user-data/snapshots/.
   *
   * @param taskId - Task ID embedded in snapshot filenames
   * @returns Resolves after best-effort deletes (one failure doesn't stop others)
   *
   * @remarks
   * **Graceful handling:**
   * - Missing snapshots directory (ENOENT): returns without error (expected on fresh install)
   * - Per-file delete failures: logged but don't block other deletes
   * - Filenames filtered by taskId (name.includes(taskId))
   *
   * Deletes run in parallel via Promise.all. Errors are logged per-file but
   * never propagated.
   */
  private cleanupSnapshots = async (taskId: string): Promise<void> => {
    let snapshotFilenames: string[];
    try {
      snapshotFilenames = await fs.readdir(this.snapshotsDirectory);
    } catch (error) {
      // Snapshots dir missing on fresh install — nothing to clean
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") {
        return;
      }
      throw error;
    }

    // Filter filenames containing taskId
    const matchingFilenames = snapshotFilenames.filter((filename) =>
      filename.includes(taskId),
    );

    // Delete in parallel; one failure doesn't stop others
    await Promise.all(
      matchingFilenames.map((filename) =>
        fs
          .unlink(path.join(this.snapshotsDirectory, filename))
          .catch((unlinkError) => {
            logger.error(
              { taskId, filename, err: unlinkError },
              "Failed to delete snapshot",
            );
          }),
      ),
    );
  };
}
