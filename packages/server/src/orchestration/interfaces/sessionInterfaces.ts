/**
 * Persists and retrieves session history for multi-task continuity.
 *
 * @remarks
 * Manages the session file (`user-data/session/current.md`) which accumulates task summaries
 * throughout a user session. The session context provides prior work history to the agent at
 * task start, enabling better planning and avoiding redundant work.
 *
 * **Primary consumers:**
 * - **ContextBuilder** — reads session content at task start to build memory context.
 * - **ExperienceRecorder** — appends task summaries after completion.
 * - **Router** — exposes session via `/session` endpoints for user control.
 *
 * @example
 * ```ts
 * const sessionContent = await sessionManager.read();
 * Returns markdown of all completed tasks in the session
 * ```
 */

import type { SessionSummary } from "../../memory/types.js";
export interface ISessionManager {
  /**
   * Reads the complete session history as markdown text.
   *
   * @remarks
   * Returns the full contents of `user-data/session/current.md` if the file exists,
   * or an empty string if no session has been started yet. The session file accumulates
   * task summaries over time.
   *
   * @returns Complete session markdown (task summaries and notes), or empty string if no session exists.
   *
   * @example
   * ```ts
   * const sessionHistory = await sessionManager.read();
   * if (sessionHistory) {
   *   console.log("Prior work this session:", sessionHistory);
   * } else {
   *   console.log("New session, no prior history");
   * }
   * ```
   */
  read(): Promise<string>;

  /**
   * Checks whether a session file currently exists.
   *
   * @returns `true` if `user-data/session/current.md` exists and is readable; `false` otherwise.
   *
   * @example
   * ```ts
   * if (await sessionManager.exists()) {
   *   const history = await sessionManager.read();
   * }
   * ```
   */
  exists(): Promise<boolean>;

  /**
   * Appends a task summary to the session file.
   *
   * @remarks
   * Creates the `user-data/session/` directory and session file if they don't exist.
   * Appends the formatted summary as a new markdown section at the end of the file.
   * Writes are atomic (crash-safe). Summaries accumulate in the session file for
   * multi-task continuity.
   *
   * @param summary - Completed task summary including title, status, outcome, and relevant details.
   *
   * @example
   * ```ts
   * const summary: SessionSummary = {
   *   title: "Fix button styling",
   *   status: "completed",
   *   outcome: "Updated CSS in src/styles/button.css"
   * };
   * await sessionManager.append(summary);
   * ```
   */
  append(summary: SessionSummary): Promise<void>;

  /**
   * Deletes the session file if it exists.
   *
   * @remarks
   * Clears all accumulated session history. The operation is idempotent — calling
   * `clear()` when no session exists returns a confirmation message rather than an error.
   * Useful for resetting session state or when a user wants to start fresh.
   *
   * @returns User-facing confirmation message (e.g., `"Session cleared"` or `"No session to clear"`).
   *
   * @example
   * ```ts
   * const message = await sessionManager.clear();
   * console.log(message); // "Session cleared"
   * ```
   */
  clear(): Promise<string>;

  /**
   * Overwrites the session file with a new snapshot (typically from codebase exploration).
   *
   * @remarks
   * Replaces the current session file entirely with new content. This is typically used
   * to save a codebase structure exploration snapshot or to reset the session with a summary.
   * Creates the session directory if missing. Atomic writes prevent corruption on crash.
   *
   * @param snapshot - Markdown content to write as the new session file (replaces all prior content).
   *
   * @example
   * ```ts
   * const snapshot = "# Codebase Structure\n\n- src/\n  - components/\n  - utils/\n";
   * await sessionManager.saveSnapshot(snapshot);
   * ```
   */
  saveSnapshot(snapshot: string): Promise<void>;
}
