import React from "react";
import { Text } from "ink";
import type { ConnectionStatus } from "../../connection/index.js";
import { formatConnectionStatusLabel } from "../connectionStatus.js";

type Props = {
  status: ConnectionStatus;
};

export const ConnectionStatusLine: React.FC<Props> = ({ status }) => {
  const label = formatConnectionStatusLabel(status);
  const color =
    status === "connected"
      ? "green"
      : status === "disconnected"
        ? "red"
        : "yellow";

  return (
    <Text dimColor={status === "connected"} color={color}>
      [rsocket: {label}]
    </Text>
  );
};
