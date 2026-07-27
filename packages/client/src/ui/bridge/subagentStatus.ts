/**
 * Agent status, board, and spinner management for the Ink CLI UI.
 *
 * @remarks
 * This module controls the state of task boards, agent/subagent progress indicators,
 * activity messages, and loading spinners rendered by the Ink interface.
 */

import type { SubagentStage } from "../../types/frames.js";
import type {
  SubagentBoardState,
  SubagentStatusState,
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
export const setSubagentStatus = (agentStatus: SubagentStatusState): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onSubagentStatuses?.((previousSubagentStatusMap) => {
    const updatedSubagentStatusMap = new Map(previousSubagentStatusMap);
    updatedSubagentStatusMap.set(agentStatus.id, agentStatus);
    return updatedSubagentStatusMap;
  });
};

/**
 * Removes an agent's status from the global status registry.
 *
 * @param agentId - The ID of the subagent to remove, or "agent".
 */
export const removeSubagentStatus = (agentId: number | "agent"): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onSubagentStatuses?.((previousSubagentStatusMap) => {
    if (!previousSubagentStatusMap.has(agentId)) {
      return previousSubagentStatusMap;
    }
    const updatedSubagentStatusMap = new Map(previousSubagentStatusMap);
    updatedSubagentStatusMap.delete(agentId);
    return updatedSubagentStatusMap;
  });
};

/**
 * Clears all active agent boards from the global UI state.
 */
export const clearSubagentBoards = (): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onSubagentBoards?.(() => []);
};

/**
 * Clears all agent statuses and agent boards from the global state.
 */
export const clearSubagentStatuses = (): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onSubagentStatuses?.(() => new Map());
  clearSubagentBoards();
};

/**
 * Sets the list of active agent boards, preserving existing activity context for running tasks.
 *
 * @param subagentBoards - The updated list of agent boards.
 */
export const setSubagentBoards = (
  subagentBoards: SubagentBoardState[],
): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onSubagentBoards?.((previousSubagentBoards) =>
    subagentBoards.map((agentBoard) => {
      const hasRunningTask = agentBoard.tasks.some(
        (task) => task.state === "running",
      );
      const previousSubagentBoard = previousSubagentBoards.find(
        (previousBoardItem) => previousBoardItem.id === agentBoard.id,
      );

      // If a task is still running, preserve its last reported activity message
      // (but never keep escalating — that is internal and not shown in the UI).
      const preservedActivity = previousSubagentBoard?.activity;
      const activity =
        hasRunningTask &&
        preservedActivity &&
        preservedActivity.stage !== "escalating"
          ? preservedActivity
          : agentBoard.activity?.stage === "escalating"
            ? undefined
            : agentBoard.activity;

      return {
        ...agentBoard,
        activity,
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
  agentActivity: { stage: SubagentStage; message: string } | null,
): void => {
  if (agentActivity?.stage === "escalating") {
    agentActivity = null;
  }

  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onSubagentBoards?.((previousSubagentBoards) => {
    const agentBoardIndex = previousSubagentBoards.findIndex(
      (agentBoard) => agentBoard.id === agentId,
    );

    if (agentBoardIndex < 0) {
      return previousSubagentBoards;
    }

    return previousSubagentBoards.map((agentBoard, arrayIndex) =>
      arrayIndex === agentBoardIndex
        ? { ...agentBoard, activity: agentActivity ?? undefined }
        : agentBoard,
    );
  });
};
