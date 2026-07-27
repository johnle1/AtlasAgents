/**
 * Generic themed line printers for status, errors, and successes.
 *
 * @remarks
 * Builds ANSI with {@link getTheme}, then appends via the history
 * {@link appendText} / {@link appendBlock} sinks.
 */

import { getTheme } from "../theme/themeManager.js";
import { appendBlock, appendText } from "./sink.js";

/**
 * Prints a plain system log line (no icon).
 *
 * @param text - Message text (may already include indentation).
 *
 * @example
 * ```ts
 * printLine("  Exploring codebase...");
 * ```
 */
export const printLine = (text: string): void => {
  appendText(text, "system");
};

/**
 * Prints an error block with a themed `error:` prefix.
 *
 * @remarks
 * Always ends with the theme reset sequence so subsequent history lines do not
 * inherit the error color.
 *
 * @param message - Human-readable failure text (no need to include `"error:"`).
 *
 * @example
 * ```ts
 * printError("Port must be an integer between 1 and 65535.");
 * ```
 */
export const printError = (message: string): void => {
  const theme = getTheme();
  // Reset after the label so the message body uses default fg, not error red.
  appendBlock([`${theme.error}  error:${theme.reset} ${message}`]);
};

/**
 * Prints a success block with a themed checkmark.
 *
 * @param message - Confirmation text after the `✓`.
 *
 * @example
 * ```ts
 * printSuccess("Password updated.");
 * ```
 */
export const printSuccess = (message: string): void => {
  const theme = getTheme();
  appendBlock([`${theme.success}  ✓${theme.reset} ${message}`]);
};
