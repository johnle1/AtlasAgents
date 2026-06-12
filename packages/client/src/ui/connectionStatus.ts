import type { ConnectionStatus } from "../connection/index.js";

export const formatConnectionStatusLabel = (
  status: ConnectionStatus,
): string =>
  status === "connected"
    ? "connected"
    : status === "connecting"
      ? "connecting…"
      : status === "reconnecting"
        ? "reconnecting…"
        : "disconnected";
