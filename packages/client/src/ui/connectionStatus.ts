/**
 * Connection status rendering helpers.
 *
 * @remarks
 * Contains styling mappings for formatting RSocket connection statuses into human-readable labels
 * and configuring icon color pulsing parameters.
 */

import type { ConnectionStatus } from "../connection/index.js";
import {
  getWorkingFrame,
  getWorkingFrameMs,
} from "./statusVisual.js";

/**
 * Formats a raw connection status string into a human-readable display label.
 *
 * @param status - The raw ConnectionStatus state.
 * @returns The formatted string.
 */
export const formatConnectionStatusLabel = (
  status: ConnectionStatus,
): string =>
  status === "Connected"
    ? "Connected"
    : status === "Connecting"
      ? "Connecting"
      : status === "Reconnecting"
        ? "Reconnecting"
        : "Disconnection";

/** Visual properties configured for connection statuses. */
export type ConnectionStatusVisual = {
  /** The icon character to render. */
  glyph: string;
  /** Color bucket for status. */
  color: "green" | "red" | "yellow";
  /** Trigger animation pulsing. */
  animate: boolean;
};

/**
 * Resolves the visual options and glyph to render for a given connection status.
 *
 * @param status - Active connection status.
 * @param pulseIndex - Animation index loop offset.
 * @returns Connection visual properties.
 */
export const resolveConnectionStatusVisual = (
  status: ConnectionStatus,
  pulseIndex: number,
): ConnectionStatusVisual => {
  switch (status) {
    case "Connected":
      return { glyph: "●", color: "green", animate: false };
    case "Disconnected":
      return { glyph: "●", color: "red", animate: false };
    case "Connecting":
    case "Reconnecting":
      return {
        glyph: getWorkingFrame(pulseIndex),
        color: "yellow",
        animate: true,
      };
  }
};

/**
 * Returns the pulse interval tick rate in milliseconds.
 */
export const getConnectionStatusPollMs = (): number => getWorkingFrameMs();

