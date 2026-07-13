/**
 * UI toggle slash commands: `/spinner` and `/think`.
 *
 * @remarks
 * Both accept `on` / `off` in either the subcommand or argument slot
 * (`/spinner on` and `/spinner` with arg `on` behave the same). Omitting the
 * token prints the current setting without writing config.
 */

import { loadConfig, updateConfig } from "../config.js";
import { printSuccess, printLine } from "../renderer.js";

/**
 * Enables, disables, or reports the status of the animated UI spinner.
 *
 * @remarks
 * Persists `ui.showSpinner` via {@link updateConfig}. Missing/`undefined`
 * spinner preference is treated as enabled when reporting status
 * (`!== false`).
 *
 * @param sub - First token after `/spinner` (often `"on"` / `"off"`).
 * @param arg - Overflow token if the user placed `on`/`off` after a blank sub.
 *
 * @example
 * ```ts
 * handleSpinner("on", "");
 * handleSpinner("", "off");
 * handleSpinner("", ""); // prints current status
 * ```
 */
export const handleSpinner = (sub: string, arg: string): void => {
  // Allow `/spinner on` or `/spinner` + arg interchangeably from the router.
  const token = (sub || arg).trim().toLowerCase();
  const config = loadConfig();

  if (token === "on") {
    updateConfig({ ui: { ...config.ui, showSpinner: true } });
    printSuccess("UI spinner enabled.");
    return;
  }

  if (token === "off") {
    updateConfig({ ui: { ...config.ui, showSpinner: false } });
    printSuccess("UI spinner disabled.");
    return;
  }

  const enabled = config.ui.showSpinner !== false;
  printLine(
    `  UI spinner: ${enabled ? "on" : "off"} (use /spinner on | /spinner off)`,
  );
};

/**
 * Enables, disables, or reports advisor/agent think-box visibility.
 *
 * @remarks
 * Persists top-level `showThinkOutput` in config. When off, think frames are
 * still produced by the server but not rendered in the CLI.
 *
 * @param sub - First token after `/think`.
 * @param arg - Alternate `on`/`off` position.
 *
 * @example
 * ```ts
 * handleThink("off", "");
 * ```
 */
export const handleThink = (sub: string, arg: string): void => {
  const token = (sub || arg).trim().toLowerCase();

  if (token === "on") {
    updateConfig({ showThinkOutput: true });
    printSuccess("Think output enabled (advisor/agent think boxes).");
    return;
  }

  if (token === "off") {
    updateConfig({ showThinkOutput: false });
    printSuccess("Think output disabled.");
    return;
  }

  const enabled = loadConfig().showThinkOutput;
  printLine(
    `  Think output: ${enabled ? "on" : "off"} (use /think on | /think off)`,
  );
};
