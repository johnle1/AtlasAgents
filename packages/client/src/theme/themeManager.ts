import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, updateConfig } from "../config.js";
import { refreshInkBanner } from "../ui/uiBridge.js";
import { THEMES, type Theme } from "./themes.js";

/**
 * <Summary>
 * What it does:
 *   The configuration directory path for storing application settings.
 *
 * Used by:
 *   - migrateLegacyThemeFile — accesses the legacy theme file in this directory.
 *
 * Produced by:
 *   - None (constant computed from home directory).
 * </Summary>
 */
const CONFIG_DIR = path.join(os.homedir(), ".agent-cli");

/**
 * <Summary>
 * What it does:
 *   The legacy theme file path from older versions of the application.
 *
 * Used by:
 *   - migrateLegacyThemeFile — reads and deletes this file during migration.
 *
 * Produced by:
 *   - None (constant computed from config directory).
 * </Summary>
 */
const LEGACY_THEME_FILE = path.join(CONFIG_DIR, "theme.txt");

const resolveDefaultTheme = (): { theme: Theme; key: string } => {
  if (THEMES.default) return { theme: THEMES.default, key: "default" };
  const firstKey = Object.keys(THEMES)[0];
  if (firstKey && THEMES[firstKey]) {
    return { theme: THEMES[firstKey], key: firstKey };
  }
  throw new Error("No themes configured");
};

const defaultTheme = resolveDefaultTheme();

/**
 * <Summary>
 * What it does:
 *   The currently active theme object that provides color codes for terminal output.
 *
 * Used by:
 *   - getTheme — returns the active theme object.
 *
 * Produced by:
 *   - loadTheme — sets the active theme based on configuration.
 *   - setTheme — updates the active theme when changed.
 * </Summary>
 */
let activeTheme: Theme = defaultTheme.theme;

/**
 * <Summary>
 * What it does:
 *   The key identifier of the currently active theme.
 *
 * Used by:
 *   - getThemeKey — returns the active theme key.
 *
 * Produced by:
 *   - loadTheme — sets the active theme key based on configuration.
 *   - setTheme — updates the active theme key when changed.
 * </Summary>
 */
let activeThemeKey = defaultTheme.key;

/**
 * <Summary>
 * What it does:
 *   Migrates the legacy theme file to the new configuration format.
 *
 * How it does it (step by step):
 *   1. Check if the legacy theme file exists.
 *   2. If it doesn't exist, return early (nothing to migrate).
 *   3. Read the theme key from the legacy file.
 *   4. Check if the theme key exists in the current THEMES object.
 *   5. If valid, update the configuration to use the theme.
 *   6. Delete the legacy file after successful migration.
 *   7. If any error occurs, silently ignore (migration is non-fatal).
 *
 * Returns:
 *   @returns Returns after migration or if migration is not needed/possible.
 * </Summary>
 */
const migrateLegacyThemeFile = (): void => {
  try {
    // ===== STEP 1: Check if legacy file exists =====
    // Step 1a: Check if the legacy theme file exists in the config directory
    // Step 1b: If it doesn't exist, return early as there's nothing to migrate
    if (!fs.existsSync(LEGACY_THEME_FILE)) return;

    // ===== STEP 2: Read legacy theme key =====
    // Step 2a: Read the theme key from the legacy theme file
    // Step 2b: Trim whitespace to ensure clean theme key
    const legacyThemeKey = fs.readFileSync(LEGACY_THEME_FILE, "utf8").trim();

    // ===== STEP 3: Validate theme key =====
    // Step 3a: Check if the legacy theme key exists in the current THEMES object
    // Step 3b: This ensures we don't migrate invalid or deprecated theme keys
    if (legacyThemeKey.length === 0) {
      fs.unlinkSync(LEGACY_THEME_FILE);
      return;
    }

    if (THEMES[legacyThemeKey]) {
      // ===== STEP 4: Update configuration =====
      // Step 4a: Load the current configuration
      const currentConfig = loadConfig();

      // Step 4b: Update the configuration with the migrated theme key
      // Step 4c: This moves the theme preference from legacy file to proper config
      updateConfig({ ui: { ...currentConfig.ui, theme: legacyThemeKey } });
      fs.unlinkSync(LEGACY_THEME_FILE);
    }
  } catch {
    // ===== STEP 6: Handle errors =====
    // Step 6a: If any error occurs during migration, silently ignore it
    // Step 6b: Migration is non-fatal - the application should still work with defaults
    // Step 6c: Empty catch block prevents the migration error from breaking the application
  }
};

/**
 * <Summary>
 * What it does:
 *   Loads the theme from configuration and sets it as the active theme.
 *
 * How it does it (step by step):
 *   1. Migrate any legacy theme file to the new format.
 *   2. Load the configuration to get the user's theme preference.
 *   3. Check if the configured theme key exists in the THEMES object.
 *   4. If valid, set the active theme and key from configuration.
 *   5. If invalid, fall back to the default theme.
 *
 * Returns:
 *   @returns Returns after setting the active theme.
 * </Summary>
 */
export const loadTheme = (): void => {
  // ===== STEP 1: Migrate legacy settings =====
  // Step 1a: Ensure any legacy theme file is migrated to the new configuration format
  migrateLegacyThemeFile();

  // ===== STEP 2: Get theme preference from config =====
  // Step 2a: Load the current configuration
  // Step 2b: Extract the theme key from the ui.theme configuration
  const configuredThemeKey = loadConfig().ui.theme;

  // ===== STEP 3: Validate and set theme =====
  // Step 3a: Check if the configured theme key exists in the THEMES object
  if (THEMES[configuredThemeKey]) {
    // Step 3b: If valid, set the active theme and key from configuration
    activeTheme = THEMES[configuredThemeKey]!;
    activeThemeKey = configuredThemeKey;
  } else {
    const fallback = resolveDefaultTheme();
    activeTheme = fallback.theme;
    activeThemeKey = fallback.key;
  }
};

/**
 * <Summary>
 * What it does:
 *   Changes the active theme and updates the configuration to persist the change.
 *
 * How it does it (step by step):
 *   1. Check if the requested theme key exists in the THEMES object.
 *   2. If invalid, return early without making changes.
 *   3. Set the active theme and key to the requested theme.
 *   4. Load the current configuration.
 *   5. Update the configuration with the new theme key.
 *
 * Parameters:
 *   @param key - The theme key to activate (e.g., "default", "ocean", "github-dark").
 *
 * Returns:
 *   @returns Returns after changing the theme and updating configuration.
 * </Summary>
 */
export const setTheme = (key: string): void => {
  // ===== STEP 1: Validate theme key =====
  // Step 1a: Check if the requested theme key exists in the THEMES object
  // Step 1b: This prevents setting invalid theme keys that would break the UI
  if (!THEMES[key]) return;

  // ===== STEP 2: Update active theme =====
  // Step 2a: Set the active theme object to the requested theme
  activeTheme = THEMES[key]!;

  // Step 2b: Set the active theme key to the requested key
  activeThemeKey = key;

  // ===== STEP 3: Persist to configuration =====
  // Step 3a: Load the current configuration
  const currentConfig = loadConfig();

  // Step 3b: Update the configuration with the new theme key
  // Step 3c: This persists the theme preference for future application launches
  updateConfig({ ui: { ...currentConfig.ui, theme: key } });
  refreshInkBanner(loadConfig());
};

/**
 * <Summary>
 * What it does:
 *   Returns the currently active theme object containing all color codes.
 *
 * How it does it (step by step):
 *   1. Return the activeTheme variable containing the theme object.
 *
 * Returns:
 *   @returns The active theme object with color codes for all UI elements.
 * </Summary>
 */
export const getTheme = (): Theme => activeTheme;

/**
 * <Summary>
 * What it does:
 *   Returns the key identifier of the currently active theme.
 *
 * How it does it (step by step):
 *   1. Return the activeThemeKey variable containing the theme key.
 *
 * Returns:
 *   @returns The key identifier of the active theme (e.g., "default", "ocean", "github-dark").
 * </Summary>
 */
export const getThemeKey = (): string => activeThemeKey;
