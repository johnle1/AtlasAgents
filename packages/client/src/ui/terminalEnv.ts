/** Terminal environment helpers (tmux-safe spinner, etc.). */

export const inTmux = (): boolean =>
  typeof process.env.TMUX === "string" && process.env.TMUX.length > 0;

export const isScreenReaderLikely = (): boolean =>
  process.env.TERM === "dumb" || process.env.CI === "true";
