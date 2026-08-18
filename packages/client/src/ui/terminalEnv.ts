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

/**
 * Whether ANSI color should be suppressed (NO_COLOR spec).
 *
 * @remarks
 * Any **non-empty** `NO_COLOR` value disables color. An empty string does
 * not. When both `NO_COLOR` and `FORCE_COLOR` are set, `NO_COLOR` wins
 * (Node.js convention).
 *
 * @returns `true` when color escapes must not be emitted.
 *
 * @example
 * ```ts
 * if (colorDisabled()) return plainText;
 * ```
 */
export const colorDisabled = (): boolean => {
  const noColor = process.env.NO_COLOR;
  return typeof noColor === "string" && noColor.length > 0;
};

/**
 * Whether color should be forced on even in non-TTY / dumb terminals.
 *
 * @remarks
 * `FORCE_COLOR` is honored only when {@link colorDisabled} is false —
 * `NO_COLOR` always wins.
 *
 * @returns `true` when `FORCE_COLOR` is a non-empty string and color is
 *   not disabled.
 */
export const colorForced = (): boolean => {
  if (colorDisabled()) return false;
  const forceColor = process.env.FORCE_COLOR;
  return typeof forceColor === "string" && forceColor.length > 0;
};

/**
 * Whether the terminal is likely to show OSC 9 desktop notifications.
 *
 * @remarks
 * iTerm2, WezTerm, and Ghostty advertise via `TERM_PROGRAM`. Kitty sets
 * `TERM` to a value containing `"kitty"`. Other terminals get a BEL fallback
 * from {@link notifyUser}.
 *
 * @returns `true` when OSC 9 (`\x1b]9;…\x07`) should be used.
 */
export const supportsOsc9Notifications = (): boolean => {
  const program = process.env.TERM_PROGRAM ?? "";
  if (
    program === "iTerm.app" ||
    program === "WezTerm" ||
    program === "ghostty"
  ) {
    return true;
  }
  const term = process.env.TERM ?? "";
  return term.toLowerCase().includes("kitty");
};

