import { useEffect, useRef } from "react";

import type { AppContextValue } from "../../DataContext.js";
import { stopAnimated } from "../../agentStatus.js";
import type { Connection, ConnectionStatus } from "../../connection/index.js";
import {
  appendHistory,
  cancelPendingApprovals,
  cancelPendingPrompts,
  clearAgentBoards,
  clearAgentStatuses,
  setBusy as setBridgeBusy,
  setSpinner as setBridgeSpinner,
  setStreamingText as setBridgeStreamingText,
  setTaskActive as setBridgeTaskActive,
} from "../uiBridge.js";

export type ConnectionDisconnectCleanupSetters = Pick<
  AppContextValue,
  | "setTaskActive"
  | "setBusy"
  | "setSpinner"
  | "setStreamingText"
  | "setAgentStatuses"
  | "setAgentBoards"
>;

/**
 * Resets task-related UI states to their default/idle values.
 */
const resetTaskUiState = (setters: ConnectionDisconnectCleanupSetters): void => {
  setBridgeTaskActive(false);
  setters.setTaskActive(false);

  setBridgeBusy(false);
  setters.setBusy(false);

  setBridgeSpinner(null);
  setters.setSpinner(null);

  setBridgeStreamingText(null);
  setters.setStreamingText(null);

  clearAgentStatuses();
  setters.setAgentStatuses(() => new Map());
  clearAgentBoards();
  setters.setAgentBoards([]);
};

/**
 * React hook to perform cleanup operations when the server connection is lost.
 *
 * @remarks
 * Subscribes to connection status transitions. If the connection drops, it cancels any
 * pending user prompts/approvals, stops task spinners/animations, resets internal bridge states,
 * and appends an error notice to the history logs.
 *
 * @param connection - The active connection client.
 * @param setters - State setters from the app context to reset the UI.
 */
export const useConnectionDisconnectCleanup = (
  connection: Connection,
  setters: ConnectionDisconnectCleanupSetters,
): void => {
  const previousStatusRef = useRef<ConnectionStatus>("Disconnected");
  const settersRef = useRef(setters);
  settersRef.current = setters;

  useEffect(() => {
    return connection.onConnectionStatus((status) => {
      const wasConnected = previousStatusRef.current === "Connected";
      previousStatusRef.current = status;

      if (!wasConnected || status === "Connected") return;

      cancelPendingApprovals();
      cancelPendingPrompts();
      stopAnimated();
      resetTaskUiState(settersRef.current);
      appendHistory({
        kind: "text",
        text: "Connection lost — task interrupted.",
        variant: "error",
      });
    });
  }, [connection]);
};

