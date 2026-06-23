/**
 * <Summary>
 * What it does:
 *   Provides functions for managing agent status display and spinner state
 *   in the Ink-based CLI UI through the bridge system.
 *
 * How it fits in the system:
 *   These functions serve as the bridge between server-side agent status updates
 *   and the UI components that display agent status. They update the global application
 *   state through the bridge hooks system, which then triggers UI re-renders.
 * </Summary>
 */

import type { AgentStage } from "../../frames.js";
import type {
  AgentBoardState,
  AgentStatusState,
  SpinnerState,
} from "../types.js";
import { getBridgeHooks } from "./state.js";

/**
 * <Summary>
 * What it does:
 *   Updates the global spinner state displayed in the CLI UI.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onSpinner hook with the new spinner state.
 *   3. The hook updates the global state and triggers UI re-render.
 *
 * Parameters:
 *   @param spinnerState - The new spinner state (null to hide spinner).
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const setSpinner = (spinnerState: SpinnerState | null): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  // Step 1b: This provides access to onSpinner callback for spinner state
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Update Spinner State =====
  // Step 2a: Call the onSpinner hook with the new spinner state
  // Step 2b: This updates the global state and triggers UI re-render
  // Step 2c: Null spinner state hides the spinner, non-null shows it
  bridgeHooks.onSpinner?.(spinnerState);
};

/**
 * <Summary>
 * What it does:
 *   Updates or adds an agent's status in the global agent status map.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onAgentStatuses hook with an update function.
 *   3. The update function creates a new Map from the previous state.
 *   4. Sets the agent status in the new Map using the agent ID as key.
 *   5. Returns the updated Map to update the global state.
 *
 * Parameters:
 *   @param agentStatus - The agent status object to add/update.
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const setAgentStatus = (agentStatus: AgentStatusState): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Update Agent Status Map =====
  // Step 2a: Call the onAgentStatuses hook with an update function
  // Step 2b: The update function receives the previous agent status map
  bridgeHooks.onAgentStatuses?.((previousAgentStatusMap) => {
    // ===== STEP 2a-i: Create New Map =====
    // Step 2a-i-1: Create a new Map by copying the previous one
    // Step 2a-i-2: This ensures immutable state update pattern
    const updatedAgentStatusMap = new Map(previousAgentStatusMap);

    // ===== STEP 2a-ii: Set Agent Status =====
    // Step 2a-ii-1: Set the agent status using the agent ID as key
    // Step 2a-ii-2: This updates or adds the status for the specified agent
    updatedAgentStatusMap.set(agentStatus.id, agentStatus);

    // ===== STEP 2a-iii: Return Updated Map =====
    // Step 2a-iii-1: Return the updated map to update global state
    // Step 2a-iii-2: This triggers UI re-render with new agent status
    return updatedAgentStatusMap;
  });
};

/**
 * <Summary>
 * What it does:
 *   Removes an agent's status from the global agent status map.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onAgentStatuses hook with an update function.
 *   3. Checks if the agent exists in the current status map.
 *   4. If agent doesn't exist, returns the previous map unchanged.
 *   5. If agent exists, creates a new Map and deletes the agent.
 *   6. Returns the updated Map to update the global state.
 *
 * Parameters:
 *   @param agentId - The ID of the agent to remove (or "advisor").
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const removeAgentStatus = (agentId: number | "advisor"): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Remove Agent from Status Map =====
  // Step 2a: Call the onAgentStatuses hook with an update function
  bridgeHooks.onAgentStatuses?.((previousAgentStatusMap) => {
    // ===== STEP 2a-i: Check if Agent Exists =====
    // Step 2a-i-1: Check if the agent ID exists in the current status map
    // Step 2a-i-2: If agent doesn't exist, return previous map unchanged
    if (!previousAgentStatusMap.has(agentId)) {
      return previousAgentStatusMap;
    }

    // ===== STEP 2a-ii: Create New Map and Remove Agent =====
    // Step 2a-ii-1: Create a new Map by copying the previous one
    const updatedAgentStatusMap = new Map(previousAgentStatusMap);

    // Step 2a-ii-2: Delete the agent from the new map
    // Step 2a-ii-3: This removes the agent status from global state
    updatedAgentStatusMap.delete(agentId);

    // ===== STEP 2a-iii: Return Updated Map =====
    // Step 2a-iii-1: Return the updated map to update global state
    return updatedAgentStatusMap;
  });
};

/**
 * <Summary>
 * What it does:
 *   Clears all agent boards from the global state.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onAgentBoards hook with a function that returns empty array.
 *   3. This replaces the agent boards array with an empty array.
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const clearAgentBoards = (): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Clear Agent Boards =====
  // Step 2a: Call the onAgentBoards hook with a function that returns empty array
  // Step 2b: This replaces the agent boards array with an empty array
  // Step 2c: This removes all agent task boards from the UI
  bridgeHooks.onAgentBoards?.(() => []);
};

/**
 * <Summary>
 * What it does:
 *   Clears all agent statuses and agent boards from the global state.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onAgentStatuses hook with a function that returns empty Map.
 *   3. Calls clearAgentBoards to also clear the agent boards.
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const clearAgentStatuses = (): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Clear Agent Statuses =====
  // Step 2a: Call the onAgentStatuses hook with a function that returns empty Map
  // Step 2b: This replaces the agent status map with an empty map
  // Step 2c: This removes all agent status indicators from the UI
  bridgeHooks.onAgentStatuses?.(() => new Map());

  // ===== STEP 3: Clear Agent Boards =====
  // Step 3a: Also clear the agent boards array
  // Step 3b: This ensures complete cleanup of agent-related UI state
  clearAgentBoards();
};

/**
 * <Summary>
 * What it does:
 *   Sets the agent boards array with preserved activity state for running tasks.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onAgentBoards hook with an update function.
 *   3. Maps over the new boards array.
 *   4. For each board, checks if it has any running tasks.
 *   5. Finds the previous board with the same ID to preserve activity.
 *   6. If task is running, preserve previous activity; otherwise clear it.
 *   7. Returns the updated boards array.
 *
 * Parameters:
 *   @param agentBoards - The new agent boards state.
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const setAgentBoards = (agentBoards: AgentBoardState[]): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Update Agent Boards =====
  // Step 2a: Call the onAgentBoards hook with an update function
  bridgeHooks.onAgentBoards?.((previousAgentBoards) =>
    // ===== STEP 2a-i: Map Over New Boards =====
    // Step 2a-i-1: Process each board in the new array
    agentBoards.map((agentBoard) => {
      // ===== STEP 2a-i-1-a: Check for Running Tasks =====
      // Step 2a-i-1-a-1: Check if the board has any tasks in "running" state
      // Step 2a-i-1-a-2: This determines if activity state should be preserved
      const hasRunningTask = agentBoard.tasks.some(
        (task) => task.state === "running",
      );

      // ===== STEP 2a-i-1-b: Find Previous Board =====
      // Step 2a-i-1-b-1: Find the board with the same ID in previous array
      // Step 2a-i-1-b-2: This allows us to preserve activity state across updates
      const previousAgentBoard = previousAgentBoards.find(
        (previousBoardItem) => previousBoardItem.id === agentBoard.id,
      );

      // ===== STEP 2a-i-1-c: Return Updated Board =====
      // Step 2a-i-1-c-1: Return the board with updated activity state
      // Step 2a-i-1-c-2: If task is running, preserve previous activity
      // Step 2a-i-1-c-3: If no running task, clear activity state
      return {
        ...agentBoard,
        activity: hasRunningTask
          ? (previousAgentBoard?.activity ?? agentBoard.activity)
          : undefined,
      };
    }),
  );
};

/**
 * <Summary>
 * What it does:
 *   Updates the activity message for a specific agent in the agent boards array.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onAgentBoards hook with an update function.
 *   3. Finds the board with the specified agent ID in the array.
 *   4. If agent ID not found, returns previous array unchanged.
 *   5. If found, maps over the array and updates the matching board's activity.
 *   6. Returns the updated boards array.
 *
 * Parameters:
 *   @param agentId - The ID of the agent to update.
 *   @param agentActivity - The new activity info (null to clear).
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const updateAgentActivity = (
  agentId: number,
  agentActivity: { stage: AgentStage; message: string } | null,
): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Update Agent Activity =====
  // Step 2a: Call the onAgentBoards hook with an update function
  bridgeHooks.onAgentBoards?.((previousAgentBoards) => {
    // ===== STEP 2a-i: Find Agent Board Index =====
    // Step 2a-i-1: Find the index of the board with the specified agent ID
    // Step 2a-i-2: This returns -1 if the agent ID is not found
    const agentBoardIndex = previousAgentBoards.findIndex(
      (agentBoard) => agentBoard.id === agentId,
    );

    // ===== STEP 2a-ii: Handle Agent Not Found =====
    // Step 2a-ii-1: If agent ID not found, return previous array unchanged
    // Step 2a-ii-2: This prevents errors when updating non-existent agents
    if (agentBoardIndex < 0) {
      return previousAgentBoards;
    }

    // ===== STEP 2a-iii: Update Matching Board =====
    // Step 2a-iii-1: Map over the array to update the matching board
    // Step 2a-iii-2: Only update the board at the found index
    // Step 2a-iii-3: Set the new activity (or undefined if null)
    return previousAgentBoards.map((agentBoard, arrayIndex) =>
      arrayIndex === agentBoardIndex
        ? { ...agentBoard, activity: agentActivity ?? undefined }
        : agentBoard,
    );
  });
};
