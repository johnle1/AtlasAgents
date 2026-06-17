/**
 * <Summary>
 * What it does:
 *   Provides functions for managing the Ink UI bridge hooks and active state.
 *
 * How it fits in the system:
 *   This module manages the bridge hooks system that allows server-side code to
 *   communicate with the Ink-based UI by registering callback functions for various
 *   state updates like history, streaming, agent status, and approvals.
 *
 * Dependencies:
 *   - getInkUIActive/setInkUIActiveValue — manages Ink UI active state.
 *   - setBridgeHooks — registers bridge hooks for state updates.
 *   - BridgeHooks type definition — defines the hook interface.
 *
 * Dependants:
 *   - useBridgeSetup hook — registers bridge hooks during component mount.
 *   - Component setup functions — configure bridge communication.
 * </Summary>
 */

import {
  getInkUIActive,
  setBridgeHooks,
  setInkUIActiveValue,
} from "./state.js";
import type { BridgeHooks } from "./state.js";

/**
 * <Summary>
 * What it does:
 *   Re-exports the BridgeHooks type for use by other modules.
 *
 * Used by:
 *   - Modules that need to reference the BridgeHooks interface.
 *
 * Produced by:
 *   - state.ts — defines the BridgeHooks type.
 * </Summary>
 */
export type { BridgeHooks } from "./state.js";

/**
 * <Summary>
 * What it does:
 *   Sets whether the Ink UI is currently active and rendering.
 *
 * How it does it (step by step):
 *   1. Calls the internal function to update the Ink UI active state.
 *
 * Parameters:
 *   @param {boolean} isActive — Whether the Ink UI is active (true) or inactive (false).
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - setInkUIActiveValue — updates the internal Ink UI active state.
 *
 * Dependants:
 *   - useBridgeSetup hook — activates Ink UI on component mount.
 *   - Cleanup functions — deactivates Ink UI on component unmount.
 * </Summary>
 */
export const setInkActive = (isActive: boolean): void => {
  // ===== STEP 1: Update Ink UI Active State =====
  // Step 1a: Set the Ink UI active state to the provided value
  // Step 1b: This controls whether the Ink UI is rendering or paused
  setInkUIActiveValue(isActive);
};

/**
 * <Summary>
 * What it does:
 *   Checks whether the Ink UI is currently active and rendering.
 *
 * How it does it (step by step):
 *   1. Calls the internal function to check the Ink UI active state.
 *
 * Returns:
 *   @returns {boolean} — True if Ink UI is active, false otherwise.
 *
 * Dependencies:
 *   - getInkUIActive — retrieves the internal Ink UI active state.
 *
 * Dependants:
 *   - Approval request functions — check this to determine auto-resolution behavior.
 *   - Prompt request functions — check this to determine auto-resolution behavior.
 * </Summary>
 */
export const isInkActive = (): boolean => getInkUIActive();

/**
 * <Summary>
 * What it does:
 *   Registers the bridge hooks for state update notifications.
 *
 * How it does it (step by step):
 *   1. Calls the internal function to set the bridge hooks.
 *
 * Parameters:
 *   @param {BridgeHooks} newBridgeHooks — The bridge hooks to register.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - setBridgeHooks — updates the internal bridge hooks state.
 *
 * Dependants:
 *   - useBridgeSetup hook — registers hooks during component mount.
 *   - Component setup functions — configure bridge communication.
 * </Summary>
 */
export const registerBridgeHooks = (newBridgeHooks: BridgeHooks): void => {
  // ===== STEP 1: Register Bridge Hooks =====
  // Step 1a: Set the bridge hooks to the provided hooks object
  // Step 1b: This allows server-side code to trigger UI state updates
  // Step 1c: The hooks are called when various events occur (history append, streaming, etc.)
  setBridgeHooks(newBridgeHooks);
};
