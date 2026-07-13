import { useEffect, useState } from "react";

import type { Connection, ConnectionStatus } from "../../connection/index.js";

/**
 * React hook to subscribe to and track the server RSocket connection status.
 *
 * @remarks
 * This hook subscribes to the connection's status changes and returns the current
 * status as React state. The status can be:
 *
 * - "Disconnected" - No connection to the server
 * - "Connecting" - Currently attempting to establish a connection
 * - "Connected" - Successfully connected and communicating
 * - "Reconnecting" - Connection was lost and attempting to reconnect
 *
 * The hook automatically unsubscribes when the component unmounts to prevent
 * memory leaks. The status is displayed in the UI via {@link ConnectionStatusLine}.
 *
 * @param connection - The RSocket connection manager instance.
 * @returns The current connection status (e.g., "Connected", "Disconnected", "Connecting").
 *
 * @example
 * ```tsx
 * const connectionStatus = useConnectionStatus(connection);
 * console.log(connectionStatus); // "Connected"
 * ```
 */
export const useConnectionStatus = (
  connection: Connection,
): ConnectionStatus => {
  // Initialize with "Disconnected" as the default state before the connection
  // status callback fires. This ensures the UI shows the correct initial state.
  const [status, setStatus] = useState<ConnectionStatus>("Disconnected");

  // Subscribe to connection status changes. The connection.onConnectionStatus
  // method returns an unsubscribe function, which we return from the effect
  // to clean up on unmount.
  useEffect(() => {
    return connection.onConnectionStatus(setStatus);
  }, [connection]);

  return status;
};
