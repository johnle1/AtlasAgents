/**
 * <Summary>
 * What it does:
 *   Defines types for per-connection resource management.
 *
 * How it fits in the system:
 *   Provides type definitions for connection-specific resources that are
 *   created for each client connection, enabling isolation between multiple
 *   simultaneous clients.
 *
 * Used by:
 *   - PerConnectionFactory — creates objects of this type.
 *   - Container — stores instances in brokerByRequester map.
 * </Summary>
 */

// ===== TRANSPORT TYPE IMPORTS =====
import type { TaskFrame } from "../transport/frames.js";

// ===== ORCHESTRATION TYPE IMPORTS =====
import type { PlanReviewResponse } from "../orchestration/types.js";

// ===== WORKSPACE TYPE IMPORTS =====
import type { PlanReviewBroker } from "../workspace/review/planReviewBroker.js";
import type { TerminalExecutor } from "../workspace/execution/terminalExecutor.js";
import type { WorkspaceManager } from "../workspace/manager/workspaceManager.js";

/**
 * <Summary>
 * What it does:
 *   Defines the shape of per-connection resources for a specific client.
 *
 * How it fits in the system:
 *   Each client connection gets its own instance of these resources to
 *   ensure isolation. The container maintains a map of requester IDs to
 *   PerConnection objects, allowing multiple simultaneous clients with
 *   separate workspaces, terminals, and plan review sessions.
 *
 * Used by:
 *   - PerConnectionFactory — creates objects of this type.
 *   - Container.brokerByRequester — stores instances by requester ID.
 *   - Router — accesses per-connection resources for request handling.
 *
 * Produced by:
 *   - createPerConnection — constructs this type for each new connection.
 * </Summary>
 */
export type PerConnection = {
  /**
   * Plan review broker for managing plan review workflow.
   * Handles plan proposals, feedback, and approval processes.
   */
  planBroker: PlanReviewBroker;

  /**
   * Function to resolve a plan review with a response.
   * Called when plan review completes to notify the waiting requester.
   *
   * @param planId - Unique identifier for the plan being resolved.
   * @param response - The plan review response to send back.
   */
  resolvePlan: (planId: string, response: PlanReviewResponse) => void;

  /**
   * Function to rebind the stream emit function for reconnection.
   * Allows updating the emit function after a client reconnects.
   *
   * @param emitFunction - New emit function for sending frames to the client.
   */
  rebindStreamEmit: (emitFunction: (frame: TaskFrame) => void) => void;

  /**
   * Workspace manager for file system operations and workspace state.
   * Handles git operations, file access, and workspace-specific tasks.
   */
  workspace: WorkspaceManager;

  /**
   * Terminal executor for shell command execution.
   * Manages terminal sessions and command execution for the client.
   */
  terminal: TerminalExecutor;
};
