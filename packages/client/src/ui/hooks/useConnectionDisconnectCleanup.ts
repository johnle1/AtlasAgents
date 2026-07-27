import { useEffect, useRef } from "react";

import type { ConnectionDisconnectCleanupSetters } from "./types.js";
import { stopAnimated } from "../../state/agentStatus.js";
import type { Connection, ConnectionStatus } from "../../connection/index.js";
import {
  appendHistory,
  cancelPendingApprovals,
  cancelPendingPrompts,
  clearSubagentBoards,
  clearSubagentStatuses,
  setBusy as setBridgeBusy,
  setSpinner as setBridgeSpinner,
  setStreamingText as setBridgeStreamingText,
  setTaskActive as setBridgeTaskActive,
} from "../uiBridge.js";

/**
 * Resets task-related UI states to their default/idle values.
 *
 * @remarks
 * This function resets both the global bridge state (used by non-React code)
 * and the React context state (used by the UI). Both need to be reset because:
 * - Bridge state is checked by server code to determine if the UI is busy
 * - React state is what actually renders to the terminal
 *
 * We reset agent statuses and boards to empty collections so the UI doesn't
 * show stale agent information from the disconnected session.
 *
 * @param setters - React state setters to update the UI.
 */
const resetTaskUiState = (
  setters: ConnectionDisconnectCleanupSetters,
): void => {
  // Reset global bridge state (used by server-side code)
  setBridgeTaskActive(false);
  setBridgeBusy(false);
  setBridgeSpinner(null);
  setBridgeStreamingText(null);
  clearSubagentStatuses();
  clearSubagentBoards();

  // Reset React context state (used by UI rendering)
  setters.setTaskActive(false);
  setters.setBusy(false);
  setters.setSpinner(null);
  setters.setStreamingText(null);
  setters.setSubagentStatuses(() => new Map());
  setters.setSubagentBoards([]);
};

/**
 * React hook to perform cleanup operations when the server connection is lost.
 *
 * @remarks
 * This hook subscribes to connection status changes and triggers cleanup when
 * the connection transitions from "Connected" to any other state. The cleanup includes:
 *
 * 1. Canceling pending user prompts/approvals so they don't hang waiting for input
 * 2. Stopping animated spinners to prevent CPU waste
 * 3. Resetting all task-related UI state (busy, spinner, streaming text, agent boards)
 * 4. Appending an error message to the history so the user knows what happened
 *
 * We use a ref for the previous status to detect the transition from Connected
 * to disconnected, and a ref for the setters to avoid stale closure issues.
 *
 * @param connection - The active connection client.
 * @param setters - State setters from the app context to reset the UI.
 */
export const useConnectionDisconnectCleanup = (
  connection: Connection,
  setters: ConnectionDisconnectCleanupSetters,
): void => {
  // Track the previous connection status to detect when we transition from Connected.
  // This ensures we only run cleanup on the actual disconnect event, not on every status change.
  const previousStatusRef = useRef<ConnectionStatus>("Disconnected");

  // Store setters in a ref to avoid stale closure issues. The effect callback
  // captures the initial setters value, but we want to always use the latest.
  const settersRef = useRef(setters);
  settersRef.current = setters;

  useEffect(() => {
    return connection.onConnectionStatus((status) => {
      const wasConnected = previousStatusRef.current === "Connected";
      previousStatusRef.current = status;

      // Only run cleanup if we were connected and are now disconnected.
      // This prevents running cleanup on initial mount or when reconnecting.
      if (!wasConnected || status === "Connected") return;

      // Cancel any pending user interactions. If we don't do this, the promises
      // will hang indefinitely and the server code will be blocked.
      cancelPendingApprovals();
      cancelPendingPrompts();

      // Stop animated spinners to prevent CPU waste when the UI is not rendering.
      stopAnimated();

      // Reset all task-related UI state to idle values.
      resetTaskUiState(settersRef.current);

      // Inform the user that the connection was lost and their task was interrupted.
      appendHistory({
        kind: "text",
        text: "Connection lost — task interrupted.",
        variant: "error",
      });
    });
  }, [connection]);
};
