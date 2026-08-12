/**
 * Active theme state: load, set, and query LoopyCode CLI color themes.
 *
 * @remarks
 * Themes live in {@link THEMES}. Preferences persist as `config.ui.theme`.
 * On first load, a legacy `~/.agent-cli/theme.txt` may be migrated into config
 * and deleted. Call {@link loadTheme} during startup before printing styled UI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, updateConfig } from "../config/index.js";
import { refreshInkBanner } from "../ui/uiBridge.js";
import { colorDisabled } from "../ui/terminalEnv.js";
import { THEMES, type Theme } from "./themes.js";

/** Config directory used by older CLI builds for standalone files. */
const CONFIG_DIR = path.join(os.homedir(), ".agent-cli");

/**
 * Legacy plain-text theme preference (`theme.txt`) from pre-config-store builds.
 *
 * @remarks
 * {@link migrateLegacyThemeFile} copies a valid key into `config.ui.theme` then
 * removes this file.
 */
const LEGACY_THEME_FILE = path.join(CONFIG_DIR, "theme.txt");

/**
 * Picks a fallback theme when config points at a missing key.
 *
 * @returns `{ theme, key }` preferring `"default"`, else the first registry entry.
 * @throws {@link Error} When {@link THEMES} is empty (`"No themes configured"`).
 */
const resolveDefaultTheme = (): { theme: Theme; key: string } => {
  if (THEMES.default) return { theme: THEMES.default, key: "default" };
  const firstKey = Object.keys(THEMES)[0];
  if (firstKey && THEMES[firstKey]) {
    return { theme: THEMES[firstKey], key: firstKey };
  }
  throw new Error("No themes configured");
};

const defaultTheme = resolveDefaultTheme();

/** Currently applied theme object (ANSI CSI fields). */
let activeTheme: Theme = defaultTheme.theme;

/** Registry key for {@link activeTheme} (e.g. `"ocean"`, `"github-dark"`). */
let activeThemeKey = defaultTheme.key;

/**
 * Theme fields that are ANSI CSI strings (everything except name / shiki id).
 *
 * @remarks
 * Derived from the {@link Theme} shape so a new CSI field cannot be forgotten
 * when NO_COLOR blanks the palette. `name` and `shikiTheme` stay intact —
 * they are not escape sequences.
 */
const CSI_THEME_KEYS = (
  Object.keys(THEMES.monochrome ?? THEMES.default ?? {}) as (keyof Theme)[]
).filter((key) => key !== "name" && key !== "shikiTheme");

/**
 * Returns a copy of `theme` whose CSI fields are all empty strings.
 *
 * @remarks
 * Does **not** mutate the registry or the active theme — callers under
 * `NO_COLOR` get a derived snapshot so unsetting the env restores color.
 *
 * @param theme - Palette to blank.
 * @returns A new {@link Theme} with empty CSI fields.
 */
const colorlessTheme = (theme: Theme): Theme => {
  const blanked: Theme = { ...theme };
  for (const key of CSI_THEME_KEYS) {
    blanked[key] = "" as Theme[typeof key];
  }
  return blanked;
};

/**
 * One-time migration of `~/.agent-cli/theme.txt` into `config.ui.theme`.
 *
 * @remarks
 * No-op when the file is missing. Empty or unknown keys still delete the file
 * when appropriate so we do not remigrate forever. Errors are swallowed —
 * migration must never crash startup.
 */
const migrateLegacyThemeFile = (): void => {
  try {
    if (!fs.existsSync(LEGACY_THEME_FILE)) return;

    const legacyThemeKey = fs.readFileSync(LEGACY_THEME_FILE, "utf8").trim();

    if (legacyThemeKey.length === 0) {
      fs.unlinkSync(LEGACY_THEME_FILE);
      return;
    }

    if (THEMES[legacyThemeKey]) {
      const currentConfig = loadConfig();
      updateConfig({ ui: { ...currentConfig.ui, theme: legacyThemeKey } });
      fs.unlinkSync(LEGACY_THEME_FILE);
    }
  } catch {
    // Non-fatal: bad permissions / race — keep default/config theme.
  }
};

/**
 * Loads `config.ui.theme` (after legacy migration) into the active theme.
 *
 * @remarks
 * Unknown keys fall back via {@link resolveDefaultTheme} so printers always
 * have a valid {@link Theme}.
 *
 * @example
 * ```ts
 * loadTheme();
 * const theme = getTheme();
 * ```
 */
export const loadTheme = (): void => {
  migrateLegacyThemeFile();

  const configuredThemeKey = loadConfig().ui.theme;

  if (THEMES[configuredThemeKey]) {
    activeTheme = THEMES[configuredThemeKey]!;
    activeThemeKey = configuredThemeKey;
  } else {
    const fallback = resolveDefaultTheme();
    activeTheme = fallback.theme;
    activeThemeKey = fallback.key;
  }
};

/**
 * Activates a theme by registry key and persists it to config.
 *
 * @remarks
 * Unknown keys are ignored (no throw). On success, refreshes the Ink banner so
 * the startup box picks up new colors immediately.
 *
 * @param key - Key in {@link THEMES}, e.g. `"default"`, `"github-light"`.
 *
 * @example
 * ```ts
 * setTheme("ocean");
 * setTheme("not-a-theme"); // no-op
 * ```
 */
export const setTheme = (key: string): void => {
  if (!THEMES[key]) return;

  activeTheme = THEMES[key]!;
  activeThemeKey = key;

  const currentConfig = loadConfig();
  updateConfig({ ui: { ...currentConfig.ui, theme: key } });
  refreshInkBanner(loadConfig());
};

/**
 * Returns the active {@link Theme} (ANSI sequences for UI / diffs).
 *
 * @returns Current theme object; never `undefined` after module init.
 *
 * @example
 * ```ts
 * const { error, reset } = getTheme();
 * console.log(`${error}failed${reset}`);
 * ```
 */
export const getTheme = (): Theme =>
  colorDisabled() ? colorlessTheme(activeTheme) : activeTheme;

/**
 * Returns the active theme’s registry key.
 *
 * @returns Key such as `"default"` or `"vscode-modern"`.
 *
 * @example
 * ```ts
 * console.log(getThemeKey()); // "github-dark"
 * ```
 */
export const getThemeKey = (): string => activeThemeKey;
