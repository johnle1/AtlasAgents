/**
 * Theme contract and built-in palette registry for the AtlasAgents CLI.
 *
 * @remarks
 * Each {@link Theme} is a bag of ANSI CSI strings (not CSS). Custom palettes
 * below compose classic 16-color / 256-color codes; VS Code and GitHub looks
 * come from `vscodeGithubThemes.ts`. The theme manager (`themeManager.ts`)
 * selects the active entry via `config.ui.theme`.
 */

import {
  githubDarkTheme,
  githubDimmedTheme,
  githubLightTheme,
  vscodeDarkModernTheme,
  vscodeTheme,
} from "./vscodeGithubThemes.js";

/**
 * Complete ANSI styling kit for one CLI appearance.
 *
 * @remarks
 * All color fields are escape sequences ready to embed in terminal strings
 * (e.g. `"\x1b[36m"`). Always terminate styled spans with {@link Theme.reset}
 * so colors do not bleed into later output. `shikiTheme` is a Shiki theme *id*
 * for code highlighting, not an ANSI string.
 *
 * @example
 * ```ts
 * const t: Theme = THEMES.default!;
 * process.stdout.write(`${t.success}ok${t.reset}\n`);
 * ```
 */
export interface Theme {
  /** Human-readable name shown in `/theme` pickers. */
  name: string;

  /** Box / panel border foreground. */
  border: string;

  /** Labels on borders (version chips, metadata). */
  borderText: string;

  /** Default body text (often reset / default fg). */
  textPrimary: string;

  /** Muted metadata, timestamps, dim helpers. */
  textSecondary: string;

  /** Highlights and interactive accents. */
  textAccent: string;

  /** Bold emphasis CSI (usually `\x1b[1m`). */
  textBold: string;

  /** Border around agent/subagent think boxes. */
  thinkBorder: string;

  /** Body text inside think boxes. */
  thinkText: string;

  /** Label text for think sections. */
  thinkLabel: string;

  /** Foreground for diff “added” plain coloring. */
  diffAdded: string;

  /** Foreground for diff “removed” plain coloring. */
  diffRemoved: string;

  /** Foreground for unchanged context lines. */
  diffContext: string;

  /** Background CSI for highlighted added lines. */
  diffBgAdded: string;

  /** Background CSI for highlighted removed lines. */
  diffBgRemoved: string;

  /**
   * Shiki theme id used when syntax-highlighting diff code
   * (e.g. `"dark-plus"`, `"github-light"`).
   */
  shikiTheme: string;

  /** Default prompt input text color. */
  promptText: string;

  /** Prompt caret / focus accent. */
  promptAccent: string;

  /** Success / affirmative messages. */
  success: string;

  /** Error / failure messages. */
  error: string;

  /** Warning / caution messages. */
  warning: string;

  /** Full SGR reset (`\x1b[0m`) — clear styles after a span. */
  reset: string;
}

/**
 * Shared classic ANSI / xterm-256 building blocks for custom themes.
 *
 * @remarks
 * Prefer composing these over raw escapes so palettes stay consistent.
 * Values may be concatenated (e.g. `dim + cyan`) for compound styles.
 */
const colorCodes = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  cyanBright: "\x1b[96m",
  green: "\x1b[32m",
  greenBright: "\x1b[92m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  blueBright: "\x1b[94m",
  magenta: "\x1b[35m",
  /** Warm orange from the 256-color cube (index 208). */
  orange: "\x1b[38;5;208m",
  teal: "\x1b[38;5;43m",
  forest: "\x1b[38;5;34m",
  forestDim: "\x1b[38;5;22m",
  salmon: "\x1b[38;5;209m",
  peach: "\x1b[38;5;223m",
};

/** Dark-theme add-line background (256-color index 22). */
const diffBackgroundDarkAdded = "\x1b[48;5;22m";
/** Dark-theme remove-line background (256-color index 52). */
const diffBackgroundDarkRemoved = "\x1b[48;5;52m";

/** Monochrome add-line background (near-black gray). */
const diffBackgroundMonoAdded = "\x1b[48;5;235m";
/** Monochrome remove-line background (slightly darker gray). */
const diffBackgroundMonoRemoved = "\x1b[48;5;234m";

/**
 * Shared dark Shiki + dark diff backgrounds for custom dark palettes.
 *
 * @remarks
 * Spread into theme objects so `default` / `ocean` / `forest` / `sunset` stay
 * aligned on highlighting and diff wash colors.
 */
const darkShikiConfig = {
  diffBgAdded: diffBackgroundDarkAdded,
  diffBgRemoved: diffBackgroundDarkRemoved,
  shikiTheme: "dark-plus",
} as const;

/**
 * Registry of theme key → {@link Theme} for the CLI.
 *
 * @remarks
 * Keys are stable config ids (`config.ui.theme`). Display names live on
 * `Theme.name`. Import vscode/github themes are keyed with dashed ids for
 * readability (`"vscode-dark"`, `"github-light"`).
 *
 * @example
 * ```ts
 * const ocean = THEMES.ocean;
 * const gh = THEMES["github-dark"];
 * ```
 */
export const THEMES: Record<string, Theme> = {
  /** Balanced cyan default used when no preference is set. */
  default: {
    name: "Default",
    border: colorCodes.dim + colorCodes.cyan,
    borderText: colorCodes.dim,
    textPrimary: colorCodes.reset,
    textSecondary: colorCodes.gray,
    textAccent: colorCodes.cyanBright,
    textBold: colorCodes.bold,
    thinkBorder: colorCodes.dim + colorCodes.cyan,
    thinkText: colorCodes.dim,
    thinkLabel: colorCodes.dim,
    diffAdded: colorCodes.green,
    diffRemoved: colorCodes.red,
    diffContext: colorCodes.gray,
    ...darkShikiConfig,
    promptText: colorCodes.reset,
    promptAccent: colorCodes.cyanBright,
    success: colorCodes.green,
    error: colorCodes.red,
    warning: colorCodes.yellow,
    reset: colorCodes.reset,
  },

  /** Cool blues / teals. */
  ocean: {
    name: "Ocean",
    border: colorCodes.blueBright,
    borderText: colorCodes.blue,
    textPrimary: colorCodes.reset,
    textSecondary: colorCodes.dim + colorCodes.blue,
    textAccent: colorCodes.cyanBright,
    textBold: colorCodes.bold,
    thinkBorder: colorCodes.teal,
    thinkText: colorCodes.dim + colorCodes.blue,
    thinkLabel: colorCodes.dim + colorCodes.blue,
    diffAdded: colorCodes.teal,
    diffRemoved: colorCodes.salmon,
    diffContext: colorCodes.dim + colorCodes.blue,
    ...darkShikiConfig,
    promptText: colorCodes.reset,
    promptAccent: colorCodes.cyanBright,
    success: colorCodes.teal,
    error: colorCodes.salmon,
    warning: colorCodes.peach,
    reset: colorCodes.reset,
  },

  /** Greens / earth tones. */
  forest: {
    name: "Forest",
    border: colorCodes.forest,
    borderText: colorCodes.forestDim,
    textPrimary: colorCodes.reset,
    textSecondary: colorCodes.dim + colorCodes.forest,
    textAccent: colorCodes.greenBright,
    textBold: colorCodes.bold,
    thinkBorder: colorCodes.forest,
    thinkText: colorCodes.dim + colorCodes.forest,
    thinkLabel: colorCodes.dim + colorCodes.forest,
    diffAdded: colorCodes.greenBright,
    diffRemoved: colorCodes.salmon,
    diffContext: colorCodes.dim + colorCodes.forest,
    ...darkShikiConfig,
    promptText: colorCodes.reset,
    promptAccent: colorCodes.greenBright,
    success: colorCodes.greenBright,
    error: colorCodes.red,
    warning: colorCodes.yellow,
    reset: colorCodes.reset,
  },

  /**
   * High-contrast grayscale (accessibility / distraction-free).
   *
   * @remarks
   * Uses dedicated mono diff backgrounds instead of {@link darkShikiConfig}
   * so green/red washes do not break the monochrome look.
   */
  monochrome: {
    name: "Monochrome",
    border: colorCodes.white,
    borderText: colorCodes.dim,
    textPrimary: colorCodes.reset,
    textSecondary: colorCodes.gray,
    textAccent: colorCodes.white,
    textBold: colorCodes.bold,
    thinkBorder: colorCodes.gray,
    thinkText: colorCodes.dim,
    thinkLabel: colorCodes.dim,
    diffAdded: colorCodes.white,
    diffRemoved: colorCodes.gray,
    diffContext: colorCodes.dim,
    diffBgAdded: diffBackgroundMonoAdded,
    diffBgRemoved: diffBackgroundMonoRemoved,
    shikiTheme: "dark-plus",
    promptText: colorCodes.reset,
    promptAccent: colorCodes.white,
    success: colorCodes.white,
    error: colorCodes.white,
    warning: colorCodes.gray,
    reset: colorCodes.reset,
  },

  /** Warm oranges / magentas. */
  sunset: {
    name: "Sunset",
    border: colorCodes.orange,
    borderText: colorCodes.peach,
    textPrimary: colorCodes.reset,
    textSecondary: colorCodes.dim + colorCodes.orange,
    textAccent: colorCodes.peach,
    textBold: colorCodes.bold,
    thinkBorder: colorCodes.salmon,
    thinkText: colorCodes.dim + colorCodes.peach,
    thinkLabel: colorCodes.dim + colorCodes.peach,
    diffAdded: colorCodes.peach,
    diffRemoved: colorCodes.magenta,
    diffContext: colorCodes.dim + colorCodes.orange,
    ...darkShikiConfig,
    promptText: colorCodes.reset,
    promptAccent: colorCodes.peach,
    success: colorCodes.peach,
    error: colorCodes.magenta,
    warning: colorCodes.orange,
    reset: colorCodes.reset,
  },

  /** VS Code Dark+ — see {@link vscodeTheme}. */
  "vscode-dark": vscodeTheme,

  /** VS Code Dark Modern — see {@link vscodeDarkModernTheme}. */
  "vscode-modern": vscodeDarkModernTheme,

  /** GitHub Dark — see {@link githubDarkTheme}. */
  "github-dark": githubDarkTheme,

  /** GitHub Dimmed — see {@link githubDimmedTheme}. */
  "github-dimmed": githubDimmedTheme,

  /**
   * GitHub Light — see {@link githubLightTheme}.
   *
   * @remarks
   * Only built-in light palette; uses light diff backgrounds from that module.
   */
  "github-light": githubLightTheme,
};

/**
 * All registry keys in {@link THEMES} (order follows object insertion).
 *
 * @remarks
 * Handy for `/theme` menus — iterate keys and read `THEMES[key].name`.
 *
 * @example
 * ```ts
 * for (const key of THEME_KEYS) {
 *   console.log(key, THEMES[key]!.name);
 * }
 * ```
 */
export const THEME_KEYS = Object.keys(THEMES);
