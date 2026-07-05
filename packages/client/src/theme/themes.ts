import {
  githubDarkTheme,
  githubDimmedTheme,
  githubLightTheme,
  vscodeDarkModernTheme,
  vscodeTheme,
} from "./vscodeGithubThemes.js";

/**
 * <Summary>
 * What it does:
 *   Defines the shape of a theme object containing all color codes for terminal UI elements.
 *
 * Used by:
 *   - All theme objects — implement this interface to ensure consistent structure.
 *   - themeManager — uses this type for the activeTheme variable.
 *   - vscodeGithubThemes — creates theme objects implementing this interface.
 *
 * Produced by:
 *   - All theme objects (default, ocean, forest, monochrome, sunset, vscode themes, github themes).
 * </Summary>
 */
export interface Theme {
  /** The display name of the theme for UI presentation. */
  name: string;

  /** Border color for UI sections and panels. */
  border: string;

  /** Text color for border labels and metadata. */
  borderText: string;

  /** Primary text color for main content and user messages. */
  textPrimary: string;

  /** Secondary text color for metadata, timestamps, and less important information. */
  textSecondary: string;

  /** Accent color for highlighting important elements and interactive components. */
  textAccent: string;

  /** Bold text formatting escape sequence for emphasis. */
  textBold: string;

  /** Border color for thought/reasoning sections in agent output. */
  thinkBorder: string;

  /** Text color for thought/reasoning content in agent output. */
  thinkText: string;

  /** Text color for thought/reasoning labels in agent output. */
  thinkLabel: string;

  /** Text color for added lines in diffs (green/warm colors). */
  diffAdded: string;

  /** Text color for removed lines in diffs (red/cool colors). */
  diffRemoved: string;

  /** Text color for context lines in diffs (neutral/grayscale). */
  diffContext: string;

  /** Background color for added lines in diffs (dark themes). */
  diffBgAdded: string;

  /** Background color for removed lines in diffs (dark themes). */
  diffBgRemoved: string;

  /** The Shiki syntax highlighting theme name to use for code blocks. */
  shikiTheme: string;

  /** Text color for user prompt text in input fields. */
  promptText: string;

  /** Accent color for prompt highlights and focus indicators. */
  promptAccent: string;

  /** Color for success messages and indicators. */
  success: string;

  /** Color for error messages and indicators. */
  error: string;

  /** Color for warning messages and indicators. */
  warning: string;

  /** Reset escape sequence to clear all formatting. */
  reset: string;
}

/**
 * <Summary>
 * What it does:
 *   Provides common ANSI escape sequences for basic terminal colors and formatting.
 *
 * Used by:
 *   - All custom theme objects — compose colors from these basic codes.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
const colorCodes = {
  /** Resets all text formatting to default. */
  reset: "\x1b[0m",

  /** Bold/bright text formatting. */
  bold: "\x1b[1m",

  /** Dim/faded text formatting. */
  dim: "\x1b[2m",

  /** White color (bright white). */
  white: "\x1b[97m",

  /** Gray color (dark gray). */
  gray: "\x1b[90m",

  /** Cyan color (standard cyan). */
  cyan: "\x1b[36m",

  /** Bright cyan color. */
  cyanBright: "\x1b[96m",

  /** Green color (standard green). */
  green: "\x1b[32m",

  /** Bright green color. */
  greenBright: "\x1b[92m",

  /** Red color (standard red). */
  red: "\x1b[31m",

  /** Yellow color (standard yellow). */
  yellow: "\x1b[33m",

  /** Blue color (standard blue). */
  blue: "\x1b[34m",

  /** Bright blue color. */
  blueBright: "\x1b[94m",

  /** Magenta color (standard magenta). */
  magenta: "\x1b[35m",

  /** Orange color (ANSI 256-color cube). */
  orange: "\x1b[38;5;208m",

  /** Teal color (ANSI 256-color cube). */
  teal: "\x1b[38;5;43m",

  /** Forest green color (ANSI 256-color cube). */
  forest: "\x1b[38;5;34m",

  /** Dim forest green color (ANSI 256-color cube). */
  forestDim: "\x1b[38;5;22m",

  /** Salmon color (ANSI 256-color cube). */
  salmon: "\x1b[38;5;209m",

  /** Peach color (ANSI 256-color cube). */
  peach: "\x1b[38;5;223m",
};

/**
 * <Summary>
 * What it does:
 *   Defines ANSI escape sequences for diff background colors in dark themes.
 *
 * Used by:
 *   - darkShiki — provides these background colors for dark theme diffs.
 *
 * Produced by:
 *   - None (static constants defined at module level).
 * </Summary>
 */
const diffBackgroundDarkAdded = "\x1b[48;5;22m";
const diffBackgroundDarkRemoved = "\x1b[48;5;52m";

/**
 * <Summary>
 * What it does:
 *   Defines ANSI escape sequences for diff background colors in light themes.
 *
 * Used by:
 *   - githubLightTheme — provides these background colors for light theme diffs.
 *
 * Produced by:
 *   - None (static constants defined at module level).
 * </Summary>
 */
const diffBackgroundLightAdded = "\x1b[48;5;150m";
const diffBackgroundLightRemoved = "\x1b[48;5;217m";

/**
 * <Summary>
 * What it does:
 *   Defines ANSI escape sequences for diff background colors in monochrome themes.
 *
 * Used by:
 *   - monochrome theme — provides these background colors for monochrome diffs.
 *
 * Produced by:
 *   - None (static constants defined at module level).
 * </Summary>
 */
const diffBackgroundMonoAdded = "\x1b[48;5;235m";
const diffBackgroundMonoRemoved = "\x1b[48;5;234m";

/**
 * <Summary>
 * What it does:
 *   Provides common diff background colors for dark-themed Shiki syntax highlighting.
 *
 * Used by:
 *   - Custom dark themes (default, ocean, forest, sunset) — extend this base configuration.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
const darkShikiConfig = {
  /** Background color for added lines in dark themes. */
  diffBgAdded: diffBackgroundDarkAdded,

  /** Background color for removed lines in dark themes. */
  diffBgRemoved: diffBackgroundDarkRemoved,

  /** The Shiki theme name for dark mode syntax highlighting. */
  shikiTheme: "dark-plus",
} as const;

/**
 * <Summary>
 * What it does:
 *   Maps theme keys to theme objects containing all color codes for the UI.
 *
 * How it fits in the system:
 *   Central theme registry that the themeManager uses to load and switch themes.
 *   Contains both custom themes and imported VS Code/GitHub themes for consistency.
 * </Summary>
 */
export const THEMES: Record<string, Theme> = {
  /**
   * <Summary>
   * What it does:
   *   The default cyan-themed color scheme with balanced colors for good readability.
   *
   * Characteristics:
   *   - Cyan accents for highlights and interactive elements
   *   - Green for success states and diff additions
   *   - Red for errors and diff removals
   *   - Gray for secondary text and metadata
   * </Summary>
   */
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

  /**
   * <Summary>
   * What it does:
   *   An ocean-themed color scheme with cool blues and teals for a calm, aquatic feel.
   *
   * Characteristics:
   *   - Blue and teal accents for a nautical color palette
   *   - Teal for success states
   *   - Salmon for errors (warm contrast to cool background)
   *   - Peach for warnings (soft orange accent)
   * </Summary>
   */
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

  /**
   * <Summary>
   * What it does:
   *   A forest-themed color scheme with greens and natural earth tones.
   *
   * Characteristics:
   *   - Forest green accents for a nature-inspired palette
   *   - Bright green for success states and diff additions
   *   - Salmon for errors (natural contrast to forest greens)
   *   - Yellow for warnings (sunlight accent)
   * </Summary>
   */
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
   * <Summary>
   * What it does:
   *   A monochrome color scheme using only black, white, and grayscale for maximum contrast.
   *
   * Characteristics:
   *   - Pure black and white for high contrast accessibility
   *   - Gray scales for secondary text and metadata
   *   - White for success and errors (monochrome distinction)
   *   - Custom monochrome diff backgrounds for consistency
   * </Summary>
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

  /**
   * <Summary>
   * What it does:
   *   A sunset-themed color scheme with warm oranges, pinks, and magentas.
   *
   * Characteristics:
   *   - Warm orange and peach accents for a sunset color palette
   *   - Peach for success states (warm positive feedback)
   *   - Magenta for errors (strong warm contrast)
   *   - Orange for warnings (sunlight intensity)
   * </Summary>
   */
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

  /**
   * <Summary>
   * What it does:
   *   Import of the VS Code Dark+ theme from vscodeGithubThemes.
   *
   * Characteristics:
   *   - Blue and purple color scheme matching VS Code default
   *   - Teal for success states
   *   - Red for errors
   *   - Orange-peach for warnings
   * </Summary>
   */
  "vscode-dark": vscodeTheme,

  /**
   * <Summary>
   * What it does:
   *   Import of the VS Code Dark Modern theme from vscodeGithubThemes.
   *
   * Characteristics:
   *   - Purple and blue color scheme matching modern VS Code
   *   - Teal for success states
   *   - Coral red for errors
   *   - Orange-peach for warnings
   * </Summary>
   */
  "vscode-modern": vscodeDarkModernTheme,

  /**
   * <Summary>
   * What it does:
   *   Import of the GitHub Dark theme from vscodeGithubThemes.
   *
   * Characteristics:
   *   - Blue accent scheme matching GitHub's dark mode
   *   - Green for success states (GitHub's brand color)
   *   - Red for errors (GitHub's danger color)
   *   - Orange for warnings (GitHub's warning color)
   * </Summary>
   */
  "github-dark": githubDarkTheme,

  /**
   * <Summary>
   * What it does:
   *   Import of the GitHub Dimmed theme from vscodeGithubThemes.
   *
   * Characteristics:
   *   - Muted blue color scheme matching GitHub's dimmed mode
   *   - Green for success states (GitHub's brand color, muted)
   *   - Red-orange for errors (GitHub's danger color, muted)
   *   - Yellow for warnings (GitHub's warning color)
   * </Summary>
   */
  "github-dimmed": githubDimmedTheme,

  /**
   * <Summary>
   * What it does:
   *   Import of the GitHub Light theme from vscodeGithubThemes.
   *
   * Characteristics:
   *   - Blue accent scheme matching GitHub's light mode
   *   - Green for success states (GitHub's brand color)
   *   - Red for errors (GitHub's danger color)
   *   - Brown for warnings (GitHub's warning color)
   *   - Light diff backgrounds for readability
   * </Summary>
   */
  "github-light": githubLightTheme,
};

/**
 * <Summary>
 * What it does:
 *   Provides an array of all available theme keys for display and selection.
 *
 * How it does it (step by step):
 *   1. Extract all keys from the THEMES object.
 *   2. Return the array of theme keys.
 *
 * Returns:
 *   @returns Array of theme key strings (e.g., ["default", "ocean", "forest", "monochrome", "sunset", "vscode-dark", "vscode-modern", "github-dark", "github-dimmed", "github-light"]).
 * </Summary>
 */
export const THEME_KEYS = Object.keys(THEMES);
