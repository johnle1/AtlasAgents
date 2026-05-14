// Persisted CLI settings (~/.agent-cli/config.json) and related paths (history, skills).
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * <Summary>
 * What it does:
 *   Defines the structure of the CLI configuration file persisted to disk.
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

  // Sensible defaults so first run works without manual setup
  advisorModel: "gemma3:27b",
  agentModel: "gemma3:4b",

  // Low for advisor (deterministic planning), moderate for agents (creative code)
  advisorTemp: 0.1,
  agentTemp: 0.4,

  // Standard retry count — 3 attempts before escalating or failing
  retries: 3,

  // Prevents CLI hanging on slow or unresponsive models
  timeout: 120_000,

  // Caps how much of the context window memory injection can consume
  maxContextBudget: 0.2,

  // Empty until set via `/workspace set <path>` or editing config.json
  workspace: "",
};

/** e.g. ~/.agent-cli — config, .history, and skills/ live here. */
const CONFIG_DIR = path.join(os.homedir(), ".agent-cli");

/** Full path to the JSON file Connection and /config read from. */
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/**
 * Whether `config.json` is already on disk.
 * `index.ts` uses this before `loadConfig()`: otherwise `loadConfig` would create the file
 * and the first-run prompts would never run.
 */
export const hasConfigFile = (): boolean => fs.existsSync(CONFIG_FILE);

/** Deep-safe copy of defaults for first-run `saveConfig({ ...defaults, ...answers })`. */
export const getDefaultConfig = (): Config => ({ ...DEFAULT_CONFIG });

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
  // recursive: true — no error if ~/.agent-cli already exists
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
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
 *   5. Returns the merged config object.
 *   6. On any error (read failure, JSON parse failure), returns DEFAULT_CONFIG.
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
 *
 * Dependants:
 *   - index.ts main() — loads config on CLI startup.
 *   - updateConfig — loads existing config before merging changes.
 *   - CommandHandler.handleConfig — displays current config to user.
 * </Summary>
 */
export const loadConfig = (): Config => {
  ensureDirs();
  if (!fs.existsSync(CONFIG_FILE)) {
    // No file yet: write defaults so the path always has a valid JSON, then return them.
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    // Merge: start from defaults, then overlay keys from disk. Later spread wins on conflicts.
    // `as Config` tells TypeScript the shape; it does not validate JSON at runtime.
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as Config;
  } catch {
    // Bad JSON or unreadable file — fail soft so the CLI can still start.
    return { ...DEFAULT_CONFIG };
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
  ensureDirs();
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
  const config = loadConfig(); // full merged object from disk + defaults
  Object.assign(config, patch); // shallow merge: only keys in `patch` change
  saveConfig(config);
  return config;
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
  return loadConfig()[key]; // re-reads file each call — fine for rare lookups
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
  const config = loadConfig();
  Object.assign(config, { [key]: value } as Partial<Config>); // single-field update
  saveConfig(config);
  return config;
};
