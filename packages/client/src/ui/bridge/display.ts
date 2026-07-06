/**
 * Display, busy state, prompt label, and alternate buffer management for the Ink CLI UI.
 *
 * @remarks
 * This module controls terminal-level rendering behavior like toggling full-screen
 * alternate screen buffers, setting busy indicators, and modifying the active command line label.
 */

import type { Config } from "../../config.js";
import {
  getBridgeHooks,
  getTaskActiveValue,
  setTaskActiveValue,
} from "./state.js";

/**
 * Sets whether the application is currently executing a backend task.
 *
 * @param busyState - True if the application is busy, false otherwise.
 */
export const setBusy = (busyState: boolean): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onBusy?.(busyState);
};

/**
 * Toggles whether a task stream is currently active.
 *
 * @param isTaskActive - True if a task stream is running, false otherwise.
 */
export const setTaskActive = (isTaskActive: boolean): void => {
  const bridgeHooks = getBridgeHooks();
  setTaskActiveValue(isTaskActive);
  bridgeHooks.onTaskActive?.(isTaskActive);
};

/**
 * Retrieves the current state of whether a task is active.
 *
 * @returns True if a task is active, false otherwise.
 */
export const getTaskActive = (): boolean => getTaskActiveValue();

/**
 * Checks if a task is currently active.
 *
 * @returns True if a task is active, false otherwise.
 */
export const isTaskActive = (): boolean => getTaskActiveValue();

/**
 * Sets the working directory path label displayed in the terminal prompt.
 *
 * @param currentWorkingDirectory - The current working directory path to output.
 */
export const setCwdLabel = (currentWorkingDirectory: string): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onCwd?.(currentWorkingDirectory);
};

/**
 * Forces a refresh of the main Ink UI banner elements using the provided config.
 *
 * @param configuration - The active CLI configuration.
 */
export const refreshInkBanner = (configuration: Config): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onBannerRefresh?.(configuration);
};

/**
 * Enters the terminal alternate screen buffer, hiding scrollback.
 *
 * @remarks
 * Writes ANSI escape sequences to stdout. Only executes if stdout is a TTY.
 * Useful for building full-screen immersive UI layouts.
 */
export const enterAlternateScreen = (): void => {
  if (!process.stdout.isTTY) return;
  // \x1b[?1049h: switch to alternate screen; \x1b[?25l: hide terminal cursor
  process.stdout.write("\x1b[?1049h\x1b[?25l");
};

/**
 * Exits the terminal alternate screen buffer, restoring normal shell scrollback.
 *
 * @remarks
 * Writes ANSI escape sequences to stdout. Only executes if stdout is a TTY.
 */
export const exitAlternateScreen = (): void => {
  if (!process.stdout.isTTY) return;
  // \x1b[?25h: show terminal cursor; \x1b[?1049l: restore normal screen buffer
  process.stdout.write("\x1b[?25h\x1b[?1049l");
};

