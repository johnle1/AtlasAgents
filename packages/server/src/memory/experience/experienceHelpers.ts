/**
 * Helper functions for experience record processing.
 *
 * @remarks
 * This module provides utility functions used by the ExperienceRecorder to
 * determine whether a task generated meaningful activity and to classify task
 * outcomes. These helpers encapsulate the logic for filtering empty records
 * and mapping orchestration results to stored outcome labels.
 */

// ===== TYPE DEFINITION IMPORTS =====
import type { OrchestrationOutcome } from "../../orchestration/types.js";
import type { ExperienceRecord, TaskOutcome } from "../types.js";

/**
 * Returns whether the experience record captured any observable activity.
 *
 * @remarks
 * This function checks if a task generated any data worth learning from:
 * file reads, file writes, command executions, escalations, or user edits.
 * Records with no activity are typically discarded as they represent planning
 * errors or tasks that failed before any work began.
 *
 * @param experienceRecord - The in-memory task record containing log arrays.
 * @returns True if at least one log category (reads, writes, commands, escalations, or user edits) has entries.
 *
 * @example
 * ```ts
 * const record: ExperienceRecord = {
 *   filesRead: ["/path/to/file.ts"],
 *   filesWritten: [],
 *   commandsRun: [],
 *   escalations: [],
 *   userEdits: []
 * };
 * hasActivity(record); // true
 * ```
 */
export const hasActivity = (experienceRecord: ExperienceRecord): boolean => {
  return (
    experienceRecord.filesRead.length > 0 ||
    experienceRecord.filesWritten.length > 0 ||
    experienceRecord.commandsRun.length > 0 ||
    experienceRecord.escalations.length > 0 ||
    experienceRecord.userEdits.length > 0
  );
};

/**
 * Maps orchestrator success/failure plus logged activity into a TaskOutcome label.
 *
 * @remarks
 * This function classifies task outcomes into three categories:
 * - "success": The orchestrator completed successfully and produced output.
 * - "partial": The task failed but generated useful activity data (reads, writes, commands, etc.)
 *   that should be preserved for learning patterns from attempted actions.
 * - "failure": The task failed before any meaningful activity was logged, typically
 *   due to planning errors. Such records are not useful for learning.
 *
 * @param orchestrationOutcome - The result from AgentOrchestrator indicating success or failure.
 * @param experienceRecord - The same task's in-memory log arrays containing activity data.
 * @returns One of "success", "partial", or "failure".
 *
 * @example
 * ```ts
 * const outcome: OrchestrationOutcome = { ok: false, output: null };
 * const record: ExperienceRecord = {
 *   filesRead: ["/path/to/file.ts"],
 *   filesWritten: [],
 *   commandsRun: [],
 *   escalations: [],
 *   userEdits: []
 * };
 * deriveOutcome(outcome, record); // "partial"
 * ```
 */
export const deriveOutcome = (
  orchestrationOutcome: OrchestrationOutcome,
  experienceRecord: ExperienceRecord,
): TaskOutcome => {
  if (orchestrationOutcome.ok) {
    return "success";
  }
  if (hasActivity(experienceRecord)) {
    return "partial";
  }
  return "failure";
};
