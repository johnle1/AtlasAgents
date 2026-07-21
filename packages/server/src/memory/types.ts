/**
 * Shared types for task observation, experience persistence, and pattern extraction.
 *
 * @remarks
 * This module defines the data shapes for the memory system's core workflow:
 * 1. **ExperienceRecorder** captures task activity (files, commands, escalations, edits)
 * 2. **SessionManager** persists continuity across tasks in a session file
 * 3. **PatternExtractor** analyzes experiences to extract reusable preference rules
 *
 * All types use ISO-8601 timestamps and are designed for JSON serialization to disk.
 */

// ===== ORCHESTRATION TYPE IMPORTS =====
import type { PreferenceRule } from "../orchestration/interfaces.js";

/**
 * Outcome of a completed orchestrated task.
 *
 * - `success` — Task completed as requested
 * - `partial` — Task partially completed; some goals achieved but work remains
 * - `failure` — Task failed; no meaningful progress or error occurred
 */
export type TaskOutcome = "success" | "partial" | "failure";

/**
 * Result of a shell command execution.
 *
 * Passed to {@link ExperienceRecorder.logCommand} to record terminal activity.
 */
export interface CommandOutput {
  /** Standard output (stdout) captured from the command. */
  stdout: string;

  /** Standard error (stderr) captured from the command. */
  stderr: string;

  /** Process exit code (0 = success, non-zero = failure). */
  exitCode: number;
}

/**
 * One file read event logged during a task.
 *
 * Used by {@link ExperienceRecorder} to track files accessed during execution.
 */
export interface ReadEntry {
  /** Workspace-relative or absolute file path that was read. */
  path: string;

  /** ISO-8601 timestamp when the read was logged. */
  timestamp: string;
}

/**
 * One file write event with diff information.
 *
 * Used by {@link ExperienceRecorder} to track modifications made during execution.
 */
export interface WriteEntry {
  /** File path that was written or modified. */
  path: string;

  /** Unified diff or summary of the change made to the file. */
  diff: string;

  /** ISO-8601 timestamp when the write was logged. */
  timestamp: string;
}

/**
 * One shell command execution record.
 *
 * Captured by {@link ExperienceRecorder.logCommand} to track terminal operations.
 */
export interface CommandEntry {
  /** The shell command string that was executed. */
  command: string;

  /** Standard output produced by the command. */
  stdout: string;

  /** Standard error produced by the command. */
  stderr: string;

  /** Process exit code (0 = success, non-zero = failure). */
  exitCode: number;

  /** ISO-8601 timestamp when the command completed. */
  timestamp: string;
}

/**
 * One agent escalation event with its resolution.
 *
 * Recorded when the agent gets stuck and requires user/agent guidance to proceed.
 */
export interface EscalationEntry {
  /** Description of why the agent escalated (the blocker or error). */
  reason: string;

  /** Advisor or user guidance that unblocked the agent. */
  guidance: string;

  /** ISO-8601 timestamp when the escalation was logged. */
  timestamp: string;
}

/**
 * One user correction applied after subagent output.
 *
 * Represents style preferences or corrections the user made to the agent's work.
 * Used by {@link PatternExtractor} to learn style preferences.
 */
export interface UserEditEntry {
  /** File path that the user edited. */
  path: string;

  /** File content before the user's edit. */
  before: string;

  /** File content after the user's edit. */
  after: string;

  /** ISO-8601 timestamp when the edit was logged. */
  timestamp: string;
}

/**
 * Summary of a completed task for session continuity.
 *
 * @remarks
 * Built by {@link ExperienceRecorder.finish} from the full {@link ExperienceRecord}
 * and passed to {@link SessionManager.append} for session file updates.
 * Provides a concise snapshot of task activity for agents to understand
 * prior work in the same session.
 *
 * All fields are optional to support flexible summaries.
 */
export interface SessionSummary {
  /** Description of the task that was attempted. */
  task?: string;

  /** Paths of files written or modified during the task. */
  filesWritten?: string[];

  /** Shell commands executed during the task. */
  commandsRun?: string[];

  /** Task outcome: `success`, `partial`, or `failure`. */
  outcome?: TaskOutcome | string;

  /** Additional fields for extensibility and forward compatibility. */
  [key: string]: unknown;
}

/**
 * Complete in-memory and on-disk record of one orchestrated task.
 *
 * @remarks
 * Lifecycle:
 * - Created by {@link ExperienceRecorder.start} with minimal fields
 * - Updated throughout task execution via `logRead`, `logWrite`, `logCommand`, etc.
 * - Finalized by {@link ExperienceRecorder.finish} with outcome and duration
 * - Persisted to disk as JSON in `user-data/experiences/`
 * - Analyzed by {@link PatternExtractor} to extract preference rules
 *
 * Fields are populated incrementally; null fields indicate the task is still in progress.
 */
export interface ExperienceRecord {
  /** Unique task identifier (UUID assigned by orchestrator). */
  taskId: string;

  /** Original user task description or request. */
  task: string;

  /** Unix timestamp (milliseconds) when the task started. */
  startTime: number;

  /** All files read during the task execution. */
  filesRead: ReadEntry[];

  /** All files written or modified during the task. */
  filesWritten: WriteEntry[];

  /** All shell commands executed during the task. */
  commandsRun: CommandEntry[];

  /** Agent escalations and their resolutions. */
  escalations: EscalationEntry[];

  /** User corrections or edits to subagent output. */
  userEdits: UserEditEntry[];

  /** Task outcome: `success`, `partial`, or `failure`. Null until task finishes. */
  outcome: TaskOutcome | null;

  /** Elapsed time in milliseconds. Null until task finishes. */
  duration: number | null;

  /** Session continuity summary. Null until task finishes. */
  sessionSummary: SessionSummary | null;

  /** Orchestration success flag from final outcome. */
  ok?: boolean;

  /** Error message if orchestration failed. */
  error?: string;
}

/**
 * One markdown pattern file loaded from the patterns directory.
 *
 * Used by {@link ContextBuilder} to load project-specific patterns for context injection.
 */
export type PatternFile = {
  /** Original filename (e.g., "architecture.md"). */
  name: string;

  /** Full UTF-8 file content. */
  body: string;
};

/**
 * Dependencies required for consolidation scheduling.
 *
 * @remarks
 * Minimal interface providing only what the scheduler needs to:
 * - Read the last consolidation timestamp
 * - Update it after successful consolidation
 * - Trigger the consolidation operation
 *
 * This design allows the scheduler to work independently without coupling
 * to the full service graph.
 */
export type ConsolidationSchedulerDeps = {
  /**
   * Configuration manager for reading and updating consolidation timestamps.
   */
  config: {
    /**
     * Retrieves all configuration values including `lastConsolidatedAt`.
     *
     * @returns Promise resolving to configuration object
     */
    getAll: () => Promise<Record<string, unknown>>;

    /**
     * Updates a configuration key-value pair.
     *
     * @param configKey - The configuration key to update (e.g., "lastConsolidatedAt")
     * @param configValue - The new value (e.g., ISO-8601 timestamp string)
     */
    set: (configKey: string, configValue: unknown) => Promise<void>;
  };

  /**
   * Preference store for performing consolidation operations.
   */
  prefs: {
    /**
     * Merges duplicate rules and removes redundancy from the preference store.
     * Uses the subagent model to intelligently consolidate similar rules.
     */
    consolidate: () => Promise<void>;
  };
};

/**
 * Preference rules file structure for persistence.
 *
 * @remarks
 * Format used by {@link PreferenceStore} for persisting rules to disk.
 * Stored as JSON in `user-data/preferences.json`.
 */
export type PreferencesFile = {
  /** File format version for future migrations. */
  version: 1;

  /** Array of user preference rules. */
  rules: PreferenceRule[];
};
