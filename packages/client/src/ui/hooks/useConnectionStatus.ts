import { useEffect, useState } from "react";

import type { Connection, ConnectionStatus } from "../../connection/index.js";

/**
 * React hook to subscribe to and track the server RSocket connection status.
 *
 * @param connection - The RSocket connection manager instance.
 * @returns The current connection status (e.g., "Connected", "Disconnected", "Connecting").
 */
export const useConnectionStatus = (
  connection: Connection,
): ConnectionStatus => {
  const [status, setStatus] = useState<ConnectionStatus>("Disconnected");

  useEffect(() => {
    return connection.onConnectionStatus(setStatus);
  }, [connection]);

  return status;
};

