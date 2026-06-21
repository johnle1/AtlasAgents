/**
 * <Summary>
 * What it does:
 *   Helper functions for experience recorder including directory operations,
 *   activity checking, and outcome derivation.
 *
 * How it fits in the system:
 *   Provides utility functions for file I/O and experience record processing.
 *   These helpers encapsulate common operations used by the ExperienceRecorder class.
 *
 * Dependencies:
 *   - node:fs/promises - async filesystem operations.
 *   - types.js - ExperienceRecord, TaskOutcome.
 *   - orchestration/types.js - OrchestrationOutcome.
 *
 * Dependants:
 *   - experienceRecorder.ts - uses these helpers in the ExperienceRecorder class.
 * </Summary>
 */

// ===== FILESYSTEM IMPORTS =====
import * as fs from "node:fs/promises";

// ===== TYPE DEFINITION IMPORTS =====
import type { OrchestrationOutcome } from "../../orchestration/types.js";
import type { ExperienceRecord, TaskOutcome } from "../types.js";

/**
 * @async
 * <Summary>
 * What it does:
 *   Ensures a directory exists before writing experience or temp files inside it.
 *
 * How it does it (step by step):
 *   1. Call fs.mkdir with recursive true so parent directories are created as needed.
 *   2. Complete when the directory exists (no-op if already present).
 *
 * Parameters:
 *   @param {string} directoryPath — Absolute directory path.
 *
 * Returns:
 *   @returns {Promise<void>} — Completes after mkdir -p.
 *
 * Dependencies:
 *   - node:fs/promises.mkdir.
 *
 * Dependants:
 *   - ExperienceRecorder.finish — before atomic experience write.
 * </Summary>
 */
export const ensureDir = async (directoryPath: string): Promise<void> => {
  // Step 1: Create directory tree (mkdir -p semantics)
  await fs.mkdir(directoryPath, { recursive: true });
};

/**
 * <Summary>
 * What it does:
 *   Returns whether the experience record captured any observable activity
 *   (reads, writes, commands, escalations, or user edits).
 *
 * How it does it (step by step):
 *   1. Check filesRead length.
 *   2. Check filesWritten length.
 *   3. Check commandsRun length.
 *   4. Check escalations length.
 *   5. Check userEdits length.
 *   6. Return true if any array is non-empty.
 *
 * Parameters:
 *   @param {ExperienceRecord} record — In-memory task record.
 *
 * Returns:
 *   @returns {boolean} — True when at least one log category has entries.
 *
 * Dependencies:
 *   None.
 *
 * Dependants:
 *   - deriveOutcome — distinguishes partial vs bare failure.
 * </Summary>
 */
export const hasActivity = (experienceRecord: ExperienceRecord): boolean => {
  // Step 1–5: Any non-empty log array means the task did something worth recording
  // This includes reading files, writing files, running commands, escalating to advisor,
  // or capturing user edits. All of these indicate meaningful activity that should be learned from.
  return (
    experienceRecord.filesRead.length > 0 ||
    experienceRecord.filesWritten.length > 0 ||
    experienceRecord.commandsRun.length > 0 ||
    experienceRecord.escalations.length > 0 ||
    experienceRecord.userEdits.length > 0
  );
};

/**
 * <Summary>
 * What it does:
 *   Maps orchestrator success/failure plus logged activity into a stored
 *   TaskOutcome label (success, partial, or failure).
 *
 * How it does it (step by step):
 *   1. If orchestration.ok is true, return success.
 *   2. Else if the record has any logged activity, return partial.
 *   3. Else return failure (task failed without meaningful attempt data).
 *
 * Parameters:
 *   @param {OrchestrationOutcome} orchestration — Result from AdvisorOrchestrator.
 *   @param {ExperienceRecord} record — Same task's in-memory log arrays.
 *
 * Returns:
 *   @returns {TaskOutcome} — success | partial | failure.
 *
 * Dependencies:
 *   - hasActivity.
 *
 * Dependants:
 *   - ExperienceRecorder.finish.
 * </Summary>
 */
export const deriveOutcome = (
  orchestrationOutcome: OrchestrationOutcome,
  experienceRecord: ExperienceRecord,
): TaskOutcome => {
  // Step 1: Orchestrator completed the DAG and emitted user-visible output
  if (orchestrationOutcome.ok) {
    return "success";
  }
  // Step 2: Failed but we still have reads/writes/commands/etc. for learning
  // "Partial" means the task failed but generated useful data that should be preserved
  // for learning patterns and rules from the attempted actions
  if (hasActivity(experienceRecord)) {
    return "partial";
  }
  // Step 3: Hard failure with no activity (e.g. plan error before any log* calls)
  // "Failure" means the task failed so early that no useful data was generated
  // Such failures are not useful for learning since they represent planning errors
  return "failure";
};
