/**
 * <Summary>
 * What it does:
 *   Interface for session management in the orchestration layer.
 *
 * How it fits in the system:
 *   Manages user-data/session/current.md for multi-task continuity within a session.
 *   This interface provides methods to read, append, and clear session data, enabling
 *   the advisor to have context from previous tasks in the same session for better continuity.
 * </Summary>
 */

import type { SessionSummary } from "../../memory/types.js";

/**
 * <Summary>
 * What it does:
 *   Manages user-data/session/current.md for multi-task continuity within a session.
 *
 * Used by:
 *   - ContextBuilder.read — prior session context at task start.
 *   - ExperienceRecorder.finish — append after success or partial.
 *   - Router session.exists / session.clear (when wired).
 *
 * Produced by:
 *   - packages/server/src/memory/sessionManager.ts.
 * </Summary>
 */
export interface ISessionManager {
  /**
   * <Summary>
   * What it does:
   *   Returns full session file contents or empty string when no session exists.
   * </Summary>
   */
  read(): Promise<string>;

  /**
   * <Summary>
   * What it does:
   *   Returns whether user-data/session/current.md exists.
   * </Summary>
   */
  exists(): Promise<boolean>;

  /**
   * <Summary>
   * What it does:
   *   Appends one formatted task summary block to the session file.
   * </Summary>
   */
  append(summary: SessionSummary): Promise<void>;

  /**
   * <Summary>
   * What it does:
   *   Deletes the session file when present; returns a confirmation message.
   * </Summary>
   */
  clear(): Promise<string>;

  /**
   * <Summary>
   * What it does:
   *   Overwrites current.md with a codebase exploration snapshot.
   * </Summary>
   */
  saveSnapshot(snapshot: string): Promise<void>;
}
