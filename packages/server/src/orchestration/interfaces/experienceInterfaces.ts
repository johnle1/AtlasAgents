/**
 * <Summary>
 * What it does:
 *   Interfaces for experience recording and pattern extraction.
 *
 * How it fits in the system:
 *   Records the lifecycle of orchestrated tasks and extracts reusable preference rules.
 *
 * Dependencies:
 *   - memory/types.js — ExperienceRecord, CommandOutput.
 *   - types.ts — OrchestrationOutcome.
 *
 * Dependants:
 *   - AdvisorOrchestrator, ExperienceRecorder.
 * </Summary>
 */

import type { CommandOutput, ExperienceRecord } from "../../memory/types.js";
import type { OrchestrationOutcome } from "../types.js";

/**
 * <Summary>
 * What it does:
 *   Records the lifecycle of one orchestrated task for experience replay and pattern extraction.
 *
 * Used by:
 *   - AdvisorOrchestrator.runTask — bracketing one user task.
 *
 * Produced by:
 *   - Future packages/server/src/memory/experienceRecorder.ts implementation.
 * </Summary>
 */
export interface IExperienceRecorder {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Opens a new in-memory experience record when a task begins.
   * </Summary>
   */
  start(taskId: string, taskText: string): Promise<void>;

  /**
   * <Summary>
   * What it does:
   *   Appends a file read to the active record (no-op if task unknown).
   * </Summary>
   */
  logRead(taskId: string, path: string): void;

  /**
   * <Summary>
   * What it does:
   *   Appends a file write with diff to the active record.
   * </Summary>
   */
  logWrite(taskId: string, path: string, diff: string): void;

  /**
   * <Summary>
   * What it does:
   *   Appends a terminal command run to the active record.
   * </Summary>
   */
  logCommand(taskId: string, command: string, output: CommandOutput): void;

  /**
   * <Summary>
   * What it does:
   *   Appends an escalation and advisor guidance pair.
   * </Summary>
   */
  logEscalation(taskId: string, reason: string, guidance: string): void;

  /**
   * <Summary>
   * What it does:
   *   Appends a user edit (before/after) for style learning.
   * </Summary>
   */
  logUserEdit(
    taskId: string,
    path: string,
    before: string,
    after: string,
  ): void;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Persists the record, optional snapshot cleanup, session append, and
   *   fire-and-forget pattern extraction; returns without awaiting learning.
   * </Summary>
   */
  finish(
    taskId: string,
    outcome: OrchestrationOutcome,
    sessionSummary?: unknown,
  ): Promise<void>;
}

/**
 * <Summary>
 * What it does:
 *   Asynchronously extracts reusable preference rules from a finished experience.
 *
 * Produced by:
 *   - packages/server/src/memory/patternExtractor.ts.
 *
 * Dependants:
 *   - ExperienceRecorder.finish — triggered fire-and-forget.
 * </Summary>
 */
export interface IPatternExtractor {
  /**
   * <Summary>
   * What it does:
   *   Schedules async extraction; must not block the caller.
   * </Summary>
   */
  extract(record: ExperienceRecord): void;
}
