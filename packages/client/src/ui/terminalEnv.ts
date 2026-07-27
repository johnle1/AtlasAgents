/**
 * Terminal environment helper utilities.
 *
 * @remarks
 * Detects specific shell wrappers (e.g. tmux buffers) or non-interactive environments
 * (e.g. CI environments or simple dumb terminals) for responsive UI feature styling fallback.
 */

/**
 * Checks if the CLI is running inside a tmux buffer environment.
 *
 * @returns True if within tmux.
 */
export const inTmux = (): boolean =>
  typeof process.env.TMUX === "string" && process.env.TMUX.length > 0;

/**
 * Checks if the terminal environment represents a screen reader or non-interactive dumb buffer.
 *
 * @returns True if dumb terminal or CI environment.
 */
export const isScreenReaderLikely = (): boolean =>
  process.env.TERM === "dumb" || process.env.CI === "true";

