/**
 * VS Code– and GitHub–inspired {@link Theme} palettes using truecolor hex tokens.
 *
 * @remarks
 * Hex accents go through {@link fg} so terminals without 24-bit color get a
 * 256-color approximation. Diff backgrounds use fixed 256-color washes shared
 * with the custom dark/light palettes in `themes.ts`.
 */

import type { Theme } from "./themes.js";
import { fg } from "./ansi256.js";

const dim = "\x1b[2m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";

/** Shared dark add/remove washes (xterm 256). */
const diffBackgroundDarkAdded = "\x1b[48;5;22m";
const diffBackgroundDarkRemoved = "\x1b[48;5;52m";

/** Shared light add/remove washes for {@link githubLightTheme}. */
const diffBackgroundLightAdded = "\x1b[48;5;150m";
const diffBackgroundLightRemoved = "\x1b[48;5;217m";

/**
 * VS Code Dark+ look (classic blue/teal accents, `dark-plus` Shiki).
 *
 * @remarks
 * Hex values roughly track VS Code’s default dark token colors
 * (`#569cd6` keywords/borders, `#4ec9b0` teal accents, etc.).
 *
 * @example
 * ```ts
 * THEMES["vscode-dark"] === vscodeTheme; // registered under this export
 * ```
 */
export const vscodeTheme: Theme = {
  name: "VS Code Dark+",
  border: dim + fg("#569cd6"),
  borderText: dim + fg("#d4d4d4"),
  textPrimary: reset,
  textSecondary: dim + fg("#6a9955"),
  textAccent: fg("#9cdcfe"),
  textBold: bold,
  thinkBorder: dim + fg("#4ec9b0"),
  thinkText: dim + fg("#d4d4d4"),
  thinkLabel: dim + fg("#4ec9b0"),
  diffAdded: fg("#b5cea8"),
  diffRemoved: fg("#ce9178"),
  diffContext: dim + fg("#6a9955"),
  diffBgAdded: diffBackgroundDarkAdded,
  diffBgRemoved: diffBackgroundDarkRemoved,
  shikiTheme: "dark-plus",
  promptText: reset,
  promptAccent: fg("#dcdcaa"),
  success: fg("#4ec9b0"),
  error: fg("#f44747"),
  warning: fg("#d7ba7d"),
  reset,
};

/**
 * VS Code Dark Modern look (purple/magenta borders, blue accents).
 *
 * @remarks
 * Softer “modern” VS Code chrome — mauve borders (`#c586c0`) with blue
 * `#569cd6` accents. Still uses `dark-plus` for Shiki.
 */
export const vscodeDarkModernTheme: Theme = {
  name: "VS Code Dark Modern",
  border: dim + fg("#c586c0"),
  borderText: dim + fg("#d4d4d4"),
  textPrimary: reset,
  textSecondary: dim + fg("#6a9955"),
  textAccent: fg("#569cd6"),
  textBold: bold,
  thinkBorder: dim + fg("#c586c0"),
  thinkText: dim + fg("#d4d4d4"),
  thinkLabel: dim + fg("#c586c0"),
  diffAdded: fg("#b5cea8"),
  diffRemoved: fg("#d16969"),
  diffContext: dim + fg("#808080"),
  diffBgAdded: diffBackgroundDarkAdded,
  diffBgRemoved: diffBackgroundDarkRemoved,
  shikiTheme: "dark-plus",
  promptText: reset,
  promptAccent: fg("#9cdcfe"),
  success: fg("#b5cea8"),
  error: fg("#d16969"),
  warning: fg("#d7ba7d"),
  reset,
};

/**
 * GitHub.com dark UI accents with `github-dark` Shiki highlighting.
 *
 * @remarks
 * Brand greens/reds/oranges (`#3fb950`, `#f85149`, `#d29922`) and link blue
 * `#58a6ff` mirror github.com dark mode chrome.
 */
export const githubDarkTheme: Theme = {
  name: "GitHub Dark",
  border: fg("#58a6ff"),
  borderText: dim + fg("#e6edf3"),
  textPrimary: reset,
  textSecondary: fg("#8b949e"),
  textAccent: fg("#58a6ff"),
  textBold: bold,
  thinkBorder: dim + fg("#58a6ff"),
  thinkText: dim + fg("#e6edf3"),
  thinkLabel: dim + fg("#58a6ff"),
  diffAdded: fg("#3fb950"),
  diffRemoved: fg("#f85149"),
  diffContext: fg("#8b949e"),
  diffBgAdded: diffBackgroundDarkAdded,
  diffBgRemoved: diffBackgroundDarkRemoved,
  shikiTheme: "github-dark",
  promptText: reset,
  promptAccent: fg("#d2a8ff"),
  success: fg("#3fb950"),
  error: fg("#f85149"),
  warning: fg("#d29922"),
  reset,
};

/**
 * GitHub Dimmed / dark-dimmed palette (`github-dark-dimmed` Shiki).
 *
 * @remarks
 * Lower-saturation twin of {@link githubDarkTheme} for softer terminals.
 */
export const githubDimmedTheme: Theme = {
  name: "GitHub Dimmed",
  border: fg("#6cb6ff"),
  borderText: dim + fg("#adbac7"),
  textPrimary: reset,
  textSecondary: fg("#768390"),
  textAccent: fg("#6cb6ff"),
  textBold: bold,
  thinkBorder: dim + fg("#6cb6ff"),
  thinkText: dim + fg("#adbac7"),
  thinkLabel: dim + fg("#6cb6ff"),
  diffAdded: fg("#56d364"),
  diffRemoved: fg("#ff7b72"),
  diffContext: fg("#768390"),
  diffBgAdded: diffBackgroundDarkAdded,
  diffBgRemoved: diffBackgroundDarkRemoved,
  shikiTheme: "github-dark-dimmed",
  promptText: reset,
  promptAccent: fg("#d2a8ff"),
  success: fg("#56d364"),
  error: fg("#ff7b72"),
  warning: fg("#e3b341"),
  reset,
};

/**
 * GitHub Light mode with light-terminal-friendly diff washes.
 *
 * @remarks
 * Uses {@link diffBackgroundLightAdded} / {@link diffBackgroundLightRemoved}
 * instead of the dark greens/reds so add/remove rows stay readable on light
 * backgrounds. Shiki theme is `github-light`.
 */
export const githubLightTheme: Theme = {
  name: "GitHub Light",
  border: fg("#0969da"),
  borderText: fg("#57606a"),
  textPrimary: reset,
  textSecondary: fg("#57606a"),
  textAccent: fg("#0969da"),
  textBold: bold,
  thinkBorder: fg("#0969da"),
  thinkText: fg("#57606a"),
  thinkLabel: fg("#0969da"),
  diffAdded: fg("#1a7f37"),
  diffRemoved: fg("#d1242f"),
  diffContext: fg("#57606a"),
  diffBgAdded: diffBackgroundLightAdded,
  diffBgRemoved: diffBackgroundLightRemoved,
  shikiTheme: "github-light",
  promptText: reset,
  promptAccent: fg("#8250df"),
  success: fg("#1a7f37"),
  error: fg("#d1242f"),
  warning: fg("#953800"),
  reset,
};
