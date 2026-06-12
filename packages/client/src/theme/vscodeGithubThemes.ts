import type { Theme } from "./themes.js";
import { fg } from "./ansi256.js";

/**
 * <Summary>
 * What it does:
 *   Provides common ANSI escape sequences for text formatting.
 *
 * Used by:
 *   - All theme objects in this file — use these for consistent formatting.
 *
 * Produced by:
 *   - None (static constants defined at module level).
 * </Summary>
 */
const dim = "\x1b[2m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";

/**
 * <Summary>
 * What it does:
 *   Provides ANSI escape sequences for diff background colors in dark themes.
 *
 * Used by:
 *   - Dark themes (vscodeTheme, vscodeDarkModernTheme, githubDarkTheme, githubDimmedTheme) —
 *     use these for diff background colors.
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
 *   Provides ANSI escape sequences for diff background colors in light themes.
 *
 * Used by:
 *   - Light themes (githubLightTheme) — use these for diff background colors.
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
 *   Provides the VS Code Dark+ theme matching the default VS Code color scheme.
 *
 * Characteristics:
 *   - Blue and purple color scheme for primary accents
 *   - Teal for success states
 *   - Red for errors
 *   - Orange-peach for warnings
 *   - Uses dark-plus Shiki theme for syntax highlighting
 *
 * How it fits in the system:
 *   Replicates the VS Code Dark+ theme for consistency with the popular editor.
 *
 * Dependencies:
 *   - fg — converts hex colors to terminal escape sequences.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Provides the VS Code Dark Modern theme with purple accents.
 *
 * Characteristics:
 *   - Purple color scheme for a modern aesthetic
 *   - Blue and teal for accents
 *   - Teal for success states
 *   - Coral red for errors
 *   - Orange-peach for warnings
 *   - Uses dark-plus Shiki theme for syntax highlighting
 *
 * How it fits in the system:
 *   Provides a modern purple variant of the VS Code theme for users who prefer
 *   a different color scheme than the classic blue/purple.
 *
 * Dependencies:
 *   - fg — converts hex colors to terminal escape sequences.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Provides the GitHub Dark theme matching GitHub's dark mode color scheme.
 *
 * Characteristics:
 *   - Blue accent scheme matching GitHub's dark mode
 *   - Green for success states (GitHub's brand color)
 *   - Red for errors (GitHub's danger color)
 *   - Orange for warnings (GitHub's warning color)
 *   - Uses github-dark Shiki theme for syntax highlighting
 *
 * How it fits in the system:
 *   Replicates the GitHub Dark theme for consistency with the popular code hosting platform,
 *   making the CLI feel familiar to GitHub users.
 *
 * Dependencies:
 *   - fg — converts hex colors to terminal escape sequences.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Provides the GitHub Dimmed theme matching GitHub's dimmed mode color scheme.
 *
 * Characteristics:
 *   - Muted blue accent scheme matching GitHub's dimmed mode
 *   - Green for success states (GitHub's brand color, muted)
 *   - Red-orange for errors (GitHub's danger color, muted)
 *   - Yellow for warnings (GitHub's warning color)
 *   - Uses github-dark-dimmed Shiki theme for syntax highlighting
 *
 * How it fits in the system:
 *   Replicates the GitHub Dimmed theme for users who prefer GitHub's softer, less saturated
 *   color scheme while maintaining the familiar GitHub aesthetic.
 *
 * Dependencies:
 *   - fg — converts hex colors to terminal escape sequences.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Provides the GitHub Light theme matching GitHub's light mode color scheme.
 *
 * Characteristics:
 *   - Blue accent scheme matching GitHub's light mode
 *   - Green for success states (GitHub's brand color)
 *   - Red for errors (GitHub's danger color)
 *   - Brown for warnings (GitHub's warning color in light mode)
 *   - Uses github-light Shiki theme for syntax highlighting
 *   - Light diff backgrounds for readability in light terminal environments
 *
 * How it fits in the system:
 *   Replicates the GitHub Light theme for users who prefer light mode or work in
 *   light terminal environments, maintaining GitHub's familiar aesthetic.
 *
 * Dependencies:
 *   - fg — converts hex colors to terminal escape sequences.
 * </Summary>
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
