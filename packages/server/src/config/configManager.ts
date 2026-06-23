/**
 * <Summary>
 * What it does:
 *   Server-side model and behavior configuration. Reads and writes
 *   user-data/config.json. Never cached — always reads fresh from disk.
 *
 * How it fits in the system:
 *   Implements IConfigManager for Advisor, Agent, ContextBuilder, and Router
 *   config.get / config.set handlers. Provides centralized configuration management
 *   with atomic writes and model change notifications.
 * </Summary>
 */

// ===== CRYPTO AND FILESYSTEM IMPORTS =====
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ===== INTERFACE IMPORTS =====
import type { IConfigManager } from "../orchestration/interfaces.js";

// ===== MUTEX CLASS =====
/**
 * <Summary>
 * Simple Promise-based mutex for preventing concurrent operations.
 *
 * What it does:
 *   Ensures only one async operation can acquire the lock at a time.
 *   Operations wait until the lock is released before proceeding.
 *
 * How it works:
 *   1. acquire() returns a promise that resolves when lock is available.
 *   2. release() releases the lock for the next waiting operation.
 *   3. Uses a counter to track queued operations.
 * </Summary>
 */
class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  /**
   * Acquires the mutex lock, waiting if already locked.
   */
  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Releases the mutex lock, allowing the next waiting operation to proceed.
   */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Runs an async function while holding the mutex lock.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ===== CONSTANTS =====
/**
 * Relative path to persisted config under the server data root.
 * Combined with root directory to form the full config file path.
 */
const CONFIG_REL_PATH = "user-data/config.json";

/**
 * <Summary>
 * What it does:
 *   Built-in defaults merged into every load() when keys are missing on disk.
 *
 * How it fits in the system:
 *   Ensures the server always has valid configuration values even when
 *   the config file is missing or incomplete. These values represent
 *   sensible defaults for a typical LoopyCode setup.
 *
 * Used by:
 *   - mergeConfig — merges these defaults with stored configuration.
 *   - load — applies defaults when file doesn't exist or keys are missing.
 * </Summary>
 */
export const SERVER_DEFAULTS = {
  /**
   * Default temperature for advisor model (lower = more deterministic).
   * 0.1 provides focused, consistent responses for planning tasks.
   */
  advisorTemp: 0.1,

  /**
   * Default temperature for agent model (higher = more creative).
   * 0.4 allows some creativity while maintaining reliability for code tasks.
   */
  agentTemp: 0.4,

  /**
   * Default number of retry attempts for failed operations.
   * 3 retries provide robustness against transient failures.
   */
  retries: 3,

  /**
   * Default timeout for operations in milliseconds (10 minutes).
   * 600_000ms provides ample time for complex LLM operations.
   */
  timeout: 600_000,

  /**
   * Default maximum context budget as fraction (20%).
   * 0.2 reserves 20% of context window for system messages and metadata.
   */
  maxContextBudget: 0.2,
} as const;

/**
 * <Summary>
 * What it does:
 *   Custom error type for configuration-related failures.
 *
 * How it fits in the system:
 *   Thrown when advisorModel or agentModel is missing from persisted config,
 *   or when invalid configuration operations are attempted. Allows callers
 *   to distinguish configuration errors from other error types.
 *
 * Used by:
 *   - ConfigManager methods — thrown when validation fails.
 * </Summary>
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * <Summary>
 * What it does:
 *   Defines the complete shape of server configuration after merging defaults.
 *
 * Used by:
 *   - ConfigManager — type for loaded and stored configuration.
 *   - mergeConfig — return type for configuration merging.
 *
 * Produced by:
 *   - mergeConfig — creates this type from stored data and defaults.
 * </Summary>
 */
export type ServerConfig = {
  /**
   * Ollama model name for advisor (planning and coordination).
   * Must be a valid model name available in the local Ollama instance.
   * Empty string indicates not yet configured.
   */
  advisorModel: string;

  /**
   * Ollama model name for agent (task execution and code generation).
   * Must be a valid model name available in the local Ollama instance.
   * Empty string indicates not yet configured.
   */
  agentModel: string;

  /**
   * Temperature setting for advisor model (0.0 to 1.0).
   * Lower values produce more deterministic, focused responses.
   */
  advisorTemp: number;

  /**
   * Temperature setting for agent model (0.0 to 1.0).
   * Higher values allow more creative, varied responses.
   */
  agentTemp: number;

  /**
   * Number of retry attempts for failed operations.
   * Provides resilience against transient failures.
   */
  retries: number;

  /**
   * Operation timeout in milliseconds.
   * Prevents indefinite hanging on long-running operations.
   */
  timeout: number;

  /**
   * Maximum fraction of context budget for system use (0.0 to 1.0).
   * Reserved space for system messages and metadata in LLM context.
   */
  maxContextBudget: number;

  /**
   * ISO timestamp of last preference consolidation run.
   * Used to schedule periodic consolidation operations.
   */
  lastConsolidatedAt?: string;
};

/**
 * <Summary>
 * What it does:
 *   Distinguishes between advisor and agent configuration roles.
 *
 * Used by:
 *   - ConfigManager.setModel — specifies which model to update.
 *   - ConfigManager.getTemperature — selects temperature by role.
 *   - Model change callbacks — identifies which model changed.
 * </Summary>
 */
export type ConfigRole = "advisor" | "agent";

/**
 * <Summary>
 * What it does:
 *   Ensures a directory exists, creating it if necessary.
 *
 * How it does it (step by step):
 *   1. Calls fs.mkdir with recursive option.
 *   2. recursive: true creates parent directories if needed.
 *   3. No error if directory already exists.
 *
 * Parameters:
 *   @param directory - Directory path to ensure exists.
 *
 * Returns:
 *   @returns Completes when directory is guaranteed to exist.
 * </Summary>
 */
const ensureDir = async (directory: string): Promise<void> => {
  // Step 1: Create directory with parents if needed, no error if exists
  await fs.mkdir(directory, { recursive: true });
};

/**
 * <Summary>
 * What it does:
 *   Safely parses JSON configuration file content with error handling.
 *
 * How it does it (step by step):
 *   1. Attempt to parse raw string as JSON.
 *   2. Validate result is a non-null object (not array).
 *   3. Return parsed object if valid.
 *   4. Return empty object on any error (corrupt file, invalid JSON).
 *
 * Parameters:
 *   @param rawContent - Raw JSON string from config file.
 *
 * Returns:
 *   @returns Parsed object or empty object on failure.
 * </Summary>
 */
const parseStoredConfig = (rawContent: string): Record<string, unknown> => {
  try {
    // Step 1: Attempt to parse raw content as JSON
    const parsed: unknown = JSON.parse(rawContent);

    // Step 2: Validate parsed result is a non-null object (not array)
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      // Step 3: Return validated object
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Step 4: On parse error or invalid structure, treat as no overrides
    // Corrupt or empty file — treat as no overrides
  }

  // Step 5: Return empty object as fallback
  return {};
};

/**
 * <Summary>
 * What it does:
 *   Converts unknown value to string with fallback for invalid types.
 *
 * How it does it (step by step):
 *   1. Check if value is a non-empty string.
 *   2. Return value if valid string.
 *   3. Return fallback value otherwise.
 *
 * Parameters:
 *   @param value - Value to convert to string.
 *   @param fallback - Default value if conversion fails.
 *
 * Returns:
 *   @returns Valid string or fallback.
 * </Summary>
 */
const asString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

/**
 * <Summary>
 * What it does:
 *   Converts unknown value to number with fallback for invalid types.
 *
 * How it does it (step by step):
 *   1. Check if value is a finite number.
 *   2. Return value if valid number.
 *   3. Return fallback value otherwise.
 *
 * Parameters:
 *   @param value - Value to convert to number.
 *   @param fallback - Default value if conversion fails.
 *
 * Returns:
 *   @returns Valid number or fallback.
 * </Summary>
 */
const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * <Summary>
 * What it does:
 *   Extracts model name from unknown value, allowing empty strings.
 *
 * How it does it (step by step):
 *   1. Check if value is a string.
 *   2. Return value if string (including empty string).
 *   3. Return empty string otherwise.
 *
 * Parameters:
 *   @param value - Value to extract model name from.
 *
 * Returns:
 *   @returns Model name or empty string.
 * </Summary>
 */
const storedModel = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * <Summary>
 * What it does:
 *   Merges stored configuration with server defaults to create complete config.
 *
 * How it does it (step by step):
 *   1. Extract advisor model from stored config (empty string if missing).
 *   2. Extract agent model from stored config (empty string if missing).
 *   3. Merge advisor temperature with default fallback.
 *   4. Merge agent temperature with default fallback.
 *   5. Merge retries with default fallback.
 *   6. Merge timeout with default fallback.
 *   7. Merge max context budget with default fallback.
 *   8. Preserve last consolidated timestamp if present.
 *   9. Return complete ServerConfig object.
 *
 * Parameters:
 *   @param storedConfig - Raw config from file.
 *
 * Returns:
 *   @returns Complete configuration with defaults applied.
 * </Summary>
 */
const mergeConfig = (storedConfig: Record<string, unknown>): ServerConfig => ({
  // Step 1: Extract advisor model (empty string means not configured)
  advisorModel: storedModel(storedConfig.advisorModel),

  // Step 2: Extract agent model (empty string means not configured)
  agentModel: storedModel(storedConfig.agentModel),

  // Step 3: Merge advisor temperature with default
  advisorTemp: asNumber(storedConfig.advisorTemp, SERVER_DEFAULTS.advisorTemp),

  // Step 4: Merge agent temperature with default
  agentTemp: asNumber(storedConfig.agentTemp, SERVER_DEFAULTS.agentTemp),

  // Step 5: Merge retries with default
  retries: asNumber(storedConfig.retries, SERVER_DEFAULTS.retries),

  // Step 6: Merge timeout with default
  timeout: asNumber(storedConfig.timeout, SERVER_DEFAULTS.timeout),

  // Step 7: Merge max context budget with default
  maxContextBudget: asNumber(
    storedConfig.maxContextBudget,
    SERVER_DEFAULTS.maxContextBudget,
  ),

  // Step 8: Preserve last consolidated timestamp if present and valid
  lastConsolidatedAt:
    typeof storedConfig.lastConsolidatedAt === "string"
      ? storedConfig.lastConsolidatedAt
      : undefined,
});

/**
 * <Summary>
 * What it does:
 *   Lists configuration keys that can be modified via the set() method.
 *
 * How it fits in the system:
 *   These keys are considered safe to modify at runtime without requiring
 *   server restart. Model names (advisorModel, agentModel) are excluded as
 *   they require special handling via setModel() for cache invalidation.
 *
 * Used by:
 *   - set — validates that the requested key is writable.
 *
 * Excluded from this list:
 *   - advisorModel, agentModel — require setModel() for cache invalidation.
 * </Summary>
 */
const WRITABLE_CONFIG_KEYS = [
  "advisorTemp",
  "agentTemp",
  "retries",
  "timeout",
  "maxContextBudget",
  "lastConsolidatedAt",
] as const satisfies ReadonlyArray<keyof ServerConfig>;

/**
 * <Summary>
 * What it does:
 *   Loads and persists server configuration with fresh disk reads on every access.
 *
 * How it does it (step by step):
 *   1. load() reads user-data/config.json (or uses defaults when missing).
 *   2. Getter methods delegate to load() — no in-memory cache.
 *   3. set() / setModel() merge changes and save atomically via temp file + rename.
 *   4. setModel() invokes onModelChanged with the previous model name when it changes.
 *
 * How it fits in the system:
 *   Implements IConfigManager interface for orchestration layer components.
 * Provides reliable configuration persistence without caching to ensure
 * consistency across server operations. Uses atomic writes to prevent corruption.
 * </Summary>
 */
export class ConfigManager implements IConfigManager {
  /**
   * Full filesystem path to the configuration file.
   * Constructed from root directory and CONFIG_REL_PATH constant.
   */
  private readonly configPath: string;

  /**
   * Optional callback invoked when advisor or agent model changes.
   * Used by ContextBuilder to invalidate model-specific caches.
   * Parameters: old model name and the role that changed.
   */
  private onModelChanged?: (oldModel: string, role: ConfigRole) => void;

  /**
   * Mutex for preventing concurrent config operations.
   * Prevents race conditions between load, save, set, and setModel.
   */
  private readonly mutex = new Mutex();

  /**
   * <Summary>
   * What it does:
   *   Initializes ConfigManager with optional dependencies.
   *
   * How it does it (step by step):
   *   1. Accepts dependencies object with optional root directory and callback.
   *   2. Uses current working directory if root directory not provided.
   *   3. Constructs full config file path from root directory.
   *   4. Stores model change callback for later invocation.
   *
   * Parameters:
   *   @param dependencies - Data root and optional cache invalidation hook.
   * </Summary>
   */
  constructor(
    readonly dependencies: {
      rootDir?: string;
      onModelChanged?: (oldModel: string, role: ConfigRole) => void;
    } = {},
  ) {
    // Step 1: Extract root directory from dependencies, default to current working directory
    const rootDir = dependencies.rootDir ?? process.cwd();

    // Step 2: Construct full config file path
    this.configPath = path.join(rootDir, CONFIG_REL_PATH);

    // Step 3: Store model change callback for cache invalidation
    this.onModelChanged = dependencies.onModelChanged;
  }

  /**
   * <Summary>
   * What it does:
   *   Registers a callback invoked when setModel changes advisor or agent model.
   *
   * How it does it (step by step):
   *   1. Accepts callback function as parameter.
   *   2. Stores callback in instance variable.
   *   3. Callback will be invoked by setModel when model names change.
   *
   * Parameters:
   *   @param callback - Function to call when model changes.
   *
   * Returns:
   *   void — stores callback for later invocation.
   * </Summary>
   */
  setOnModelChanged = (
    callback: (oldModel: string, role: ConfigRole) => void,
  ): void => {
    // Step 1: Store the callback for later invocation by setModel
    this.onModelChanged = callback;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Reads user-data/config.json, parses JSON, merges with SERVER_DEFAULTS.
   *
   * How it does it (step by step):
   *   1. Acquire mutex lock to prevent concurrent operations.
   *   2. Attempt to read config file from disk.
   *   3. Parse file content as JSON with error handling.
   *   4. Merge parsed content with server defaults.
   *   5. If file doesn't exist, use defaults only.
   *   6. For other errors, re-throw to caller.
   *   7. Release mutex lock.
   *
   * Returns:
   *   @returns Complete configuration with defaults applied.
   * </Summary>
   */
  load = async (): Promise<ServerConfig> => {
    return this.mutex.run(async () => {
      try {
        // Step 1: Read config file content from disk
        const rawContent = await fs.readFile(this.configPath, "utf-8");

        // Step 2: Parse JSON and merge with defaults
        return mergeConfig(parseStoredConfig(rawContent));
      } catch (error) {
        // Step 3: Handle file system errors
        const errorCode = (error as NodeJS.ErrnoException).code;

        // Step 4: If file doesn't exist, return config with defaults only
        if (errorCode === "ENOENT") {
          return mergeConfig({});
        }

        // Step 5: For other errors (permissions, corruption), re-throw
        throw error;
      }
    });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Atomically writes the merged config object to user-data/config.json.
   *
   * How it does it (step by step):
   *   1. Extract directory path from config file path.
   *   2. Ensure directory exists (create if needed).
   *   3. Generate unique temporary file path using UUID.
   *   4. Serialize config to JSON with formatting.
   *   5. Write config to temporary file.
   *   6. Atomically rename temp file to actual config path.
   *   7. Atomic rename prevents corruption if write fails mid-operation.
   *
   * Parameters:
   *   @param config - Configuration object to persist.
   *
   * Returns:
   *   void — called for side effects (file persistence).
   * </Summary>
   */
  private save = async (config: ServerConfig): Promise<void> => {
    return this.mutex.run(async () => {
      // Step 1: Extract directory path from config file path
      const directory = path.dirname(this.configPath);

      // Step 2: Ensure directory exists (create if needed)
      await ensureDir(directory);

      // Step 3: Generate unique temporary file path using random UUID
      // Using temp file ensures atomic write operation
      const tempPath = path.join(directory, `.config-${randomUUID()}.tmp`);

      // Step 4: Serialize config to JSON with 2-space indentation and trailing newline
      const jsonPayload = `${JSON.stringify(config, null, 2)}\n`;

      // Step 5: Write config to temporary file
      await fs.writeFile(tempPath, jsonPayload, "utf-8");

      // Step 6: Atomically rename temp file to actual config path
      // Atomic operation prevents corruption if process crashes during write
      await fs.rename(tempPath, this.configPath);
    });
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the configured advisor model name, throwing if not set.
   *
   * How it does it (step by step):
   *   1. Load current configuration from disk.
   *   2. Extract advisor model name and trim whitespace.
   *   3. Throw ConfigError if model name is empty.
   *   4. Return validated model name.
   *
   * Returns:
   *   @returns Advisor model name.
   *
   * Throws:
   *   @throws {ConfigError} — When advisor model is not configured.
   * </Summary>
   */
  getAdvisorModel = async (): Promise<string> => {
    // Step 1: Load current configuration from disk
    const config = await this.load();

    // Step 2: Extract advisor model name and trim whitespace
    const modelName = config.advisorModel.trim();

    // Step 3: Validate model name is configured
    if (modelName.length === 0) {
      throw new ConfigError(
        "No advisor model configured. Run /set advisor to choose one.",
      );
    }

    // Step 4: Return validated model name
    return modelName;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the configured agent model name, throwing if not set.
   *
   * How it does it (step by step):
   *   1. Load current configuration from disk.
   *   2. Extract agent model name and trim whitespace.
   *   3. Throw ConfigError if model name is empty.
   *   4. Return validated model name.
   *
   * Returns:
   *   @returns Agent model name.
   *
   * Throws:
   *   @throws {ConfigError} — When agent model is not configured.
   * </Summary>
   */
  getAgentModel = async (): Promise<string> => {
    // Step 1: Load current configuration from disk
    const config = await this.load();

    // Step 2: Extract agent model name and trim whitespace
    const modelName = config.agentModel.trim();

    // Step 3: Validate model name is configured
    if (modelName.length === 0) {
      throw new ConfigError(
        "No agent model configured. Run /set agent to choose one.",
      );
    }

    // Step 4: Return validated model name
    return modelName;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the advisor temperature setting.
   *
   * How it does it (step by step):
   *   1. Load current configuration from disk.
   *   2. Return advisor temperature value.
   *
   * Returns:
   *   @returns Advisor temperature (0.0 to 1.0).
   * </Summary>
   */
  getAdvisorTemperature = async (): Promise<number> => {
    // Step 1: Load current configuration from disk
    const config = await this.load();

    // Step 2: Return advisor temperature value
    return config.advisorTemp;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the agent temperature setting.
   *
   * How it does it (step by step):
   *   1. Load current configuration from disk.
   *   2. Return agent temperature value.
   *
   * Returns:
   *   @returns Agent temperature (0.0 to 1.0).
   * </Summary>
   */
  getAgentTemperature = async (): Promise<number> => {
    // Step 1: Load current configuration from disk
    const config = await this.load();

    // Step 2: Return agent temperature value
    return config.agentTemp;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the maximum retry attempts setting.
   *
   * How it does it (step by step):
   *   1. Load current configuration from disk.
   *   2. Return retries value.
   *
   * Returns:
   *   @returns Maximum retry attempts.
   * </Summary>
   */
  getMaxRetries = async (): Promise<number> => {
    // Step 1: Load current configuration from disk
    const config = await this.load();

    // Step 2: Return retries value
    return config.retries;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the temperature setting for a specific role.
   *
   * How it does it (step by step):
   *   1. Load current configuration from disk.
   *   2. Select temperature based on role parameter.
   *   3. Return appropriate temperature value.
   *
   * Parameters:
   *   @param role - Either "advisor" or "agent".
   *
   * Returns:
   *   @returns Temperature for specified role (0.0 to 1.0).
   * </Summary>
   */
  getTemperature = async (role: ConfigRole): Promise<number> => {
    // Step 1: Load current configuration from disk
    const config = await this.load();

    // Step 2: Return temperature based on role
    return role === "advisor" ? config.advisorTemp : config.agentTemp;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the retry attempts setting (alias for getMaxRetries).
   *
   * How it does it (step by step):
   *   1. Load current configuration from disk.
   *   2. Return retries value.
   *
   * Returns:
   *   @returns Maximum retry attempts.
   * </Summary>
   */
  getRetries = async (): Promise<number> => {
    // Step 1: Load current configuration from disk
    const config = await this.load();

    // Step 2: Return retries value
    return config.retries;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the operation timeout setting in milliseconds.
   *
   * How it does it (step by step):
   *   1. Load current configuration from disk.
   *   2. Return timeout value.
   *
   * Returns:
   *   @returns Timeout in milliseconds.
   * </Summary>
   */
  getTimeout = async (): Promise<number> => {
    // Step 1: Load current configuration from disk
    const config = await this.load();

    // Step 2: Return timeout value
    return config.timeout;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the maximum context budget fraction.
   *
   * How it does it (step by step):
   *   1. Load current configuration from disk.
   *   2. Return max context budget value.
   *
   * Returns:
   *   @returns Max context budget (0.0 to 1.0).
   * </Summary>
   */
  getMaxContextBudget = async (): Promise<number> => {
    // Step 1: Load current configuration from disk
    const config = await this.load();

    // Step 2: Return max context budget value
    return config.maxContextBudget;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the complete server configuration.
   *
   * How it does it (step by step):
   *   1. Load current configuration from disk.
   *   2. Return complete ServerConfig object.
   *
   * Returns:
   *   @returns Complete configuration object.
   * </Summary>
   */
  getAll = async (): Promise<ServerConfig> => {
    // Step 1: Load and return complete configuration
    return this.load();
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Updates one config key and saves. Used by Router config.set.
   *
   * How it does it (step by step):
   *   1. Validate requested key is in WRITABLE_CONFIG_KEYS.
   *   2. Throw ConfigError if key is not writable.
   *   3. Load current configuration from disk.
   *   4. Create new config object with updated key value.
   *   5. Save updated configuration atomically.
   *
   * Parameters:
   *   @param key - Configuration key to update.
   *   @param value - New value for the configuration key.
   *
   * Returns:
   *   void — called for side effects (configuration update).
   *
   * Throws:
   *   @throws {ConfigError} — When key is not in writable list.
   * </Summary>
   */
  set = async (key: string, value: unknown): Promise<void> => {
    return this.mutex.run(async () => {
      // Step 1: Validate that the requested key is writable
      if (
        !WRITABLE_CONFIG_KEYS.includes(
          key as (typeof WRITABLE_CONFIG_KEYS)[number],
        )
      ) {
        throw new ConfigError(`Invalid config key: ${key}`);
      }

      // Step 2: Validate value type based on key
      if (key === "advisorTemp" || key === "agentTemp") {
        if (typeof value !== "number") {
          throw new ConfigError(`${key} must be a number`);
        }
        if (value < 0 || value > 1) {
          throw new ConfigError(`${key} must be between 0 and 1`);
        }
      } else if (key === "retries") {
        if (typeof value !== "number") {
          throw new ConfigError(`retries must be a number`);
        }
        if (value < 0 || !Number.isInteger(value)) {
          throw new ConfigError(`retries must be a non-negative integer`);
        }
      } else if (key === "timeout") {
        if (typeof value !== "number") {
          throw new ConfigError(`timeout must be a number`);
        }
        if (value < 0) {
          throw new ConfigError(`timeout must be non-negative`);
        }
      } else if (key === "maxContextBudget") {
        if (typeof value !== "number") {
          throw new ConfigError(`maxContextBudget must be a number`);
        }
        if (value < 0 || value > 1) {
          throw new ConfigError(`maxContextBudget must be between 0 and 1`);
        }
      } else if (key === "lastConsolidatedAt") {
        if (typeof value !== "number") {
          throw new ConfigError(
            `lastConsolidatedAt must be a number (timestamp)`,
          );
        }
      }

      // Step 3: Load current configuration from disk
      const config = await this.load();

      // Step 4: Create new config object with updated key value
      // Spread operator copies all existing properties, then overwrites the specified key
      const nextConfig = { ...config, [key]: value } as ServerConfig;

      // Step 5: Save updated configuration atomically
      await this.save(nextConfig);
    });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Updates advisorModel or agentModel, saves, and notifies onModelChanged
   *   with the previous model name so ContextBuilder can invalidate cache.
   *
   * How it does it (step by step):
   *   1. Trim whitespace from provided model name.
   *   2. Validate model name is not empty.
   *   3. Load current configuration from disk.
   *   4. Extract previous model name for the specified role.
   *   5. Create new config with updated model name.
   *   6. Save updated configuration atomically.
   *   7. If model changed, invoke onModelChanged callback.
   *
   * Parameters:
   *   @param role - Either "advisor" or "agent".
   *   @param modelName - New model name to set.
   *
   * Returns:
   *   void — called for side effects (model update and cache invalidation).
   *
   * Throws:
   *   @throws {ConfigError} — When model name is empty.
   * </Summary>
   */
  setModel = async (role: ConfigRole, modelName: string): Promise<void> => {
    return this.mutex.run(async () => {
      // Step 1: Trim whitespace from provided model name
      const trimmedModelName = modelName.trim();

      // Step 2: Validate model name is not empty
      if (trimmedModelName.length === 0) {
        throw new ConfigError(
          role === "advisor"
            ? "Advisor model name cannot be empty."
            : "Agent model name cannot be empty.",
        );
      }

      // Step 3: Load current configuration from disk
      const config = await this.load();

      // Step 4: Extract previous model name for the specified role
      const previousModel =
        role === "advisor" ? config.advisorModel : config.agentModel;

      // Step 5: Create new config object with updated model name
      const nextConfig: ServerConfig =
        role === "advisor"
          ? { ...config, advisorModel: trimmedModelName }
          : { ...config, agentModel: trimmedModelName };

      // Step 6: Save updated configuration atomically
      await this.save(nextConfig);

      // Step 7: If model actually changed, invoke cache invalidation callback
      if (previousModel !== trimmedModelName) {
        this.onModelChanged?.(previousModel, role);
      }
    });
  };
}
