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

/** Resets task UI and cancels pending dialogs when the server connection drops. */
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
