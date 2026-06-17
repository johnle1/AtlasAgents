/**
 * <Summary>
 * What it does:
 *   Provides a simple logging interface for console output with consistent formatting.
 *
 * How it fits in the system:
 *   Replaces direct console.log calls throughout the codebase with a structured
 *   logging interface that provides consistency and makes it easier to add
 *   advanced logging features in the future (like log levels, file output, etc.).
 *
 * Dependencies:
 *   - None (uses built-in console methods).
 *
 * Dependants:
 *   - All modules that previously used console.log directly.
 * </Summary>
 */

/**
 * Simple logger interface for consistent console output.
 */
export const logger = {
  /**
   * Logs an informational message to stdout.
   *
   * @param message - The message to log.
   */
  info: (message: string): void => {
    console.log(message);
  },

  /**
   * Logs a blank line for visual separation.
   */
  blank: (): void => {
    console.log();
  },

  /**
   * Logs a warning message to stdout.
   *
   * @param message - The warning message to log.
   */
  warn: (message: string): void => {
    console.log(message);
  },

  /**
   * Logs an error message to stderr.
   *
   * @param message - The error message to log.
   */
  error: (message: string): void => {
    console.error(message);
  },
};
