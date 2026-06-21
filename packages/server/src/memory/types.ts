/**
 * <Summary>
 * What it does:
 *   Shared shapes for passive task observation, experience persistence, and
 *   downstream pattern extraction.
 *
 * How it fits in the system:
 *   Used by ExperienceRecorder (writes) and PatternExtractor (reads).
 *
 * Dependencies:
 *   None.
 *
 * Dependants:
 *   - experienceRecorder.ts, patternExtractor.ts — record lifecycle.
 *   - orchestration/interfaces.ts — re-exports for IExperienceRecorder.
 * </Summary>
 */

/** Task outcome label stored on finished experience records. */
export type TaskOutcome = "success" | "partial" | "failure";

/**
 * <Summary>
 * What it does:
 *   Terminal command result payload passed into ExperienceRecorder.logCommand.
 *
 * Used by:
 *   - IExperienceRecorder.logCommand.
 * </Summary>
 */
export interface CommandOutput {
  /** Standard output text. */
  stdout: string;

  /** Standard error text. */
  stderr: string;

  /** Process exit code (0 = success). */
  exitCode: number;
}

/**
 * <Summary>
 * What it does:
 *   One file read event appended during a task.
 * </Summary>
 */
export interface ReadEntry {
  /** Workspace-relative or absolute path read. */
  path: string;

  /** ISO-8601 time when the read was logged. */
  timestamp: string;
}

/**
 * <Summary>
 * What it does:
 *   One file write event with diff text appended during a task.
 * </Summary>
 */
export interface WriteEntry {
  /** Path written. */
  path: string;

  /** Unified diff or summary of the change. */
  diff: string;

  /** ISO-8601 time when the write was logged. */
  timestamp: string;
}

/**
 * <Summary>
 * What it does:
 *   One shell command execution logged during a task.
 * </Summary>
 */
export interface CommandEntry {
  /** Command string executed. */
  command: string;

  /** Captured stdout. */
  stdout: string;

  /** Captured stderr. */
  stderr: string;

  /** Exit code. */
  exitCode: number;

  /** ISO-8601 time when the command finished. */
  timestamp: string;
}

/**
 * <Summary>
 * What it does:
 *   One agent escalation and advisor resolution pair.
 * </Summary>
 */
export interface EscalationEntry {
  /** Why the agent escalated. */
  reason: string;

  /** Advisor guidance that resolved the block. */
  guidance: string;

  /** ISO-8601 time when escalation was logged. */
  timestamp: string;
}

/**
 * <Summary>
 * What it does:
 *   One user edit applied after agent output (style preference signal).
 * </Summary>
 */
export interface UserEditEntry {
  /** File path edited. */
  path: string;

  /** Content before user edit. */
  before: string;

  /** Content after user edit. */
  after: string;

  /** ISO-8601 time when edit was logged. */
  timestamp: string;
}

/**
 * <Summary>
 * What it does:
 *   Session summary passed to SessionManager.append on task finish.
 *   ExperienceRecorder builds this from the ExperienceRecord when not supplied.
 *
 * Used by:
 *   - ExperienceRecorder.finish — built from record or caller override.
 *   - SessionManager.append — formats markdown block.
 * </Summary>
 */
export interface SessionSummary {
  /** User task description for the session block header. */
  task?: string;

  /** Paths of files written during the task. */
  filesWritten?: string[];

  /** Command strings executed during the task. */
  commandsRun?: string[];

  /** Task outcome label (success | partial | failure). */
  outcome?: TaskOutcome | string;

  /** Additional fields for forward compatibility. */
  [key: string]: unknown;
}

/**
 * <Summary>
 * What it does:
 *   In-memory and on-disk experience record for one orchestrated task.
 *
 * Produced by:
 *   - ExperienceRecorder.start — initial shape.
 *   - ExperienceRecorder.finish — sets outcome, duration, sessionSummary.
 * </Summary>
 */
export interface ExperienceRecord {
  /** Unique task id (UUID from orchestrator). */
  taskId: string;

  /** Original user task text. */
  task: string;

  /** Unix ms when start() was called. */
  startTime: number;

  /** Files read during the task. */
  filesRead: ReadEntry[];

  /** Files written with diffs. */
  filesWritten: WriteEntry[];

  /** Commands executed. */
  commandsRun: CommandEntry[];

  /** Escalation events. */
  escalations: EscalationEntry[];

  /** User edits after agent output. */
  userEdits: UserEditEntry[];

  /** Final outcome label; null until finish. */
  outcome: TaskOutcome | null;

  /** Elapsed ms; null until finish. */
  duration: number | null;

  /** Optional summary for session file; null until finish. */
  sessionSummary: SessionSummary | null;

  /** Orchestration ok flag from OrchestrationOutcome (persisted for extractor). */
  ok?: boolean;

  /** Error message when orchestration failed. */
  error?: string;
}
