/**
 * Thin logging facade over `console` for consistent client output.
 *
 * @remarks
 * Centralizes stdout/stderr writes so call sites stay uniform and future
 * enhancements (log levels, timestamps, file sinks) can be added in one
 * place. Today this is a direct pass-through to Node's `console` methods.
 *
 * @example
 * ```ts
 * import { logger } from "./utils/logger.js";
 *
 * logger.info("Connected to server");
 * logger.warn("Config file missing — using defaults");
 * logger.error("Connection failed");
 * logger.blank();
 * ```
 */

/**
 * Logger object with methods for common output patterns.
 *
 * @remarks
 * `info` and `warn` both write to **stdout** (`console.log`). Only `error`
 * uses stderr. This matches the client's terminal UI, where warnings are
 * styled in-place rather than routed to a separate stream.
 */
export const logger = {
  /**
   * Writes an informational message to stdout.
   *
   * @param message - Text to print (no automatic prefix or timestamp).
   *
   * @example
   * ```ts
   * logger.info("Task completed");
   * ```
   */
  info: (message: string): void => {
    console.log(message);
  },

  /**
   * Writes a blank line to stdout for visual separation.
   *
   * @example
   * ```ts
   * logger.info("Section A");
   * logger.blank();
   * logger.info("Section B");
   * ```
   */
  blank: (): void => {
    console.log();
  },

  /**
   * Writes a warning message to stdout.
   *
   * @remarks
   * Uses `console.log`, not `console.warn`, so output stays on the same
   * stream as {@link logger.info} in terminal UI mode.
   *
   * @param message - Warning text to print.
   *
   * @example
   * ```ts
   * logger.warn("Deprecated option — use --host instead");
   * ```
   */
  warn: (message: string): void => {
    console.log(message);
  },

  /**
   * Writes an error message to stderr.
   *
   * @param message - Error text to print.
   *
   * @example
   * ```ts
   * logger.error("Failed to read config: ENOENT");
   * ```
   */
  error: (message: string): void => {
    console.error(message);
  },
};
