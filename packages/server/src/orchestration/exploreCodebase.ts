/**
 * One-time codebase exploration that builds a session snapshot from directory structure.
 *
 * @remarks
 * Called by AgentOrchestrator before the first task in a new session to establish
 * baseline context. Provides the agent with the workspace structure without
 * reading file contents, which is more efficient for large codebases. The snapshot
 * is stored in the session file for future context.
 */

import type { TaskFrame } from "../transport/frames.js";
import type { WorkspaceManager } from "../workspace/manager/workspaceManager.js";

/**
 * Result type for codebase exploration containing the session snapshot.
 *
 * @remarks
 * Returned by exploreCodebase to provide the initial session context.
 */
export type ExploreResult = {
  /** The directory structure snapshot as a formatted string */
  snapshot: string;
};

/**
 * Lists the workspace tree and returns it as the session snapshot.
 *
 * @remarks
 * Emits a progress frame to the client, then calls workspace.listStructure with
 * depth 2 (2 levels of directories) to get the directory structure. Depth 2 provides
 * a good balance between detail and performance. The snapshot is stored in the
 * session file for future context.
 *
 * @param workspace - The workspace manager for directory operations
 * @param emit - Function to emit progress frames to client
 * @param _signal - Abort signal (currently unused, reserved for future cancellation)
 *
 * @returns Result containing the structure snapshot
 */
export const exploreCodebase = async (
  workspace: WorkspaceManager,
  emit: (frame: TaskFrame) => void,
  _signal: AbortSignal,
): Promise<ExploreResult> => {
  emit({ kind: "token", text: "  ● ListDir(.)\n" });

  const directoryStructure = await workspace.listStructure(2);

  return { snapshot: `Structure:\n${directoryStructure.trim()}\n` };
};
