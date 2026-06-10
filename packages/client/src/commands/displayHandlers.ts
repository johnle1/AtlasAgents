/**
 * Display toggle command handlers.
 *
 * This module handles commands for toggling UI display features:
 * - /spinner on|off
 * - /think on|off
 */

import { loadConfig, updateConfig } from "../config.js";
import { printSuccess, printLine } from "../renderer.js";

/**
 * <Summary>
 * What it does:
 *   Handles "/spinner" to enable or disable the UI spinner.
 *
 * How it does it (step by step):
 *   1. Parses the token from subcommand or argument.
 *   2. If token is "on", enables spinner in UI config.
 *   3. If token is "off", disables spinner in UI config.
 *   4. Otherwise displays current spinner status.
 *
 * Parameters:
 *   @param {string} sub — Subcommand: "on", "off", or empty.
 *   @param {string} arg — Alternative position for "on" or "off".
 *
 * Returns:
 *   @returns {void} — called for side effects only.
 *
 * Dependencies:
 *   - loadConfig, updateConfig — read and write config.
 *   - renderer.printSuccess, printLine — display output.
 *
 * Dependants:
 *   - CommandHandler.handle — calls this for /spinner commands.
 * </Summary>
 */
export const handleSpinner = (sub: string, arg: string): void => {
  // Parse token from subcommand or argument
  const token = (sub || arg).trim().toLowerCase();
  const config = loadConfig();
  if (token === "on") {
    // Enable spinner in UI config
    updateConfig({ ui: { ...config.ui, showSpinner: true } });
    printSuccess("UI spinner enabled.");
    return;
  }
  if (token === "off") {
    // Disable spinner in UI config
    updateConfig({ ui: { ...config.ui, showSpinner: false } });
    printSuccess("UI spinner disabled.");
    return;
  }
  // Display current spinner status
  const enabled = config.ui.showSpinner !== false;
  printLine(
    `  UI spinner: ${enabled ? "on" : "off"} (use /spinner on | /spinner off)`,
  );
};

/**
 * <Summary>
 * What it does:
 *   Handles "/think" to enable or disable advisor/agent think output display.
 *
 * How it does it (step by step):
 *   1. Parses the token from subcommand or argument.
 *   2. If token is "on", enables think output in config.
 *   3. If token is "off", disables think output in config.
 *   4. Otherwise displays current think output status.
 *
 * Parameters:
 *   @param {string} sub — Subcommand: "on", "off", or empty.
 *   @param {string} arg — Alternative position for "on" or "off".
 *
 * Returns:
 *   @returns {void} — called for side effects only.
 *
 * Dependencies:
 *   - loadConfig, updateConfig — read and write config.
 *   - renderer.printSuccess, printLine — display output.
 *
 * Dependants:
 *   - CommandHandler.handle — calls this for /think commands.
 * </Summary>
 */
export const handleThink = (sub: string, arg: string): void => {
  // Parse token from subcommand or argument
  const token = (sub || arg).trim().toLowerCase();
  if (token === "on") {
    // Enable think output
    updateConfig({ showThinkOutput: true });
    printSuccess("Think output enabled (advisor/agent think boxes).");
    return;
  }
  if (token === "off") {
    // Disable think output
    updateConfig({ showThinkOutput: false });
    printSuccess("Think output disabled.");
    return;
  }
  // Display current think output status
  const enabled = loadConfig().showThinkOutput;
  printLine(
    `  Think output: ${enabled ? "on" : "off"} (use /think on | /think off)`,
  );
};
