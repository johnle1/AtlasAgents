// Persisted CLI settings (~/.agent-cli/config.json) and related paths (history, skills).
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * UI configuration preferences persisted to disk.
 *
 * @remarks
 * This interface defines the user interface settings that are stored in the
 * config file. These preferences control the visual appearance and behavior
 * of the CLI, such as color themes and display options.
 *
 * @example
 * const uiConfig: UiConfig = {
 *   theme: "ocean",
 *   showSpinner: true,
 *   useAlternateBuffer: false
 * };
 */
export interface UiConfig {
  /**
   * Theme key that maps to a color scheme in the theme registry.
   *
   * @remarks
   * Common values include "default", "ocean", and "vscode-dark". The theme
   * affects how text and UI elements are colored in the terminal.
   */
  theme: string;

  /**
   * Whether to show an animated status spinner during long-running operations.
   *
   * @remarks
   * When true, a spinner animation displays to indicate that the CLI is
   * processing. When false, operations complete without visual feedback.
   * Defaults to true.
   */
  showSpinner?: boolean;

  /**
   * Whether to use the alternate screen buffer for full-screen UI.
   *
   * @remarks
   * When true, the CLI uses the alternate screen buffer (like `less` or `vim`),
   * which clears the terminal and restores it on exit. When false, output is
   * inline with previous terminal content. Defaults to false.
   */
  useAlternateBuffer?: boolean;
}

/**
 * Complete CLI configuration persisted to ~/.agent-cli/config.json.
 *
 * @remarks
 * This interface defines all configuration values for the LoopyCode client,
 * including server connection settings, model parameters, timeouts, and UI
 * preferences. The config is loaded on startup and can be modified via CLI
 * commands or by editing the JSON file directly.
 *
 * @example
 * const config: Config = {
 *   server: "localhost",
 *   port: 7000,
 *   password: "secret",
 *   subagentModel: "gemma3:27b",
 *   subsubagentModel: "gemma3:4b",
 *   agentTemp: 0.1,
 *   subagentTemp: 0.4,
 *   retries: 3,
 *   timeout: 600000,
 *   shellTimeoutMs: 120000,
 *   maxContextBudget: 0.2,
 *   workspace: "/home/user/projects",
 *   showThinkOutput: false,
 *   subagentCap: 3,
 *   ui: { theme: "default", showSpinner: true, useAlternateBuffer: false }
 * };
 */
export interface Config {
  /**
   * RSocket TCP server hostname or IP address.
   *
   * @remarks
   * This is the TCP host for the RSocket connection, not an HTTP URL.
   * Common values are "localhost" for local development or specific
   * hostnames/IPs for remote servers.
   */
  server: string;

  /**
   * RSocket TCP server port number.
   *
   * @remarks
   * Port 7000 is the conventional default for RSocket servers. The port
   * must match the port the server is configured to listen on.
   */
  port: number;

  /**
   * Shared server password for authentication.
   *
   * @remarks
   * This password is sent on every RSocket frame as metadata in the format
   * `{ "password": "..." }`. The password must match the password the server
   * operator set at server startup. An empty string is allowed for unsecured
   * development environments.
   */
  password: string;

  /**
   * Ollama model name for the agent role.
   *
   * @remarks
   * The agent handles planning and coordination tasks. Use larger models
   * for better reasoning. Example values: "gemma3:27b", "llama3:70b".
   * Empty until set by user or first-run prompts.
   */
  subagentModel: string;

  /**
   * Ollama model name for the subagent role.
   *
   * @remarks
   * Subagents handle code generation and execution tasks. Smaller models are
   * typically sufficient for faster response times. Example values: "gemma3:4b",
   * "llama3:8b". Empty until set by user or first-run prompts.
   */
  subsubagentModel: string;

  /**
   * Provider serving the agent role.
   *
   * @remarks
   * `"ollama"` (the default) talks to the local Ollama instance. Any other
   * value must match a provider added on the server via `/providers add` —
   * e.g. a vLLM server on a GPU box, AWS Trainium, or Google TPU.
   */
  agentProvider: string;

  /**
   * Provider serving the subagent role. Same rules as {@link agentProvider}.
   */
  subagentProvider: string;

  /**
   * Sampling temperature for the subsubagent model (0.0-1.0).
   *
   * @remarks
   * Lower values (e.g., 0.1) produce more deterministic output suitable for
   * planning and coordination. Higher values produce more varied output.
   * Range is 0.0 to 1.0.
   */
  agentTemp: number;

  /**
   * Sampling temperature for the subsubsubagent model (0.0-1.0).
   *
   * @remarks
   * Moderate values (e.g., 0.4) balance creativity with reliability for code
   * generation tasks. Lower values are more deterministic, higher values more
   * creative. Range is 0.0 to 1.0.
   */
  subagentTemp: number;

  /**
   * Maximum number of retry attempts for failed server requests.
   *
   * @remarks
   * When a request to the server fails (network error, timeout, etc.), the client
   * will retry up to this many times before giving up. Default is 3 retries.
   */
  retries: number;

  /**
   * Timeout in milliseconds for model responses.
   *
   * @remarks
   * This prevents the CLI from hanging indefinitely on slow or unresponsive models.
   * Default is 600000ms (10 minutes). Adjust based on your model's typical response time.
   */
  timeout: number;

  /**
   * Timeout in milliseconds for shell commands executed via the file proxy.
   *
   * @remarks
   * Shell commands initiated by the server through the file proxy will be killed
   * after this duration. Default is 120000ms (2 minutes). Increase for long-running
   * operations, decrease for faster failure detection.
   */
  shellTimeoutMs: number;

  /**
   * Maximum percentage of context window that memory injection can consume.
   *
   * @remarks
   * Memory injection adds context from previous operations to the current prompt.
   * This value caps how much of the model's context window can be used for injected
   * memory. Value is a percentage (0.0 to 1.0). Default is 0.2 (20%).
   */
  maxContextBudget: number;

  /**
   * Default workspace directory for file operations.
   *
   * @remarks
   * This is the security boundary — agents can only read/write files within this
   * directory and its subdirectories. Empty string until set by user via
   * `/workspace set <path>` or by editing config.json.
   */
  workspace: string;

  /**
   * Whether to display agent and subagent "think" boxes in the terminal.
   *
   * @remarks
   * When true, the CLI shows the internal reasoning process of the agent and
   * subsubsubagent models. When false, only the final output is displayed. Default is false
   * to reduce noise in the terminal.
   */
  showThinkOutput: boolean;

  /**
   * Maximum number of parallel agent groups when no trigger word is used.
   *
   * @remarks
   * This caps concurrent subagent execution to prevent resource exhaustion. Minimum
   * value is 1. Use `::max` as a special value to indicate no cap. Default is 3.
   */
  subagentCap: number;

  /**
   * Client-side UI preferences.
   *
   * @remarks
   * Contains theme, spinner, and display settings that affect how the CLI
   * renders in the terminal. These are client-only preferences and don't affect
   * server behavior.
   */
  ui: UiConfig;
}

/**
 * Default configuration applied on first run or when config.json is missing.
 *
 * @remarks
 * These values are chosen for the loopycode use case specifically. They serve
 * as the template when the config file is missing and as the base layer when
 * merging disk JSON with DEFAULT_CONFIG.
 */
const DEFAULT_CONFIG: Config = {
  // RSocket TCP connection — not HTTP
  server: "localhost",
  port: 7000,

  // Set on first run, /set password, or editing config.json
  password: "",

  // Model names (empty until set by user or first-run prompts)
  subagentModel: "",
  subsubagentModel: "",

  // Native Ollama by default; switched via /providers + /set agent|subagent
  agentProvider: "ollama",
  subagentProvider: "ollama",

  // Low for agent (deterministic planning), moderate for subagents (creative code)
  agentTemp: 0.1,
  subagentTemp: 0.4,

  // Standard retry count — 3 attempts before escalating or failing
  retries: 3,

  // Prevents CLI hanging on slow or unresponsive models (10 minutes)
  timeout: 600_000,

  // Kill shell commands after 2 minutes by default (npm create/install often need longer)
  shellTimeoutMs: 120_000,

  // Caps how much of the context window memory injection can consume (20%)
  maxContextBudget: 0.2,

  // Empty until set via `/workspace set <path>` or editing config.json
  workspace: "",

  // Disable think output by default (shows agent/subagent think boxes when true)
  showThinkOutput: false,

  // Allow 3 parallel subagent groups by default (minimum 1)
  subagentCap: 3,

  // Default UI preferences
  ui: { theme: "default", showSpinner: true, useAlternateBuffer: false },
};

/** Config directory path (~/.agent-cli) where config, history, and skills live. */
const CONFIG_DIR = path.join(os.homedir(), ".agent-cli");

/** Full path to the JSON config file that Connection and /config read from. */
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/**
 * Checks whether the config.json file already exists on disk.
 *
 * @returns true if config.json exists, false otherwise.
 *
 * @example
 * if (hasConfigFile()) {
 *   const config = loadConfig();
 * } else {
 *   console.log("First run - running setup wizard");
 * }
 */
export const hasConfigFile = (): boolean => fs.existsSync(CONFIG_FILE);

/**
 * Creates a deep copy of the default configuration for first-run setup.
 *
 * @remarks
 * This function creates a copy of DEFAULT_CONFIG with a separate ui object to
 * avoid shared references. This is important for first-run setup where the
 * user's configuration needs to be independent of the defaults.
 *
 * @returns A deep copy of the default configuration object.
 *
 * @example
 * const userConfig = getDefaultConfig();
 * userConfig.server = "myserver.com";
 * // DEFAULT_CONFIG.server remains "localhost"
 */
export const getDefaultConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  ui: { ...DEFAULT_CONFIG.ui },
});

/**
 * Path to the readline history file for arrow-key command recall.
 *
 * @remarks
 * Exported so index.ts can load and save history on startup/shutdown.
 * History is persisted across CLI sessions for command recall convenience.
 */
export const HISTORY_FILE = path.join(CONFIG_DIR, ".history");

/**
 * Directory where user-created skill markdown files are stored.
 *
 * @remarks
 * Exported so skills.ts can read from and write to this directory.
 * Users can create custom skills as markdown files in this directory.
 */
export const SKILLS_DIR = path.join(CONFIG_DIR, "skills");

/**
 * Creates ~/.agent-cli/ if it does not exist yet.
 *
 * @remarks
 * This function ensures the config directory exists before reading or writing
 * configuration files. It creates parent directories as needed and does not
 * error if the directory already exists.
 *
 * @example
 * ensureDirs(); // Safe to call multiple times
 * fs.writeFileSync(CONFIG_FILE, "{}");
 */
export const ensureDirs = (): void => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
};

/**
 * Merges parsed config from disk with DEFAULT_CONFIG to fill missing keys.
 *
 * @remarks
 * This function ensures that the loaded config has all required fields by:
 * - Starting with DEFAULT_CONFIG as the base layer
 * - Overriding with parsed config values
 * - Validating showThinkOutput is boolean (otherwise use default)
 * - Validating subagentCap is positive integer (otherwise use default)
 * - Merging ui objects with defaults as base
 *
 * @param parsedConfig - Config object parsed from config.json.
 * @returns The merged configuration with all required fields.
 */
const mergeConfigFromDisk = (parsedConfig: Partial<Config>): Config => ({
  ...DEFAULT_CONFIG,
  ...parsedConfig,
  showThinkOutput:
    typeof parsedConfig.showThinkOutput === "boolean"
      ? parsedConfig.showThinkOutput
      : DEFAULT_CONFIG.showThinkOutput,
  subagentCap:
    typeof parsedConfig.subagentCap === "number" &&
    Number.isInteger(parsedConfig.subagentCap) &&
    parsedConfig.subagentCap >= 1
      ? parsedConfig.subagentCap
      : DEFAULT_CONFIG.subagentCap,
  ui: { ...DEFAULT_CONFIG.ui, ...parsedConfig.ui },
});

/**
 * Determines whether the config needs to be persisted back to disk.
 *
 * @remarks
 * This function checks if the loaded config needs corrections by:
 * - Checking if any DEFAULT_CONFIG keys are missing from stored config
 * - Checking if nested ui object is missing any keys
 * - Validating subagentCap is a positive integer
 * - Validating showThinkOutput is a boolean
 *
 * Returns true if any corrections are needed, indicating the config should be
 * re-saved to disk with the corrections applied.
 *
 * @param storedConfig - Raw config object read from disk.
 * @param parsedConfig - Parsed config with type information.
 * @returns true if config should be persisted, false otherwise.
 */
const configNeedsPersist = (
  storedConfig: Record<string, unknown>,
  parsedConfig: Partial<Config>,
): boolean => {
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key === "ui") {
      if (typeof storedConfig.ui !== "object" || storedConfig.ui === null) {
        return true;
      }
      const uiObject = storedConfig.ui as Record<string, unknown>;
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
  if (
    parsedConfig.subagentCap !== undefined &&
    (typeof parsedConfig.subagentCap !== "number" ||
      !Number.isInteger(parsedConfig.subagentCap) ||
      parsedConfig.subagentCap < 1)
  ) {
    return true;
  }
  if (
    parsedConfig.showThinkOutput !== undefined &&
    typeof parsedConfig.showThinkOutput !== "boolean"
  ) {
    return true;
  }
  return false;
};

/**
 * Loads the CLI configuration from ~/.agent-cli/config.json.
 *
 * @remarks
 * This function loads configuration from disk with the following behavior:
 * - Ensures ~/.agent-cli/ directory exists
 * - If config.json doesn't exist, writes DEFAULT_CONFIG and returns it
 * - Reads config.json as UTF-8 text
 * - Parses JSON and merges with DEFAULT_CONFIG (fills missing keys)
 * - Checks if merged config needs to be persisted back to disk
 * - On any error (read failure, JSON parse failure), returns DEFAULT_CONFIG
 *
 * The function fails softly to ensure the CLI can still start even if the
 * config file is corrupted or unreadable.
 *
 * @returns The loaded or default configuration object.
 *
 * @example
 * const config = loadConfig();
 * console.log(`Connecting to ${config.server}:${config.port}`);
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
    const parsedJson: unknown = JSON.parse(rawConfigString);
    if (typeof parsedJson !== "object" || parsedJson === null) {
      // Bad shape (e.g. a JSON array or primitive) — treat like unreadable/corrupt.
      return { ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui } };
    }
    const parsedConfig = parsedJson as Partial<Config>;
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
 * Persists a Config object to ~/.agent-cli/config.json as formatted JSON.
 *
 * @remarks
 * This function:
 * - Ensures ~/.agent-cli/ directory exists
 * - Stringifies the config object with 2-space indentation
 * - Writes the JSON string to config.json, replacing any existing file
 *
 * The 2-space indentation makes the file human-readable and easier to edit
 * manually if needed.
 *
 * @param config - The configuration object to save to disk.
 *
 * @example
 * const config = loadConfig();
 * config.server = "newhost.com";
 * saveConfig(config);
 */
export const saveConfig = (config: Config): void => {
  ensureDirs();
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
};

/**
 * Updates specific fields in the config file without overwriting other fields.
 *
 * @remarks
 * This function performs a shallow merge of the patch object into the loaded
 * config, then saves the result to disk. Only keys present in the patch object
 * are modified; all other fields remain unchanged.
 *
 * @param patch - Fields to update (e.g. { subagentModel: "gemma3:27b" }).
 * @returns The updated configuration after merging and saving.
 *
 * @example
 * const updatedConfig = updateConfig({
 *   subagentModel: "gemma3:27b",
 *   subagentTemp: 0.2
 * });
 * console.log(updatedConfig.subagentModel); // "gemma3:27b"
 */
export const updateConfig = (patch: Partial<Config>): Config => {
  const currentConfig = loadConfig();
  Object.assign(currentConfig, patch);
  saveConfig(currentConfig);
  return currentConfig;
};

/**
 * Reads a single field from the merged on-disk config.
 *
 * @remarks
 * This function loads the full config using the same merge rules as loadConfig
 * (DEFAULT_CONFIG spread under disk values) and returns the value at the
 * requested key. This is a convenience accessor for when you only need one
 * field from the config.
 *
 * Note: This re-reads the file on each call, which is acceptable for rare
 * single-field lookups but inefficient for repeated access.
 *
 * @param key - A key of the Config interface e.g. "server", "subagentModel".
 * @returns The value for that key, typed to match the field.
 *
 * @example
 * const server = getConfig("server");
 * const port = getConfig("port");
 */
export const getConfig = <K extends keyof Config>(key: K): Config[K] => {
  return loadConfig()[key];
};

/**
 * Updates exactly one config field and saves immediately to disk.
 *
 * @remarks
 * This function loads the current config, updates a single field, saves the
 * result to disk, and returns the full updated config. This is a convenience
 * function for when you only need to update one field.
 *
 * @param key - The config field to update.
 * @param value - The new value for that field.
 * @returns The full updated configuration after saving.
 *
 * @example
 * const updatedConfig = setConfig("subagentModel", "gemma3:27b");
 * console.log(updatedConfig.subagentModel); // "gemma3:27b"
 */
export const setConfig = <K extends keyof Config>(
  key: K,
  value: Config[K],
): Config => {
  const currentConfig = loadConfig();
  Object.assign(currentConfig, { [key]: value } as Partial<Config>);
  saveConfig(currentConfig);
  return currentConfig;
};
