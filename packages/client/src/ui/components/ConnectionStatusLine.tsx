import React, { useEffect, useState } from "react";
import { Text, Box } from "ink";
import {
  formatConnectionStatusLabel,
  getConnectionStatusPollMs,
  resolveConnectionStatusVisual,
} from "../connectionStatus.js";
import type { ConnectionStatusLineProps as Props } from "./types.js";

/**
 * Renders an inline border status block indicating whether the connection to the host server is active, polling, or offline.
 *
 * @remarks
 * Keeps a local frame timer (`pulseIndex`) active only during intermediate/loading connection states
 * to save resources when the connection status is stable (fully connected or idle disconnected).
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { ConnectionStatusLine } from "./ConnectionStatusLine.js";
 * 
 * render(<ConnectionStatusLine status="connected" />);
 * ```
 */
export const ConnectionStatusLine: React.FC<Props> = ({ status }) => {
  // Drives connection loading states and spinner animations by tracking incremented ticks.
  const [pulseIndex, setPulseIndex] = useState(0);

  // Maps the current connection state to localized strings.
  const label = formatConnectionStatusLabel(status);

  // Resolves color palette, characters, and animation toggle requirements.
  const visual = resolveConnectionStatusVisual(status, pulseIndex);

  /**
   * Animation ticker that triggers only during pending/reconnecting connection phases.
   *
   * @remarks
   * Evaluates if the resolved status styling demands continuous animation updates
   * (`visual.animate`). Registers the standard connection polling rate (`getConnectionStatusPollMs`)
   * to align the tick frequency with state updates.
   */
  useEffect(() => {
    if (!visual.animate) {
      return;
    }

    const timer = setInterval(() => {
      setPulseIndex((previous) => previous + 1);
    }, getConnectionStatusPollMs());

    return () => clearInterval(timer);
  }, [visual.animate]);

  return (
    <Box marginLeft={2} marginTop={0}>
      {/* Renders connection health context in a stylized inline boundary block */}
      <Text color={visual.color} bold>
        │ {visual.glyph} {label} │
      </Text>
    </Box>
  );
};
