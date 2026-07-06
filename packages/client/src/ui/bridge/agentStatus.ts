/**
 * Agent status, board, and spinner management for the Ink CLI UI.
 *
 * @remarks
 * This module controls the state of task boards, advisor/agent progress indicators,
 * activity messages, and loading spinners rendered by the Ink interface.
 */

import type { AgentStage } from "../../frames.js";
import type {
  AgentBoardState,
  AgentStatusState,
  SpinnerState,
} from "../types.js";
import { getBridgeHooks } from "./state.js";

/**
 * Updates the loading spinner state displayed in the terminal.
 *
 * @param spinnerState - The spinner configuration, or `null` to hide the active spinner.
 */
export const setSpinner = (spinnerState: SpinnerState | null): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onSpinner?.(spinnerState);
};

/**
 * Updates or registers an agent's status details in the global status registry.
 *
 * @param agentStatus - The status updates for the agent.
 */
export const setAgentStatus = (agentStatus: AgentStatusState): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onAgentStatuses?.((previousAgentStatusMap) => {
    const updatedAgentStatusMap = new Map(previousAgentStatusMap);
    updatedAgentStatusMap.set(agentStatus.id, agentStatus);
    return updatedAgentStatusMap;
  });
};

/**
 * Removes an agent's status from the global status registry.
 *
 * @param agentId - The ID of the agent to remove, or "advisor".
 */
export const removeAgentStatus = (agentId: number | "advisor"): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onAgentStatuses?.((previousAgentStatusMap) => {
    if (!previousAgentStatusMap.has(agentId)) {
      return previousAgentStatusMap;
    }
    const updatedAgentStatusMap = new Map(previousAgentStatusMap);
    updatedAgentStatusMap.delete(agentId);
    return updatedAgentStatusMap;
  });
};

/**
 * Clears all active agent boards from the global UI state.
 */
export const clearAgentBoards = (): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onAgentBoards?.(() => []);
};

/**
 * Clears all agent statuses and agent boards from the global state.
 */
export const clearAgentStatuses = (): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onAgentStatuses?.(() => new Map());
  clearAgentBoards();
};

/**
 * Sets the list of active agent boards, preserving existing activity context for running tasks.
 *
 * @param agentBoards - The updated list of agent boards.
 */
export const setAgentBoards = (agentBoards: AgentBoardState[]): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onAgentBoards?.((previousAgentBoards) =>
    agentBoards.map((agentBoard) => {
      const hasRunningTask = agentBoard.tasks.some(
        (task) => task.state === "running",
      );
      const previousAgentBoard = previousAgentBoards.find(
        (previousBoardItem) => previousBoardItem.id === agentBoard.id,
      );

      // If a task is still running, preserve its last reported activity message
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
 * Updates the current activity step message for a specific agent.
 *
 * @param agentId - The unique ID of the agent to update.
 * @param agentActivity - The activity stage and text message, or `null` to clear the activity.
 */
export const updateAgentActivity = (
  agentId: number,
  agentActivity: { stage: AgentStage; message: string } | null,
): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onAgentBoards?.((previousAgentBoards) => {
    const agentBoardIndex = previousAgentBoards.findIndex(
      (agentBoard) => agentBoard.id === agentId,
    );

    if (agentBoardIndex < 0) {
      return previousAgentBoards;
    }

    return previousAgentBoards.map((agentBoard, arrayIndex) =>
      arrayIndex === agentBoardIndex
        ? { ...agentBoard, activity: agentActivity ?? undefined }
        : agentBoard,
    );
  });
};

