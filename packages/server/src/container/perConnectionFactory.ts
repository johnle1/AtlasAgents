/**
 * <Summary>
 * What it does:
 *   Factory for creating per-connection resources for specific clients.
 *
 * How it does it (step by step):
 *   1. Create stream transports for plan review communication.
 *   2. Initialize plan review broker with plan transport.
 *   3. Initialize workspace manager and bind to requester ID.
 *   4. Initialize terminal executor and bind to requester ID.
 *   5. Return object with all per-connection resources and utilities.
 *
 * How it fits in the system:
 *   Creates isolated state for each client connection, enabling multiple
 *   simultaneous clients with separate workspaces, terminals, and plan review
 * sessions. Each connection gets its own instances to prevent cross-client
 * interference.
 *
 * Parameters:
 *   @param {PerConnectionFactoryDeps} dependencies - Dependencies for creating per-connection resources.
 *   @param {string} requesterId - Unique identifier for the requesting client.
 *   @param {function} emit - Function to emit task frames to the client.
 *
 * Returns:
 *   @returns {PerConnection} - Object containing connection-specific resources.
 *
 * Dependencies:
 *   - createStreamTransports — creates RSocket stream transports.
 *   - PlanReviewBroker — handles plan review workflow.
 *   - WorkspaceManager — manages workspace operations.
 *   - TerminalExecutor — executes terminal commands.
 *   - clientBridge — provides client communication.
 *
 * Dependants:
 *   - buildRouter — calls this to set up resources for new connections.
 *   - task stream handler — calls this when processing task requests.
 * </Summary>
 */

// ===== TRANSPORT LAYER IMPORTS =====
import { createStreamTransports } from "../transport/rsocketPlanReviewTransport.js";

// ===== TYPE DEFINITION IMPORTS =====
import type { TaskFrame } from "../transport/frames.js";
import type { PerConnection } from "./types.js";

// ===== WORKSPACE LAYER IMPORTS =====
import { PlanReviewBroker } from "../workspace/review/planReviewBroker.js";
import { WorkspaceManager } from "../workspace/manager/workspaceManager.js";
import { TerminalExecutor } from "../workspace/execution/terminalExecutor.js";

// ===== CLIENT COMMUNICATION IMPORTS =====
import { ClientBridge } from "../transport/clientBridge.js";

/**
 * <Summary>
 * What it does:
 *   Defines the dependencies required to create per-connection resources.
 *
 * How it fits in the system:
 *   Provides the shared infrastructure that per-connection instances need
 *   to communicate with clients. The clientBridge is shared across all
 *   connections but each connection gets its own bound instance.
 *
 * Used by:
 *   - createPerConnection — receives these dependencies to create connection resources.
 *
 * Produced by:
 *   - Container — provides these dependencies when calling createPerConnection.
 * </Summary>
 */
export type PerConnectionFactoryDeps = {
  /**
   * Client bridge for communication with connected clients.
   * Provides methods to send commands and receive responses from clients.
   * Each connection binds to a specific requester ID for isolation.
   */
  clientBridge: ClientBridge;
};

/**
 * <Summary>
 * What it does:
 *   Factory function that creates per-connection resources for a specific client.
 *
 * How it does it (step by step):
 *   1. Extract clientBridge from dependencies.
 *   2. Create stream transports for plan review communication.
 *   3. Initialize plan review broker with plan transport.
 *   4. Initialize workspace manager with client bridge.
 *   5. Bind workspace manager to the specific requester ID.
 *   6. Initialize terminal executor with client bridge.
 *   7. Bind terminal executor to the specific requester ID.
 *   8. Return object containing all connection-specific resources and utilities.
 *
 * Parameters:
 *   @param {PerConnectionFactoryDeps} dependencies - Shared dependencies for connection creation.
 *   @param {string} requesterId - Unique identifier for the requesting client.
 *   @param {function} emit - Function to emit task frames to the client.
 *
 * Returns:
 *   @returns {PerConnection} - Object containing all connection-specific resources.
 *
 * Dependencies:
 *   - createStreamTransports — creates bidirectional stream communication.
 *   - PlanReviewBroker — manages plan review workflow and state.
 *   - WorkspaceManager — handles file system operations and workspace state.
 *   - TerminalExecutor — executes shell commands for the client.
 *   - clientBridge — provides client communication infrastructure.
 *
 * Dependants:
 *   - Container.createPerConnection — calls this to set up new client connections.
 *   - Router connection handlers — uses this to initialize connection state.
 * </Summary>
 */
export const createPerConnection = (
  dependencies: PerConnectionFactoryDeps,
  requesterId: string,
  emit: (frame: TaskFrame) => void,
): PerConnection => {
  // ===== STEP 1: EXTRACT DEPENDENCIES =====
  // Extract clientBridge from the dependencies object
  // This provides the shared communication infrastructure for this connection
  const { clientBridge } = dependencies;

  // ===== STEP 2: CREATE STREAM TRANSPORTS =====
  // Create stream transports for plan review communication
  // This establishes bidirectional communication channels for plan review workflows
  // The emit function allows sending frames back to the specific client
  const streamTransports = createStreamTransports(emit);

  // ===== STEP 3: INITIALIZE PLAN REVIEW BROKER =====
  // Create plan review broker with the plan transport
  // This manages the plan review workflow, handling plan proposals and feedback
  const planBroker = new PlanReviewBroker({
    transport: streamTransports.plan,
  });

  // ===== STEP 4: INITIALIZE WORKSPACE MANAGER =====
  // Create workspace manager with client bridge for communication
  // This handles file system operations, git commands, and workspace state
  const workspaceManager = new WorkspaceManager(clientBridge);

  // ===== STEP 5: BIND WORKSPACE TO REQUESTER =====
  // Bind the workspace manager to the specific requester ID
  // This ensures all workspace operations are associated with this connection
  // and enables proper routing of responses back to the correct client
  workspaceManager.bindRequester(requesterId);

  // ===== STEP 6: INITIALIZE TERMINAL EXECUTOR =====
  // Create terminal executor with client bridge for communication
  // This handles shell command execution and terminal session management
  const terminalExecutor = new TerminalExecutor(clientBridge);

  // ===== STEP 7: BIND TERMINAL TO REQUESTER =====
  // Bind the terminal executor to the specific requester ID
  // This ensures terminal output and commands are routed to the correct client
  terminalExecutor.bindRequester(requesterId);

  // ===== STEP 8: RETURN PER-CONNECTION RESOURCES =====
  // Return object containing all connection-specific resources and utility functions
  // This provides the complete interface for managing this client's session
  return {
    // Core service instances for this connection
    planBroker, // Plan review workflow management
    workspace: workspaceManager, // Workspace and file system operations
    terminal: terminalExecutor, // Terminal command execution

    // Utility functions for stream management
    resolvePlan: streamTransports.resolvePlan, // Plan resolution helper
    rebindStreamEmit: streamTransports.rebindEmit, // Stream rebinding for reconnection
  };
};
