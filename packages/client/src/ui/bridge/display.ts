/**
 * <Summary>
 * What it does:
 *   Provides functions for managing the display state and terminal features
 *   in the Ink-based CLI UI through the bridge system.
 *
 * How it fits in the system:
 *   These functions handle UI display aspects like busy state indicators, current
 *   working directory labels, banner refresh, and terminal alternate screen mode.
 *   They update the global application state through the bridge hooks system.
 *
 * Dependencies:
 *   - getBridgeHooks — provides access to global state update hooks.
 *   - Config — type definition for application configuration.
 *
 * Dependants:
 *   - Server communication handlers — call these to update display state.
 *   - Terminal management functions — use these for terminal features.
 * </Summary>
 */

import type { Config } from "../../config.js";
import { getBridgeHooks } from "./state.js";

/**
 * <Summary>
 * What it does:
 *   Updates the global busy state to indicate if the application is currently
 *   processing a long-running operation.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onBusy hook with the new busy state.
 *   3. The hook updates the global state and triggers UI re-render.
 *
 * Parameters:
 *   @param {boolean} busyState — True if application is busy, false if idle.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - getBridgeHooks — provides access to global state update hooks.
 *
 * Dependants:
 *   - Connection streaming handlers — call this during long operations.
 *   - Task execution functions — use this to show busy state to users.
 * </Summary>
 */
export const setBusy = (busyState: boolean): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Update Busy State =====
  // Step 2a: Call the onBusy hook with the new busy state
  // Step 2b: This updates the global state and triggers UI re-render
  // Step 2c: UI components can show/hide busy indicators based on this
  bridgeHooks.onBusy?.(busyState);
};

/**
 * <Summary>
 * What it does:
 *   Updates the current working directory label displayed in the CLI prompt.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onCwd hook with the new working directory path.
 *   3. The hook updates the prompt state and triggers UI re-render.
 *
 * Parameters:
 *   @param {string} currentWorkingDirectory — The current working directory path to display.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - getBridgeHooks — provides access to global state update hooks.
 *
 * Dependants:
 *   - File proxy handlers — call this when directory changes.
 *   - Workspace navigation functions — use this to update prompt on cd operations.
 * </Summary>
 */
export const setCwdLabel = (currentWorkingDirectory: string): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Update Working Directory Label =====
  // Step 2a: Call the onCwd hook with the new working directory
  // Step 2b: This updates the prompt label to show the current directory
  // Step 2c: The prompt component rebuilds the label with the new path
  bridgeHooks.onCwd?.(currentWorkingDirectory);
};

/**
 * <Summary>
 * What it does:
 *   Triggers a refresh of the Ink banner with the current configuration.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onBannerRefresh hook with the current configuration.
 *   3. The hook rebuilds the banner lines and updates the global state.
 *
 * Parameters:
 *   @param {Config} configuration — The current application configuration.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - getBridgeHooks — provides access to global state update hooks.
 *
 * Dependants:
 *   - Configuration update handlers — call this after config changes.
 *   - Theme change functions — use this to refresh banner after theme update.
 * </Summary>
 */
export const refreshInkBanner = (configuration: Config): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Trigger Banner Refresh =====
  // Step 2a: Call the onBannerRefresh hook with the configuration
  // Step 2b: This triggers the banner to rebuild with new configuration
  // Step 2c: The banner component recreates the display with updated config
  bridgeHooks.onBannerRefresh?.(configuration);
};

/**
 * <Summary>
 * What it does:
 *   Enters terminal alternate screen mode for full-screen UI display.
 *
 * How it does it (step by step):
 *   1. Checks if the output is a TTY (interactive terminal).
 *   2. If not a TTY, returns early (alternate screen not supported).
 * 3. Writes ANSI escape sequences to enable alternate screen mode.
 *   4. This hides the terminal scrollback and provides a clean display area.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - None (uses process.stdout and ANSI escape sequences).
 *
 * Dependants:
 *   - useBridgeSetup hook — calls this when alternate buffer is enabled in config.
 *   - Terminal management functions — use this for full-screen UI mode.
 * </Summary>
 */
export const enterAlternateScreen = (): void => {
  // ===== STEP 1: Check for TTY Support =====
  // Step 1a: Check if stdout is a TTY (interactive terminal)
  // Step 1b: Alternate screen mode is only supported in interactive terminals
  if (!process.stdout.isTTY) return;

  // ===== STEP 2: Enable Alternate Screen Mode =====
  // Step 2a: Write ANSI escape sequence to enable alternate screen buffer
  // Step 2b: \x1b[?1049h enables the alternate screen buffer (DECCKM)
  // Step 2c: \x1b[?25l hides the cursor in the alternate screen
  process.stdout.write("\x1b[?1049h\x1b[?25l");
};

/**
 * <Summary>
 * What it does:
 *   Exits terminal alternate screen mode and returns to normal terminal display.
 *
 * How it does it (step by step):
 *   1. Checks if the output is a TTY (interactive terminal).
 *   2. If not a TTY, returns early (alternate screen not supported).
 *   3. Writes ANSI escape sequences to disable alternate screen mode.
 *   4. This restores the normal terminal display with scrollback.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - None (uses process.stdout and ANSI escape sequences).
 *
 * Dependants:
 *   - useBridgeSetup hook — calls this when component unmounts.
 *   - Terminal management functions — use this to return to normal mode.
 * </Summary>
 */
export const exitAlternateScreen = (): void => {
  // ===== STEP 1: Check for TTY Support =====
  // Step 1a: Check if stdout is a TTY (interactive terminal)
  // Step 1b: Alternate screen mode is only supported in interactive terminals
  if (!process.stdout.isTTY) return;

  // ===== STEP 2: Disable Alternate Screen Mode =====
  // Step 2a: Write ANSI escape sequence to disable alternate screen buffer
  // Step 2b: \x1b[?25h shows the cursor in the alternate screen
  // Step 2c: \x1b[?1049l disables the alternate screen buffer (DECCKM)
  process.stdout.write("\x1b[?25h\x1b[?1049l");
};
