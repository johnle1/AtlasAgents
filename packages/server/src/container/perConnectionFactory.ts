/**
 * Factory for creating and initializing per-connection resources.
 *
 * @remarks
 * This module provides the factory function for instantiating all resources
 * needed for a single client connection. Resources are isolated per connection
 * to prevent cross-client interference and enable multiple simultaneous clients
 * with separate workspaces, terminals, and plan review sessions.
 *
 * See {@link PerConnectionFactory} for the container that uses this factory.
 */

// ===== TRANSPORT LAYER IMPORTS =====
import { createStreamTransports } from "../transport/rsocketPlanReviewTransport.js";

// ===== TYPE DEFINITION IMPORTS =====
import type { TaskFrame } from "../transport/frames.js";
import type { PerConnection, PerConnectionFactoryDeps } from "./types.js";

// ===== WORKSPACE LAYER IMPORTS =====
import { PlanReviewBroker } from "../workspace/review/planReviewBroker.js";
import { WorkspaceManager } from "../workspace/manager/workspaceManager.js";
import { TerminalExecutor } from "../workspace/execution/terminalExecutor.js";

/**
 * Creates all per-connection resources for a specific client session.
 *
 * @remarks
 * This factory instantiates isolated state for one client connection, including
 * workspace management, terminal execution, and plan review coordination.
 * Each resource is bound to the requester ID to route responses correctly and
 * prevent cross-client interference.
 *
 * The steps are:
 * 1. Create stream transports for bidirectional plan review communication
 * 2. Initialize plan review broker with the plan transport
 * 3. Create workspace manager and bind it to the requester ID
 * 4. Create terminal executor and bind it to the requester ID
 * 5. Return a complete {@link PerConnection} object
 *
 * @param dependencies - Shared dependencies (client bridge) needed for connection creation.
 * @param requesterId - Unique identifier for this client connection.
 *   Used to route all responses back to the correct client.
 * @param emit - Function to send task frames back to the client.
 *   Called whenever the connection needs to push data to the client
 *   (plan updates, terminal output, etc.).
 * @returns A fully initialized PerConnection object with all resources
 *   and utilities for managing this client's session.
 *
 * @example
 * ```ts
 * In the container initialization:
 * const deps: PerConnectionFactoryDeps = { clientBridge };
 * const connection = createPerConnection(deps, "user_123", (frame) => {
 *    Send frame back to client via WebSocket or HTTP
 *   ws.send(JSON.stringify(frame));
 * });
 *
 * Connection now has isolated workspace and terminal:
 * await connection.workspace.readFile("src/index.ts");
 * await connection.terminal.runCommand("npm run build");
 * ```
 */
export const createPerConnection = (
  dependencies: PerConnectionFactoryDeps,
  requesterId: string,
  emit: (frame: TaskFrame) => void,
): PerConnection => {
  // Extract clientBridge from dependencies for workspace and terminal initialization
  const { clientBridge } = dependencies;

  // Create bidirectional stream transports for plan review communication.
  // The emit function ensures frames are sent to the correct client.
  const streamTransports = createStreamTransports(emit);

  // Initialize plan review broker with the stream transport so plan reviews
  // can be conducted asynchronously between client and agent.
  const planBroker = new PlanReviewBroker({
    transport: streamTransports.plan,
  });

  // Create workspace manager with access to clientBridge for file operations.
  // Binding to requesterId ensures all operations are associated with this connection.
  const workspaceManager = new WorkspaceManager(clientBridge);
  workspaceManager.bindRequester(requesterId);

  // Create terminal executor with access to clientBridge for command execution.
  // Binding to requesterId ensures terminal output goes to the correct client.
  const terminalExecutor = new TerminalExecutor(clientBridge);
  terminalExecutor.bindRequester(requesterId);

  // Return complete per-connection resources with utilities for stream management.
  // This includes service instances (planBroker, workspace, terminal) and
  // utility functions for plan resolution and reconnection.
  return {
    planBroker,
    workspace: workspaceManager,
    terminal: terminalExecutor,
    resolvePlan: streamTransports.resolvePlan,
    rebindStreamEmit: streamTransports.rebindEmit,
  };
};
