/**
 * Bridge hooks and active state management for the Ink-based UI.
 *
 * @remarks
 * This module allows server-side operations and non-React command handling code
 * to trigger reactivity and state updates within the React-based Ink CLI interface.
 */

import {
  getInkUIActive,
  setBridgeHooks,
  setInkUIActiveValue,
} from "./state.js";
import type { BridgeHooks } from "./types.js";

export type { BridgeHooks } from "./types.js";

/**
 * Sets whether the Ink CLI UI is currently active and processing events.
 *
 * @param isActive - True to activate the Ink UI bridge, false to deactivate/pause it.
 */
export const setInkActive = (isActive: boolean): void => {
  setInkUIActiveValue(isActive);
};

/**
 * Checks whether the Ink CLI UI is currently active and processing events.
 *
 * @returns True if the Ink UI is active and rendering, false otherwise.
 */
export const isInkActive = (): boolean => getInkUIActive();

/**
 * Registers the bridge hooks that dispatch state updates to the React UI context.
 *
 * @remarks
 * These hooks are typically registered once during component mount in the main React application
 * context setup (e.g., in `useBridgeSetup`) and cleared on unmount.
 *
 * @param newBridgeHooks - An object containing callback functions for various UI state updates.
 */
export const registerBridgeHooks = (newBridgeHooks: BridgeHooks): void => {
  setBridgeHooks(newBridgeHooks);
};
