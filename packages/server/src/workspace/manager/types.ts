/**
 * Types and error classes for workspace manager.
 */

import type { IExperienceRecorder } from "../../orchestration/interfaces.js";

/**
 * Optional context for recording workspace operations (readFile, writeFile).
 *
 * @remarks
 * Passed to workspace methods to enable operation logging and tracking.
 */
export type WorkspaceRecorderContext = {
  recorder?: IExperienceRecorder;
  taskId?: string;
};

/**
 * Outcome of a {@link WorkspaceManager.writeFile} / `editFile` call.
 *
 * @remarks
 * `accepted: false` covers both a plain decline and the user picking
 * "Revise" — `feedback` is only present in the latter case, letting the
 * caller distinguish "declined" from "declined, here's why" without a third
 * boolean flag.
 */
export type FileWriteOutcome =
  | { accepted: true; diff: string }
  | { accepted: false; feedback?: string };

/**
 * Custom error type for workspace-specific failures.
 *
 * @remarks
 * Thrown by WorkspaceManager when file operations fail or preconditions aren't met.
 * Distinguishes between operational errors (NOT_FOUND, OUTSIDE_ROOT) and state
 * errors (NO_ROOT for unbound client, DISPOSED for disposed manager).
 */
export class WorkspaceError extends Error {
  constructor(
    public readonly code: "OUTSIDE_ROOT" | "NO_ROOT" | "NOT_FOUND" | "DISPOSED",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
