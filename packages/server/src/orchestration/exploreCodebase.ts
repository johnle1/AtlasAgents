/**
 * <Summary>
 * What it does:
 *   One-time codebase exploration that builds a session snapshot from directory structure only.
 *
 * How it fits in the system:
 *   Called by AdvisorOrchestrator before the first task in a new session to establish
 *   baseline context. Provides the advisor with the workspace structure without
 *   reading file contents, which is more efficient for large codebases.
 *
 * Dependencies:
 *   - WorkspaceManager.listStructure — reads directory tree.
 *   - TaskFrame — emits progress frames to client.
 *
 * Dependants:
 *   - AdvisorOrchestrator.runTask — calls for new sessions.
 * </Summary>
 */

import type { TaskFrame } from "../transport/frames.js";
import type { WorkspaceManager } from "../workspace/manager/workspaceManager.js";

/**
 * <Summary>
 * What it does:
 *   Result type for codebase exploration containing the session snapshot.
 *
 * How it fits in the system:
 *   Returned by exploreCodebase to provide the initial session context.
 *
 * Fields:
 *   snapshot — The directory structure snapshot as a formatted string.
 *
 * Dependants:
 *   - AdvisorOrchestrator.runTask — uses snapshot to build initial context.
 * </Summary>
 */
export type ExploreResult = {
  /** The directory structure snapshot as a formatted string. */
  snapshot: string;
};

/**
 * @async
 * <Summary>
 * What it does:
 *   Lists the workspace tree and returns it as the session snapshot.
 *
 * How it does it (step by step):
 *   1. Emit a progress frame showing the exploration operation.
 *   2. Call workspace.listStructure with depth 2 (2 levels of directories).
 *   3. Format the structure as a snapshot and return it.
 *
 * Parameters:
 *   @param {WorkspaceManager} workspace — The workspace manager for directory operations.
 *   @param {(frame: TaskFrame) => void} emit — Function to emit progress frames to client.
 *   @param {AbortSignal} _signal — Abort signal (currently unused, reserved for future cancellation).
 *
 * Returns:
 *   @returns {Promise<ExploreResult>} — Result containing the structure snapshot.
 *
 * Dependencies:
 *   - WorkspaceManager.listStructure — reads directory tree up to specified depth.
 *
 * Dependants:
 *   - AdvisorOrchestrator.runTask — calls for new sessions to build initial context.
 * </Summary>
 */
export const exploreCodebase = async (
  workspace: WorkspaceManager,
  emit: (frame: TaskFrame) => void,
  _signal: AbortSignal,
): Promise<ExploreResult> => {
  // Step 1: Emit a progress frame showing the exploration operation
  // This provides real-time feedback to the client about what's happening
  emit({ kind: "token", text: "  ● ListDir(.)\n" });

  // Step 2: Call workspace.listStructure with depth 2 (2 levels of directories)
  // Depth 2 provides a good balance between detail and performance
  const directoryStructure = await workspace.listStructure(2);

  // Step 3: Format the structure as a snapshot and return it
  // The snapshot is stored in the session file for future context
  return { snapshot: `Structure:\n${directoryStructure.trim()}\n` };
};
