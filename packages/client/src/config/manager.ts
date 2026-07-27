/**
 * Disk I/O for config.json: load, save, and the small read/write
 * convenience accessors built on top of them.
 *
 * @remarks
 * Encryption of the sensitive `password`/`server` fields lives here too
 * (via `decryptSecrets`/`encryptSecrets`) since it's inseparable from the
 * read/write path itself — `cipher.ts` only owns the passphrase *lifecycle*
 * (first run, unlock, rotate, reset), not the encryption calls that happen
 * on every load/save.
 */

import * as fs from "node:fs";
import {
  decryptSecrets,
  encryptSecrets,
} from "../crypto/configCipher.js";
import type { Config, SecretConfigFields, StoredConfig } from "./types.js";
import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  omitSecretFields,
} from "./types.js";
import { configNeedsPersist, mergeConfigFromDisk } from "./parsing.js";

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
 * Reports whether the config holds usable server connection settings.
 *
 * @remarks
 * Prefer this over {@link hasConfigFile} for first-run detection. The file's
 * mere existence proves nothing: {@link loadConfig} writes `DEFAULT_CONFIG` to
 * disk the first time it is called, so by the time the CLI checks,
 * `config.json` always exists — which made the setup wizard unreachable.
 *
 * An empty password is the signal, because the server rejects unauthenticated
 * clients outright: a blank password means "never configured" (fresh install)
 * or "deliberately cleared" (`loopy --reset`), and both should land the user in
 * the setup wizard rather than in a doomed connection attempt.
 *
 * @param config - A loaded configuration object.
 * @returns true when a server password has been set, false otherwise.
 *
 * @example
 * const needsSetup = !isConnectionConfigured(loadConfig());
 */
export const isConnectionConfigured = (config: Config): boolean =>
  config.password.trim().length > 0;

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

  let parsedJson: unknown;
  try {
    const rawConfigString = fs.readFileSync(CONFIG_FILE, "utf-8");
    parsedJson = JSON.parse(rawConfigString);
  } catch {
    // Bad JSON or unreadable file — fail soft so the CLI can still start.
    return { ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui } };
  }
  if (typeof parsedJson !== "object" || parsedJson === null) {
    // Bad shape (e.g. a JSON array or primitive) — treat like unreadable/corrupt.
    return { ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui } };
  }

  const stored = parsedJson as StoredConfig;
  // Decryption errors (locked cipher, wrong passphrase, tampered data) are
  // deliberately NOT caught here — they must surface to the caller rather
  // than silently falling back to defaults, which would look indistinguishable
  // from "your config was just reset".
  const secretFields: SecretConfigFields = stored.$secrets
    ? decryptSecrets<SecretConfigFields>(stored.$secrets)
    : {
        password:
          typeof stored.password === "string"
            ? stored.password
            : DEFAULT_CONFIG.password,
        server:
          typeof stored.server === "string"
            ? stored.server
            : DEFAULT_CONFIG.server,
      };

  const parsedConfig: Partial<Config> = {
    ...omitSecretFields(stored),
    ...secretFields,
  };
  const mergedConfig = mergeConfigFromDisk(parsedConfig);
  if (
    configNeedsPersist(parsedConfig as Record<string, unknown>, parsedConfig)
  ) {
    saveConfig(mergedConfig);
  }
  return mergedConfig;
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
  const { password, server, ...rest } = config;
  const secrets = encryptSecrets<SecretConfigFields>({ password, server });
  const onDisk: StoredConfig = { ...rest, $secrets: secrets };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  // `mode` above only applies when the file is newly created; chmod
  // explicitly so a pre-existing looser-permission file is corrected too.
  fs.chmodSync(CONFIG_FILE, 0o600);
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
