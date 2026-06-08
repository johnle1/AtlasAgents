// Persisted CLI settings (~/.agent-cli/config.json) and related paths (history, skills).
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * <Summary>
 * What it does:
 *   Defines the structure of the CLI configuration file persisted to disk.
 *
 * How it fits in the system:
 *   Provides type safety for config operations and ensures all required fields are present.
 *
 * Used by:
 *   - Config — uses this as nested ui configuration object.
 *   - loadConfig — returns objects with this shape.
 *   - saveConfig — writes objects with this shape.
 *
 * Produced by:
 *   - DEFAULT_CONFIG — provides default values for these fields.
 * </Summary>
 */
export interface UiConfig {
  /** Key into THEMES — e.g. "default", "ocean", "vscode-dark" */
  theme: string;

  /** Show animated status spinner (default true) */
  showSpinner?: boolean;

  /** Use alternate screen buffer for full-screen UI (default false) */
  useAlternateBuffer?: boolean;
}

/**
 * <Summary>
 * What it does:
 *   Defines the structure of the CLI configuration file persisted to disk.
 *
 * How it fits in the system:
 *   Central config type used throughout the application for type safety and validation.
 *
 * Used by:
 *   - loadConfig — returns objects of this shape from ~/.agent-cli/config.json.
 *   - saveConfig — writes objects of this shape to disk.
 *   - updateConfig — merges partial updates into existing config.
 *   - Connection — reads server URL, password, model names, and temperatures.
 *   - CommandHandler — displays config and updates model selections.
 *
 * Produced by:
 *   - loadConfig — either from disk or DEFAULT_CONFIG on first run.
 * </Summary>
 */
export interface Config {
  /** RSocket TCP host — not an HTTP URL */
  server: string;

  /** RSocket TCP port (7000 is the RSocket convention) */
  port: number;

  /**
   * Shared server password sent on every RSocket frame metadata (JSON: `{ "password": "..." }`).
   * Must match the password the server operator entered at startup (empty allowed).
   */
  password: string;

  /** Ollama model name for the advisor role e.g. "gemma3:27b" */
  advisorModel: string;

  /** Ollama model name for the agent role e.g. "gemma3:4b" */
  agentModel: string;

  /** Sampling temperature for advisor (0.0-1.0), low for deterministic planning */
  advisorTemp: number;

  /** Sampling temperature for agent (0.0-1.0), moderate for creative code generation */
  agentTemp: number;

  /** Maximum retry attempts for failed requests to server */
  retries: number;

  /** Timeout in ms for model responses — prevents CLI hanging on slow models */
  timeout: number;

  /** Percentage of context window memory injection is allowed to consume */
  maxContextBudget: number;

  /** Default directory agents are allowed to read/write; empty until set by user */
  workspace: string;

  /** Print advisor/agent think boxes in the terminal (default off) */
  showThinkOutput: boolean;

  /** Max parallel agent groups when no trigger word (min 1); use ::max for no cap */
  agentCap: number;

  /** Client-only UI preferences (theme, etc.) */
  ui: UiConfig;
}

/**
 * Default configuration applied on first run or when config.json is missing.
 * Values here are chosen for the loopycode use case specifically —
 * see comments on each field for reasoning.
 */
// Template used when the file is missing and as the base layer when merging disk JSON.
const DEFAULT_CONFIG: Config = {
  // RSocket TCP connection — not HTTP
  server: "localhost",
  port: 7000,

  // Set on first run, /set password, or editing config.json
  password: "",

  // Model names (empty until set by user or first-run prompts)
  advisorModel: "",
  agentModel: "",

  // Low for advisor (deterministic planning), moderate for agents (creative code)
  advisorTemp: 0.1,
  agentTemp: 0.4,

  // Standard retry count — 3 attempts before escalating or failing
  retries: 3,

  // Prevents CLI hanging on slow or unresponsive models (10 minutes)
  timeout: 600_000,

  // Caps how much of the context window memory injection can consume (20%)
  maxContextBudget: 0.2,

  // Empty until set via `/workspace set <path>` or editing config.json
  workspace: "",

  // Disable think output by default (shows advisor/agent think boxes when true)
  showThinkOutput: false,

  // Allow 3 parallel agent groups by default (minimum 1)
  agentCap: 3,

  // Default UI preferences
  ui: { theme: "default", showSpinner: true, useAlternateBuffer: false },
};

/** e.g. ~/.agent-cli — config, .history, and skills/ live here. */
const CONFIG_DIR = path.join(os.homedir(), ".agent-cli");

/** Full path to the JSON file Connection and /config read from. */
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/**
 * <Summary>
 * What it does:
 *   Checks whether the config.json file already exists on disk.
 *
 * How it does it (step by step):
 *   1. Calls fs.existsSync to check if CONFIG_FILE exists.
 *   2. Returns true if file exists, false otherwise.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {boolean} — true if config.json exists, false otherwise.
 *
 * Dependencies:
 *   - fs.existsSync — checks file existence.
 *
 * Dependants:
 *   - index.ts — uses this before loadConfig to avoid creating file on first run.
 * </Summary>
 */
export const hasConfigFile = (): boolean => fs.existsSync(CONFIG_FILE);

/**
 * <Summary>
 * What it does:
 *   Creates a deep copy of the default configuration for first-run setup.
 *
 * How it does it (step by step):
 *   1. Spreads DEFAULT_CONFIG to create a shallow copy.
 *   2. Spreads DEFAULT_CONFIG.ui to create a separate copy of the ui object.
 *   3. Returns the complete copy with nested objects properly separated.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Config} — A deep copy of the default configuration object.
 *
 * Dependencies:
 *   - None (object spreading only).
 *
 * Dependants:
 *   - index.ts — uses this for first-run config merging.
 * </Summary>
 */
export const getDefaultConfig = (): Config => ({
  // Create a shallow copy of DEFAULT_CONFIG
  ...DEFAULT_CONFIG,
  // Create a separate copy of the ui object to avoid shared references
  ui: { ...DEFAULT_CONFIG.ui },
});

/**
 * Path to the readline history file for arrow-key command recall.
 * Exported so index.ts can load and save history on startup/shutdown.
 */
export const HISTORY_FILE = path.join(CONFIG_DIR, ".history");

/**
 * Directory where user-created skill markdown files are stored.
 * Exported so skills.ts can read from and write to this directory.
 */
export const SKILLS_DIR = path.join(CONFIG_DIR, "skills");

/**
 * <Summary>
 * What it does:
 *   Creates ~/.agent-cli/ if it does not exist yet (config and history live here).
 *
 * How it does it (step by step):
 *   1. Calls fs.mkdirSync with recursive: true to create CONFIG_DIR and parents.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - fs.mkdirSync — Node.js filesystem API.
 *
 * Dependants:
 *   - loadConfig — calls this before reading config.json.
 *   - saveConfig — calls this before writing config.json.
 *   - index.ts saveHistory — ensures HISTORY_FILE parent exists.
 *   - skills.ts ensureSkillsDir — uses CONFIG_DIR parent; skills dir is separate.
 * </Summary>
 */
export const ensureDirs = (): void => {
  // Create CONFIG_DIR with recursive: true to create parent directories if needed
  // No error if directory already exists
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
};

/**
 * <Summary>
 * What it does:
 *   Merges parsed config from disk with DEFAULT_CONFIG to fill missing keys.
 *
 * How it does it (step by step):
 *   1. Spreads DEFAULT_CONFIG as the base layer.
 *   2. Spreads parsed config on top to override defaults.
 *   3. Validates showThinkOutput is boolean, otherwise use default.
 *   4. Validates agentCap is positive integer, otherwise use default.
 *   5. Merges ui objects with defaults as base.
 *
 * Parameters:
 *   @param {Partial<Config>} parsedConfig — Config object parsed from config.json.
 *
 * Returns:
 *   @returns {Config} — The merged configuration with all required fields.
 *
 * Dependencies:
 *   - None (object spreading and type validation only).
 *
 * Dependants:
 *   - loadConfig — merges disk config with defaults.
 * </Summary>
 */
const mergeConfigFromDisk = (parsedConfig: Partial<Config>): Config => ({
  // Start with DEFAULT_CONFIG as the base
  ...DEFAULT_CONFIG,
  // Override with parsed config values
  ...parsedConfig,
  // Validate showThinkOutput is boolean, otherwise use default
  showThinkOutput:
    typeof parsedConfig.showThinkOutput === "boolean"
      ? parsedConfig.showThinkOutput
      : DEFAULT_CONFIG.showThinkOutput,
  // Validate agentCap is positive integer, otherwise use default
  agentCap:
    typeof parsedConfig.agentCap === "number" &&
    Number.isInteger(parsedConfig.agentCap) &&
    parsedConfig.agentCap >= 1
      ? parsedConfig.agentCap
      : DEFAULT_CONFIG.agentCap,
  // Merge ui objects with defaults as base
  ui: { ...DEFAULT_CONFIG.ui, ...parsedConfig.ui },
});

/**
 * <Summary>
 * What it does:
 *   Determines whether the config needs to be persisted back to disk.
 *
 * How it does it (step by step):
 *   1. Checks if any DEFAULT_CONFIG keys are missing from stored config.
 *   2. Checks if nested ui object is missing any keys.
 *   3. Validates agentCap is a positive integer.
 *   4. Validates showThinkOutput is a boolean.
 *   5. Returns true if any corrections are needed, false otherwise.
 *
 * Parameters:
 *   @param {Record<string, unknown>} storedConfig — Raw config object read from disk.
 *   @param {Partial<Config>} parsedConfig — Parsed config with type information.
 *
 * Returns:
 *   @returns {boolean} — true if config should be persisted, false otherwise.
 *
 * Dependencies:
 *   - None (comparison logic only).
 *
 * Dependants:
 *   - loadConfig — checks if merged config needs to be written back to disk.
 * </Summary>
 */
const configNeedsPersist = (
  storedConfig: Record<string, unknown>,
  parsedConfig: Partial<Config>,
): boolean => {
  // Check if any default keys are missing from stored config
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key === "ui") {
      if (typeof storedConfig.ui !== "object" || storedConfig.ui === null) {
        return true;
      }
      const uiObject = storedConfig.ui as Record<string, unknown>;
      // Check if nested ui keys are missing
      for (const uiKey of Object.keys(DEFAULT_CONFIG.ui)) {
        if (!(uiKey in uiObject)) {
          return true;
        }
      }
      continue;
    }
    if (!(key in storedConfig)) {
      return true;
    }
  }
  // Validate agentCap is a positive integer
  if (
    parsedConfig.agentCap !== undefined &&
    (typeof parsedConfig.agentCap !== "number" ||
      !Number.isInteger(parsedConfig.agentCap) ||
      parsedConfig.agentCap < 1)
  ) {
    return true;
  }
  // Validate showThinkOutput is a boolean
  if (
    parsedConfig.showThinkOutput !== undefined &&
    typeof parsedConfig.showThinkOutput !== "boolean"
  ) {
    return true;
  }
  return false;
};

/**
 * <Summary>
 * What it does:
 *   Loads the CLI configuration from ~/.agent-cli/config.json or returns
 *   the default config if the file doesn't exist or is corrupted.
 *
 * How it does it (step by step):
 *   1. Ensures ~/.agent-cli/ directory exists.
 *   2. Checks if config.json exists — if not, writes DEFAULT_CONFIG and returns it.
 *   3. Reads config.json as UTF-8 text.
 *   4. Parses JSON and merges with DEFAULT_CONFIG (fills missing keys).
 *   5. Checks if merged config needs to be persisted back to disk.
 *   6. Returns the merged config object.
 *   7. On any error (read failure, JSON parse failure), returns DEFAULT_CONFIG.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Config} — The loaded or default configuration object.
 *
 * Dependencies:
 *   - ensureDirs — creates directories before reading.
 *   - fs.existsSync — checks if config.json exists.
 *   - fs.readFileSync — reads config.json from disk.
 *   - saveConfig — writes default config on first run.
 *   - mergeConfigFromDisk — merges disk config with defaults.
 *   - configNeedsPersist — checks if config needs to be written back.
 *
 * Dependants:
 *   - index.ts main() — loads config on CLI startup.
 *   - updateConfig — loads existing config before merging changes.
 *   - CommandHandler.handleConfig — displays current config to user.
 *   - getConfig — reads current config for single field access.
 *   - setConfig — reads current config for single field update.
 * </Summary>
 */
export const loadConfig = (): Config => {
  ensureDirs();
  if (!fs.existsSync(CONFIG_FILE)) {
    // No file yet: write defaults so the path always has a valid JSON, then return them.
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui } };
  }
  try {
    const rawConfigString = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsedConfig = JSON.parse(rawConfigString) as Partial<Config>;
    const mergedConfig = mergeConfigFromDisk(parsedConfig);
    if (
      configNeedsPersist(parsedConfig as Record<string, unknown>, parsedConfig)
    ) {
      saveConfig(mergedConfig);
    }
    return mergedConfig;
  } catch {
    // Bad JSON or unreadable file — fail soft so the CLI can still start.
    return { ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui } };
  }
};

/**
 * <Summary>
 * What it does:
 *   Persists a Config object to ~/.agent-cli/config.json as formatted JSON.
 *
 * How it does it (step by step):
 *   1. Ensures ~/.agent-cli/ directory exists.
 *   2. Stringifies the config object with 2-space indentation.
 *   3. Writes the JSON string to config.json, replacing any existing file.
 *
 * Parameters:
 *   @param {Config} config — The configuration object to save to disk.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - ensureDirs — ensures CONFIG_DIR exists before writing.
 *   - fs.writeFileSync — writes JSON to disk.
 *
 * Dependants:
 *   - loadConfig — saves DEFAULT_CONFIG on first run.
 *   - updateConfig — saves merged config after user changes a setting.
 * </Summary>
 */
export const saveConfig = (config: Config): void => {
  // Ensure the config directory exists before writing
  ensureDirs();
  // Write config as formatted JSON with 2-space indent for readability
  fs.writeFileSync(
    CONFIG_FILE,
    // null, 2 → pretty-print with 2-space indent (easier for users to edit by hand).
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
};

/**
 * <Summary>
 * What it does:
 *   Updates specific fields in the config file without overwriting other fields,
 *   then saves the result to disk and returns the updated config.
 *
 * How it does it (step by step):
 *   1. Loads the current config from disk.
 *   2. Merges the patch object into the loaded config using Object.assign.
 *   3. Saves the merged config back to disk.
 *   4. Returns the updated config.
 *
 * Parameters:
 *   @param {Partial<Config>} patch — Fields to update (e.g. { advisorModel: "gemma3:27b" }).
 *
 * Returns:
 *   @returns {Config} — The updated configuration after merging and saving.
 *
 * Dependencies:
 *   - loadConfig — reads current config from disk.
 *   - saveConfig — writes updated config back to disk.
 *
 * Dependants:
 *   - CommandHandler.handleSet — updates advisorModel or agentModel after user picks.
 * </Summary>
 */
export const updateConfig = (patch: Partial<Config>): Config => {
  // Load the current full config from disk (merged with defaults)
  const currentConfig = loadConfig();
  // Shallow merge: only keys in `patch` will change, others remain as-is
  Object.assign(currentConfig, patch);
  // Save the updated config back to disk
  saveConfig(currentConfig);
  // Return the updated config
  return currentConfig;
};

/**
 * <Summary>
 * What it does:
 *   Reads a single field from the merged on-disk config using the same
 *   merge rules as loadConfig (DEFAULT_CONFIG spread under disk values).
 *
 * How it does it (step by step):
 *   1. Calls loadConfig to get the full merged config object.
 *   2. Returns the value at the requested key.
 *
 * Parameters:
 *   @param {K} key — A key of the Config interface e.g. "server", "advisorModel".
 *
 * Returns:
 *   @returns {Config[K]} — The value for that key, typed to match the field.
 *
 * Dependencies:
 *   - loadConfig — reads and merges config from disk.
 *
 * Dependants:
 *   None (utility accessor, available for any caller that needs one field).
 * </Summary>
 */
export const getConfig = <K extends keyof Config>(key: K): Config[K] => {
  // Load the full config and return the value at the requested key
  // Note: re-reads file each call — acceptable for rare single-field lookups
  return loadConfig()[key];
};

/**
 * <Summary>
 * What it does:
 *   Updates exactly one config field, saves immediately to disk, and returns
 *   the full updated config object.
 *
 * How it does it (step by step):
 *   1. Loads the current config from disk via loadConfig.
 *   2. Merges the single key-value pair into the loaded object.
 *   3. Saves the merged config back to disk via saveConfig.
 *   4. Returns the updated config.
 *
 * Parameters:
 *   @param {K} key — The config field to update.
 *   @param {Config[K]} value — The new value for that field.
 *
 * Returns:
 *   @returns {Config} — The full updated configuration after saving.
 *
 * Dependencies:
 *   - loadConfig — reads current config from disk.
 *   - saveConfig — writes updated config back to disk.
 *
 * Dependants:
 *   None (utility accessor, available for any caller that needs to set one field).
 * </Summary>
 */
export const setConfig = <K extends keyof Config>(
  key: K,
  value: Config[K],
): Config => {
  // Load the current config from disk
  const currentConfig = loadConfig();
  // Update only the specified field using single-field update
  Object.assign(currentConfig, { [key]: value } as Partial<Config>);
  // Save the updated config back to disk
  saveConfig(currentConfig);
  // Return the updated config
  return currentConfig;
};
