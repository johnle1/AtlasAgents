/**
 * Server-wide configuration manager for models, timeouts, and LLM behavior.
 *
 * **Responsibility:**
 * Reads and writes `~/.loopycode/user-data/config.json` with fresh disk reads on every
 * access (no in-memory caching). Provides type-safe getters/setters, validates all values,
 * and notifies listeners when models change so they can invalidate caches.
 *
 * Key Features:
 * - Fresh disk reads: Every getter reads latest config from disk (not cached)
 * - Atomic writes: Uses temp-file + rename to prevent corruption on crash
 * - Mutex-protected: Serializes concurrent load/save operations
 * - Model change notifications: Calls onModelChanged() callback for cache invalidation
 * - Type validation: Validates all values against their expected types and ranges
 *
 * How It Fits in the System:
 * - Implements `IConfigManager` interface for dependency injection
 * - Used by: Agent, Subagent, ContextBuilder, Router, and other services
 * - Part of infrastructure layer, wired in container.ts
 * - Provides config to all layers that need model names, timeouts, or behavior tuning
 *
 * Configuration File:
 * Location: `~/.loopycode/user-data/config.json`
 * Format: JSON object with keys like subagentModel, subagentModel, agentTemp, etc.
 * Behavior: Missing keys use SERVER_DEFAULTS; corrupted files treated as empty
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteJson } from "../utils/atomicWriteJson.js";
import type { IConfigManager } from "../orchestration/interfaces.js";

// ===== MUTEX CLASS =====
/**
 * Simple Promise-based mutex for preventing concurrent config file operations.
 *
 * **Purpose:**
 * Ensures that only one async operation (load, save, set, setModel) can access
 * or modify the config file at a time. This prevents race conditions where multiple
 * callers might read stale data or overwrite each other's changes.
 *
 * **How It Works:**
 * - `acquire()` claims the lock immediately if available, or queues the caller
 * - `release()` gives the lock to the next queued caller (FIFO order)
 * - `run()` is the typical interface: acquire lock, execute function, release lock
 *
 * **Thread Safety:**
 * Protects against concurrent mutations of the config file, but does NOT cache
 * the file contents in memory. Each load() still reads fresh from disk to ensure
 * consistency across distributed file access.
 */
class Mutex {
  /** True when the lock is currently held by some caller */
  private locked = false;

  /** Queue of resolve functions waiting for the lock to become available */
  private queue: Array<() => void> = [];

  /**
   * Acquire the mutex lock, blocking until available.
   *
   * **Behavior:**
   * - If lock is free: immediately sets locked=true and returns
   * - If lock is held: returns a promise that resolves when previous holder releases
   *
   * **Usage Pattern:**
   * Normally called via `run()`, not directly. For direct use, always pair with
   * a try/finally block to ensure release() is called.
   *
   * @returns Promise that resolves when lock is acquired
   */
  async acquire(): Promise<void> {
    // Fast path: lock is free, claim it immediately
    if (!this.locked) {
      this.locked = true;
      return;
    }

    // Slow path: lock is held, queue a promise to resolve when freed
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release the mutex lock and wake the next waiter (if any).
   *
   * **Behavior:**
   * - If someone is waiting: resolve their promise (wakes them up)
   * - If no one is waiting: set locked=false for next immediate acquire()
   *
   * **Important:** Must be paired with acquire(). Always call in a finally block
   * to guarantee release even if the critical section throws an error.
   */
  release(): void {
    // Dequeue the first waiting caller (FIFO fairness)
    const next = this.queue.shift();

    if (next) {
      // Wake the next caller by resolving their promise
      next();
    } else {
      // No one waiting, mark lock as free for fast acquire() path
      this.locked = false;
    }
  }

  /**
   * Safely acquire lock, run a function, then release lock.
   *
   * **Pattern:**
   * This is the primary way to use the mutex. It handles acquire/release
   * automatically using try/finally to guarantee release even on error.
   *
   * **Example:**
   * ```typescript
   * const result = await mutex.run(async () => {
   *   const config = await loadFromDisk();
   *   config.subagentModel = "llama2";
   *   await saveToDisk(config);
   *   return "saved";
   * });
   * ```
   *
   * @template T The return type of the function
   * @param fn Async function to execute while holding the lock
   * @returns Promise resolving to the function's return value
   * @throws Re-throws any error thrown by fn
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Acquire lock (waits if necessary)
    await this.acquire();

    try {
      // Execute the critical section while holding lock
      return await fn();
    } finally {
      // ALWAYS release lock, even if fn() threw an error
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
 * Built-in fallback defaults applied when config keys are missing from disk.
 *
 * **Purpose:**
 * Ensures the server always has valid configuration values even when:
 * - config.json doesn't exist yet
 * - config.json is missing certain keys (partial config)
 * - User hasn't customized a setting
 *
 * **Application:**
 * Merged with loaded config in `mergeConfig()`. Stored config values override
 * these defaults; missing keys fall back to these defaults.
 *
 * **Tuning:**
 * These defaults represent sensible starting points for a typical local
 * LoopyCode development setup. Users can override any value via `/set` command.
 */
export const SERVER_DEFAULTS = {
  /**
   * **agentTemp: 0.1** — Temperature for task planning (Subsubagent model)
   *
   * Lower temperature (toward 0.0) makes the model more deterministic and focused.
   * Agent is responsible for breaking down tasks into a DAG of subtasks, so lower
   * temperature ensures consistent, predictable plans. Values like 0.0–0.3 work well.
   *
   * Typical range: 0.0 (fully deterministic) to 1.0 (fully random)
   */
  agentTemp: 0.1,

  /**
   * **subagentTemp: 0.4** — Temperature for task execution (Subagent model)
   *
   * Slightly higher temperature than agent allows some creativity and flexibility
   * when generating code or writing documentation. Still conservative enough to
   * avoid wild off-topic responses. Values like 0.2–0.6 work well.
   *
   * Typical range: 0.0 (fully deterministic) to 1.0 (fully random)
   */
  subagentTemp: 0.4,

  /**
   * **retries: 3** — Maximum retry attempts for failed subtasks
   *
   * When a subagent fails to complete a task (syntax error, compilation failure, etc.),
   * it retries with the error feedback and guidance up to this many times. More retries
   * increase robustness but also time-to-completion. 3 retries is a good balance.
   *
   * Typical range: 0–5 attempts
   */
  retries: 3,

  /**
   * **timeout: 600_000** — Default operation timeout in milliseconds (10 minutes)
   *
   * Maximum time allowed for any single task execution. Prevents hangs on stuck
   * operations. 10 minutes is generous for complex LLM work; smaller timeouts (30–120s)
   * are common for quick operations.
   *
   * Typical range: 5_000ms (5s, quick) to 600_000ms (10m, complex tasks)
   */
  timeout: 600_000,

  /**
   * **maxContextBudget: 0.2** — Maximum fraction of context reserved for system use
   *
   * When building LLM context windows, ContextBuilder reserves this fraction (20%)
   * for system messages, metadata, and formatting. The remaining 80% goes to user
   * preferences, session history, and current task. Higher values (e.g., 0.3) reduce
   * space for user context; lower values (e.g., 0.1) tighten system constraints.
   *
   * Typical range: 0.1–0.4 (10%–40% reservation)
   */
  maxContextBudget: 0.2,

  /**
   * **agentModelSupportsTools: false** — Does subagent model support native tool_calls?
   *
   * When true: agent uses Ollama's native tool_calls API (structured tool invocation)
   * When false: agent uses legacy <<TOOL>>...<</TOOL>> text markers
   *
   * Most current Ollama models still use text markers. Enable this only for models
   * that explicitly support `tools` in their request schema.
   *
   * See: ollama/modelCapabilities.ts for model-specific tool support detection
   */
  agentModelSupportsTools: false,

  /**
   * **subagentModelSupportsTools: false** — Does subagent model support native tool_calls?
   *
   * When true: subagent uses Ollama's native tool_calls API (structured tool invocation)
   * When false: subagent uses legacy <<TOOL>>...<</TOOL>> text markers
   *
   * See: agentModelSupportsTools above; same logic applies.
   */
  subagentModelSupportsTools: false,

  /**
   * **agentProvider / subagentProvider: "ollama"** — Which provider serves each role.
   *
   * A provider name of "ollama" always resolves to the native local Ollama client.
   * Any other value must have a matching entry in `providers` (added via
   * `/providers add` or ConfigManager.addProvider), pointing at an OpenAI-compatible
   * endpoint (vLLM on a GPU box, AWS Trainium, Google TPU, ...).
   */
  agentProvider: "ollama",
  subagentProvider: "ollama",
} as const;

/**
 * <Summary>
 * What it does:
 *   Custom error type for configuration-related failures.
 *
 * How it fits in the system:
 *   Thrown when subagentModel or subagentModel is missing from persisted config,
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
   * Ollama model name for agent (planning and coordination).
   * Must be a valid model name available in the local Ollama instance.
   * Empty string indicates not yet configured.
   */
  agentModel: string;

  /**
   * Ollama model name for subagent (task execution and code generation).
   * Must be a valid model name available in the local Ollama instance.
   * Empty string indicates not yet configured.
   */
  subagentModel: string;

  /**
   * When true, agent model uses native Ollama tool calling API.
   */
  agentModelSupportsTools: boolean;

  /**
   * When true, subagent model uses native Ollama tool calling API.
   */
  subagentModelSupportsTools: boolean;

  /**
   * Temperature setting for agent model (0.0 to 1.0).
   * Lower values produce more deterministic, focused responses.
   */
  agentTemp: number;

  /**
   * Temperature setting for subagent model (0.0 to 1.0).
   * Higher values allow more creative, varied responses.
   */
  subagentTemp: number;

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

  /**
   * Provider name serving the agent (planning) role. "ollama" (the default)
   * always resolves to the native local Ollama client; any other value must
   * have a matching entry in `providers`.
   */
  agentProvider: string;

  /**
   * Provider name serving the subagent (execution) role. Same rules as
   * agentProvider.
   */
  subagentProvider: string;

  /**
   * Non-Ollama provider connection details, keyed by provider name.
   * "ollama" is reserved and never stored here — it is built in.
   */
  providers: Record<string, { baseUrl: string; apiKey?: string }>;
};

/**
 * <Summary>
 * What it does:
 *   Distinguishes between agent and subagent configuration roles.
 *
 * Used by:
 *   - ConfigManager.setModel — specifies which model to update.
 *   - ConfigManager.getTemperature — selects temperature by role.
 *   - Model change callbacks — identifies which model changed.
 * </Summary>
 */
export type ConfigRole = "agent" | "subagent";

/**
 * Parse and validate JSON config file content, with graceful error handling.
 *
 * **Purpose:**
 * Reads the raw JSON string from config.json and converts it to a typed object,
 * validating structure and handling errors. Returns an empty object on any parse
 * failure, allowing the defaults merging step to provide valid fallback values.
 *
 * **Validation:**
 * - JSON must parse without error (syntax must be valid)
 * - Parsed value must be a non-null object (not a string, number, array, etc.)
 * - Returns empty `{}` on any validation failure
 *
 * **Error Handling:**
 * Silent fallback on error. Corrupted or malformed JSON is treated as "no overrides",
 * letting the defaults merge provide safe values. Errors are logged elsewhere.
 *
 * @param rawContent Raw JSON string read from config.json file
 * @returns Parsed object (which may be empty `{}` if parsing failed or structure was invalid)
 *
 * @example
 * ```typescript
 * // Valid JSON object
 * parseStoredConfig('{"agentTemp": 0.5}');  // → {agentTemp: 0.5}
 *
 * // Valid JSON but wrong type (array, string, etc.)
 * parseStoredConfig('[1,2,3]');  // → {} (not object)
 * parseStoredConfig('"string"'); // → {} (not object)
 *
 * // Invalid JSON
 * parseStoredConfig('{ broken json }'); // → {} (parse error)
 *
 * // Empty string or null content
 * parseStoredConfig('');         // → {} (parse error)
 * parseStoredConfig('null');     // → {} (is null, not object)
 * ```
 */
const parseStoredConfig = (rawContent: string): Record<string, unknown> => {
  try {
    // Step 1: Attempt to parse raw content as JSON
    // If JSON syntax is invalid, this throws and we fall through to catch
    const parsed: unknown = JSON.parse(rawContent);

    // Step 2: Validate parsed result is a non-null object (not array or primitive)
    // We specifically reject null (typeof null === "object"), arrays, and primitives
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      // Step 3: Validation passed, cast and return as typed object
      return parsed as Record<string, unknown>;
    }

    // Step 3b: If validation failed (was null, array, or primitive), fall through to return empty
  } catch {
    // Step 4: On any parse error (malformed JSON, syntax error), treat as no overrides
    // Silently ignore and fall through to return empty object
  }

  // Step 5: Return empty object as fallback when parsing/validation fails
  // The mergeConfig() function will fill in all keys with defaults
  return {};
};

/**
 * Type-safe string coercion with fallback.
 *
 * **Purpose:**
 * Safely converts an unknown value to a non-empty string. Used during config
 * merging to validate and sanitize string values from loaded config.
 *
 * **Validation:**
 * - Must be typeof "string" (rejects numbers, booleans, objects, null)
 * - Must have length > 0 (rejects empty strings)
 * - Falls back to provided default if validation fails
 *
 * @param value Unknown value from config (may be any type)
 * @param fallback Fallback string returned if value is not a non-empty string
 * @returns value if it's a valid non-empty string, otherwise fallback
 *
 * @example
 * ```typescript
 * asString("hello", "default");     // → "hello"
 * asString("", "default");          // → "default" (empty string)
 * asString(123, "default");         // → "default" (not a string)
 * asString(null, "default");        // → "default" (null)
 * asString(undefined, "default");   // → "default" (undefined)
 * ```
 */
const asString = (value: unknown, fallback: string): string =>
  // Only accept strings that have at least one character
  typeof value === "string" && value.length > 0 ? value : fallback;

/**
 * Type-safe number coercion with fallback.
 *
 * **Purpose:**
 * Safely converts an unknown value to a finite number. Used during config merging
 * to validate and sanitize numeric values (temperatures, timeouts, retries, etc.).
 *
 * **Validation:**
 * - Must be typeof "number" (rejects strings, booleans, objects, null)
 * - Must be finite (rejects Infinity, -Infinity, NaN)
 * - Falls back to provided default if validation fails
 *
 * **Why Check Finite?**
 * JSON can contain Infinity or NaN, which are not valid config values. We explicitly
 * reject these using `Number.isFinite()` to ensure only valid numeric values pass.
 *
 * @param value Unknown value from config (may be any type)
 * @param fallback Fallback number returned if value is not a finite number
 * @returns value if it's a valid finite number, otherwise fallback
 *
 * @example
 * ```typescript
 * asNumber(0.5, 0.1);            // → 0.5
 * asNumber(600000, 10000);       // → 600000
 * asNumber("123", 10);           // → 10 (string, not number)
 * asNumber(Infinity, 10);        // → 10 (not finite)
 * asNumber(NaN, 10);             // → 10 (not finite)
 * asNumber(null, 10);            // → 10 (not a number)
 * ```
 */
const asNumber = (value: unknown, fallback: number): number =>
  // Ensure value is a number type AND a valid finite value (not Infinity, NaN, etc.)
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Extract model name from unknown value, with special handling for empty strings.
 *
 * **Purpose:**
 * Extracts model name strings from loaded config. Unlike asString(), this allows
 * empty strings to pass through (meaning "not configured yet"). Empty model names
 * are valid; they signal to the user that they need to configure a model.
 *
 * **Validation:**
 * - Must be typeof "string" (empty or non-empty)
 * - Falls back to empty string if not a string type
 * - Does NOT validate whether the model actually exists in Ollama
 *
 * **Why Special Handling?**
 * Model names can be "" (not yet set) or any non-empty string (configured).
 * Unlike config values like temperatures, we accept empty here as a valid state.
 * The actual model must be validated by attempting to use it.
 *
 * @param value Unknown value from config (may be any type)
 * @returns value if it's a string (empty or non-empty), otherwise empty string
 *
 * @example
 * ```typescript
 * storedModel("llama2");          // → "llama2"
 * storedModel("");                // → "" (valid: not yet configured)
 * storedModel(null);              // → "" (treat missing as unconfigured)
 * storedModel(123);               // → "" (treat wrong type as unconfigured)
 * storedModel(undefined);         // → "" (treat missing as unconfigured)
 * ```
 */
const storedModel = (value: unknown): string =>
  // Any string is acceptable (including empty string meaning "not configured")
  typeof value === "string" ? value : "";

/**
 * Type-safe boolean coercion with fallback.
 *
 * **Purpose:**
 * Safely converts an unknown value to a boolean. Used during config merging to
 * validate model capability flags (subagentModelSupportsTools, subagentModelSupportsTools).
 *
 * **Validation:**
 * - Must be typeof "boolean" (true or false exactly; rejects truthy/falsy values)
 * - Falls back to provided default if not a boolean
 * - No type coercion (unlike JavaScript's `Boolean()` function)
 *
 * **Why Strict?**
 * We explicitly check `typeof value === "boolean"` to avoid accidentally accepting
 * truthy values like 1, "true", [] etc. Config values must be exactly true or false.
 *
 * @param value Unknown value from config (may be any type)
 * @param fallback Fallback boolean returned if value is not exactly true or false
 * @returns value if it's a boolean, otherwise fallback
 *
 * @example
 * ```typescript
 * asBoolean(true, false);         // → true
 * asBoolean(false, true);         // → false
 * asBoolean(1, false);            // → false (truthy, but not boolean)
 * asBoolean("true", false);       // → false (string, not boolean)
 * asBoolean(null, false);         // → false (not a boolean)
 * asBoolean(undefined, true);     // → true (not a boolean)
 * ```
 */
const asBoolean = (value: unknown, fallback: boolean): boolean =>
  // Only accept true or false; reject truthy/falsy values
  typeof value === "boolean" ? value : fallback;

/**
 * Type-safe extraction of the `providers` map from stored config.
 *
 * **Purpose:**
 * Validates the non-Ollama provider entries loaded from disk, dropping any
 * malformed entry (missing/empty baseUrl) rather than failing the whole load.
 *
 * @param value Unknown value from config (expected to be a plain object)
 * @returns Validated provider map; empty object if value is missing or malformed
 */
const asProviders = (
  value: unknown,
): Record<string, { baseUrl: string; apiKey?: string }> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, { baseUrl: string; apiKey?: string }> = {};
  for (const [name, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const baseUrl = record.baseUrl;
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      continue;
    }
    const apiKey = record.apiKey;
    result[name] =
      typeof apiKey === "string" && apiKey.length > 0
        ? { baseUrl, apiKey }
        : { baseUrl };
  }
  return result;
};

/**
 * Merge stored config with defaults to create complete, validated ServerConfig.
 *
 * **Purpose:**
 * Takes raw config data from disk (which may be partial, missing keys, or corrupted)
 * and produces a complete ServerConfig object with every required key set to either
 * the loaded value or a safe default.
 *
 * **Process:**
 * 1. For each key in ServerConfig:
 *    - Extract value from storedConfig (may be missing)
 *    - Pass through type-coercion function (asString, asNumber, storedModel, etc.)
 *    - If stored value is valid, use it; otherwise use SERVER_DEFAULTS fallback
 * 2. Return fully populated object
 *
 * **Key Behavior:**
 * - **Model names** (subagentModel, subagentModel): Extracted via storedModel()
 *   - Empty string "": Means "not configured yet" (valid state)
 *   - Non-empty string: Model name (may not exist in Ollama, but syntactically valid)
 *
 * - **Numeric values** (temp, retries, timeout, budget): Extracted via asNumber()
 *   - Must be finite numbers (no Infinity, NaN, -0)
 *   - Falls back to SERVER_DEFAULTS if missing or invalid type
 *
 * - **Boolean values** (supportsTools flags): Extracted via asBoolean()
 *   - Must be exactly true or false (no truthy/falsy values)
 *
 * - **Timestamp** (lastConsolidatedAt): Optional ISO string
 *   - Only preserved if it's a valid string; omitted otherwise
 *
 * @param storedConfig Raw config object from disk (after parseStoredConfig())
 * @returns Complete ServerConfig with all required keys populated
 *
 * @example
 * ```typescript
 * // Complete stored config
 * mergeConfig({
 *   subagentModel: "llama2",
 *   subagentModel: "mistral",
 *   agentTemp: 0.2,
 *   // ... etc
 * });
 * // → {subagentModel: "llama2", subagentModel: "mistral", agentTemp: 0.2, retries: 3, ...}
 *
 * // Partial stored config (missing some keys)
 * mergeConfig({
 *   subagentModel: "llama2",
 *   // agentTemp omitted, timeout omitted, etc.
 * });
 * // → {subagentModel: "llama2", agentTemp: 0.1 (default), timeout: 600000 (default), ...}
 *
 * // Empty stored config (no keys at all)
 * mergeConfig({});
 * // → {subagentModel: "", agentTemp: 0.1, timeout: 600000, retries: 3, ...} (all defaults)
 * ```
 */
const mergeConfig = (storedConfig: Record<string, unknown>): ServerConfig => {
  // Model names: extracted via storedModel() which allows empty string
  const rawAgentModel = storedModel(storedConfig.agentModel);
  const rawSubagentModel = storedModel(storedConfig.subagentModel);

  // One-time backfill migration: a prior bug in setModel()/setRoleModel() wrote
  // every model selection — for both the "agent" and "subagent" roles — into the
  // `subagentModel` field, so `agentModel` was never persisted. For configs
  // written while that bug was live, `subagentModel` holds whatever the user
  // last picked for *either* role. If `agentModel` is still empty, backfill it
  // from `subagentModel` so existing users keep a working agent model instead of
  // silently landing on "no model configured" the moment the bug is fixed.
  // Safe to run on every load: once `agentModel` is populated, this is a no-op.
  const agentModel =
    rawAgentModel.length === 0 && rawSubagentModel.length > 0
      ? rawSubagentModel
      : rawAgentModel;

  return {
    agentModel,
    subagentModel: rawSubagentModel,

    // Tool support flags: extracted via asBoolean() with defaults
    agentModelSupportsTools: asBoolean(
      storedConfig.agentModelSupportsTools,
      SERVER_DEFAULTS.agentModelSupportsTools,
    ),
    subagentModelSupportsTools: asBoolean(
      storedConfig.subagentModelSupportsTools,
      SERVER_DEFAULTS.subagentModelSupportsTools,
    ),

    // Temperature settings: extracted via asNumber() to ensure finite values with defaults
    agentTemp: asNumber(storedConfig.agentTemp, SERVER_DEFAULTS.agentTemp),
    subagentTemp: asNumber(
      storedConfig.subagentTemp,
      SERVER_DEFAULTS.subagentTemp,
    ),

    // Retry configuration: extracted via asNumber() with default
    retries: asNumber(storedConfig.retries, SERVER_DEFAULTS.retries),

    // Timeout in milliseconds: extracted via asNumber() with default
    timeout: asNumber(storedConfig.timeout, SERVER_DEFAULTS.timeout),

    // Context budget fraction: extracted via asNumber() with default
    maxContextBudget: asNumber(
      storedConfig.maxContextBudget,
      SERVER_DEFAULTS.maxContextBudget,
    ),

    // Optional: preserve last consolidation timestamp if it's a valid string
    // This field is used to schedule periodic preference consolidation
    lastConsolidatedAt:
      typeof storedConfig.lastConsolidatedAt === "string"
        ? storedConfig.lastConsolidatedAt
        : undefined,

    // Provider selection per role: extracted via asString() — always falls back
    // to "ollama" (never empty, unlike model names) so existing config.json
    // files with no provider fields transparently keep working.
    agentProvider: asString(
      storedConfig.agentProvider,
      SERVER_DEFAULTS.agentProvider,
    ),
    subagentProvider: asString(
      storedConfig.subagentProvider,
      SERVER_DEFAULTS.subagentProvider,
    ),

    // Non-Ollama provider connection details: extracted via asProviders()
    providers: asProviders(storedConfig.providers),
  };
};

/**
 * <Summary>
 * What it does:
 *   Lists configuration keys that can be modified via the set() method.
 *
 * How it fits in the system:
 *   These keys are considered safe to modify at runtime without requiring
 *   server restart. Model names (subagentModel, subagentModel) are excluded as
 *   they require special handling via setModel() for cache invalidation.
 *
 * Used by:
 *   - set — validates that the requested key is writable.
 *
 * Excluded from this list:
 *   - subagentModel, subagentModel — require setModel() for cache invalidation.
 * </Summary>
 */
const WRITABLE_CONFIG_KEYS = [
  "agentTemp",
  "subagentTemp",
  "subagentModelSupportsTools",
  "subagentModelSupportsTools",
  "retries",
  "timeout",
  "maxContextBudget",
  "lastConsolidatedAt",
] as const satisfies ReadonlyArray<keyof ServerConfig>;

/**
 * Server-wide configuration manager for models, timeouts, and behavior settings.
 *
 * **Responsibility:**
 * - Reads/writes `~/.loopycode/user-data/config.json`
 * - Validates all configuration values with type checking and ranges
 * - Provides getter methods for Agent, Subagent, and other services
 * - Notifies listeners when model changes occur (for cache invalidation)
 * - Uses atomic file writes to prevent corruption on failure
 * - Uses a mutex to prevent concurrent read/write race conditions
 *
 * **Key Design Decisions:**
 * 1. **No In-Memory Caching**: Every getter calls _loadRaw(), reading fresh from disk.
 *    This ensures consistency if config.json is modified externally (e.g., by user script).
 *
 * 2. **Atomic Writes**: save() uses temp-file + rename to prevent partial writes
 *    if the process crashes mid-write. The file is either fully written or unchanged.
 *
 * 3. **Mutex Protection**: All file operations use mutex.run() to serialize access.
 *    Prevents race conditions between concurrent load/save/set operations.
 *
 * 4. **Model Change Notifications**: setModel() invokes onModelChanged callback
 *    with the OLD model name, allowing ContextBuilder to invalidate caches.
 *
 * **How It Fits in the System:**
 * - Implements IConfigManager interface for dependency injection
 * - Called by Agent, Subagent, ContextBuilder, and RouterBuilder
 * - Part of the infrastructure layer; wired in container.ts
 *
 * **Usage Pattern:**
 * ```typescript
 * const configManager = new ConfigManager({ rootDir: "/server/data" });
 * configManager.setOnModelChanged((oldModel, role) => {
 *   console.log(`Model changed from ${oldModel} to ${...}`);
 * });
 *
 * const subagentModel = await configManager.getAgentModel(); // throws if not set
 * await configManager.setModel("agent", "llama2");
 * const temp = await configManager.getTemperature("agent");
 * ```
 *
 * **Interface Contract (IConfigManager):**
 * All public methods are async. Each getter reads fresh from disk via _loadRaw().
 * Model setters may throw ConfigError if validation fails.
 */
export class ConfigManager implements IConfigManager {
  /**
   * Full filesystem path to the configuration file.
   * Constructed from root directory and CONFIG_REL_PATH constant.
   */
  private readonly configPath: string;

  /**
   * Optional callback invoked when agent or subagent model changes.
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
   *   Registers a callback invoked when setModel changes agent or subagent model.
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
   * **PRIVATE** Read config from disk without mutex acquisition (re-entrant safe).
   *
   * **Important:** This method does NOT acquire the mutex. It must ONLY be called
   * from within a mutex.run() block (used by set(), setModel(), constructor).
   * Calling this directly from a public method will cause a deadlock when that
   * method calls mutex.run().
   *
   * **Flow:**
   * 1. Read raw JSON file content from configPath
   * 2. Parse JSON and merge with SERVER_DEFAULTS
   * 3. Return complete ServerConfig (or all defaults if file missing)
   * 4. Throw on permission errors, disk errors (re-throws for caller to handle)
   *
   * **Error Handling:**
   * - ENOENT (file missing): Return config with all defaults (normal on first run)
   * - Other OS errors (EACCES, EIO, etc.): Re-throw (caller should handle)
   * - JSON parse errors: Handled by parseStoredConfig() → returns empty {}
   *
   * @returns Complete ServerConfig with all required keys populated
   * @throws NodeJS.ErrnoException for permission errors, disk I/O errors
   */
  private _loadRaw = async (): Promise<ServerConfig> => {
    try {
      // Step 1: Read entire config file from disk as UTF-8 string
      // This may throw ENOENT if file doesn't exist, or EACCES if no read permission
      const rawContent = await fs.readFile(this.configPath, "utf-8");

      // Step 2: Parse JSON string and merge with defaults
      // parseStoredConfig() handles malformed JSON gracefully by returning {}
      // mergeConfig() fills in any missing keys with SERVER_DEFAULTS
      return mergeConfig(parseStoredConfig(rawContent));
    } catch (error) {
      // Step 3: Examine the specific error to decide how to handle it
      const errorCode = (error as NodeJS.ErrnoException).code;

      // Step 4: ENOENT = file not found (normal on first startup)
      // Return default config as if the file contained {}
      if (errorCode === "ENOENT") {
        return mergeConfig({});
      }

      // Step 5: For other errors (EACCES, EIO, EISDIR, etc.), re-throw
      // Caller should handle these as serious errors (permissions, disk issues)
      throw error;
    }
  };

  /**
   * **PRIVATE** Atomically write config to disk without acquiring mutex (re-entrant safe).
   *
   * **Important:** This method does NOT acquire the mutex. It must ONLY be called
   * from within a mutex.run() block (used by set(), setModel()) to avoid deadlock.
   * If called from a public method, that public method must wrap the call in
   * mutex.run() to serialize file access.
   *
   * **Atomic Writing:**
   * Delegates to atomicWriteJson() which:
   * 1. Creates a temporary file in the same directory
   * 2. Writes the config JSON to the temp file
   * 3. Atomically renames temp file → actual config path
   * 4. If process crashes mid-write, the original file is untouched
   * 5. Ensures config is either fully written or unchanged (no corruption)
   *
   * **Directory Creation:**
   * atomicWriteJson() also ensures the directory exists before writing.
   *
   * **See Also:**
   * - _loadRaw() for the counterpart read operation (also no mutex)
   * - set() and setModel() for typical callers within mutex.run() blocks
   *
   * @param config The ServerConfig object to persist to disk
   * @throws Error if write fails (disk full, permissions, etc.)
   */
  private _saveRaw = async (config: ServerConfig): Promise<void> => {
    // Delegate to utility function which handles atomic writes and directory creation
    // This guarantees the file is either fully written or unchanged on crash
    await atomicWriteJson(this.configPath, config, "config");
  };

  /**
   * Get the configured agent (planning) model name.
   *
   * **Purpose:**
   * Returns the Ollama model name used for task planning and coordination.
   * This model is responsible for breaking down user tasks into a DAG of subtasks.
   *
   * **Validation:**
   * Throws ConfigError if the model is not configured (empty string). This is a
   * required field; the system cannot plan without an agent model.
   *
   * **Model Characteristics:**
   * - Planning model: should be good at logical decomposition
   * - Default temperature: 0.1 (low: focused, deterministic)
   * - Can be set via: `configManager.setModel("agent", "model-name")`
   * - User-facing command: `/set agent model-name`
   *
   * **Fresh Read:**
   * Reads fresh from disk every call; not cached in memory. Ensures consistency
   * if config changes externally.
   *
   * @returns Configured agent model name (non-empty string)
   * @throws {ConfigError} When agent model is not configured (empty string in config)
   *
   * @example
   * ```typescript
   * try {
   *   const model = await configManager.getAgentModel();
   *   console.log(`Planning with: ${model}`);
   * } catch (error) {
   *   if (error instanceof ConfigError) {
   *     console.error("Agent model not configured. User must run: /set agent");
   *   }
   * }
   * ```
   */
  getAgentModel = async (): Promise<string> => {
    // Load fresh config from disk (no caching)
    const config = await this._loadRaw();

    // Extract agent model name and trim accidental whitespace
    const modelName = config.agentModel.trim();

    // Validate that a model is actually configured (not empty string)
    if (modelName.length === 0) {
      throw new ConfigError(
        "No agent model configured. Run /set agent to choose one.",
      );
    }

    // Return the validated model name
    return modelName;
  };

  /**
   * Get the configured subagent (execution) model name.
   *
   * **Purpose:**
   * Returns the Ollama model name used for executing individual subtasks.
   * This model handles code generation, writing, debugging, and tool use.
   *
   * **Validation:**
   * Throws ConfigError if the model is not configured (empty string). This is a
   * required field; the system cannot execute without a subagent model.
   *
   * **Model Characteristics:**
   * - Execution model: should be good at coding and writing
   * - Default temperature: 0.4 (moderate: some creativity, mostly reliable)
   * - Can be set via: `configManager.setModel("subagent", "model-name")`
   * - User-facing command: `/set subagent model-name`
   *
   * **Tool Support:**
   * After getting the model name, check getAgentModelSupportsTools() to determine
   * if the model supports native tool_calls or requires legacy text markers.
   *
   * **Fresh Read:**
   * Reads fresh from disk every call; not cached in memory. Ensures consistency
   * if config changes externally.
   *
   * @returns Configured subagent model name (non-empty string)
   * @throws {ConfigError} When subagent model is not configured (empty string in config)
   *
   * @example
   * ```typescript
   * try {
   *   const model = await configManager.getSubagentModel();
   *   const supportsTools = await configManager.getAgentModelSupportsTools();
   *   console.log(`Executing with: ${model} (tools: ${supportsTools})`);
   * } catch (error) {
   *   if (error instanceof ConfigError) {
   *     console.error("Subagent model not configured. User must run: /set subagent");
   *   }
   * }
   * ```
   */
  getSubagentModel = async (): Promise<string> => {
    // Load fresh config from disk (no caching)
    const config = await this._loadRaw();

    // Extract subagent model name and trim accidental whitespace
    const modelName = config.subagentModel.trim();

    // Validate that a model is actually configured (not empty string)
    if (modelName.length === 0) {
      throw new ConfigError(
        "No subagent model configured. Run /set subagent to choose one.",
      );
    }

    // Return the validated model name
    return modelName;
  };

  getAgentModelSupportsTools = async (): Promise<boolean> => {
    const config = await this._loadRaw();
    return config.agentModelSupportsTools;
  };

  getSubagentModelSupportsTools = async (): Promise<boolean> => {
    const config = await this._loadRaw();
    return config.subagentModelSupportsTools;
  };

  /**
   * Get the temperature setting for the agent (planning) model.
   *
   * **Purpose:** Returns the temperature used when calling the agent model.
   * Temperature controls randomness: lower (toward 0) = more deterministic,
   * higher (toward 1) = more creative/random.
   *
   * **For Planning:** Lower temperatures are preferred (default 0.1) to ensure
   * consistent, predictable task decomposition.
   *
   * **Range:** 0.0 (fully deterministic) to 1.0 (fully random)
   *
   * @returns Agent temperature setting (number between 0.0 and 1.0)
   *
   * @example
   * ```typescript
   * const temp = await configManager.getAgentTemperature();
   * console.log(`Agent planning temperature: ${temp}`); // e.g., "0.1"
   * ```
   */
  getAgentTemperature = async (): Promise<number> => {
    const config = await this._loadRaw();
    return config.agentTemp;
  };

  /**
   * Get the temperature setting for the subagent (execution) model.
   *
   * **Purpose:** Returns the temperature used when calling the subagent model.
   * Controls the creativity/randomness of code generation and writing.
   *
   * **For Execution:** Moderate temperatures (default 0.4) balance reliability
   * with flexibility for code generation and writing tasks.
   *
   * **Range:** 0.0 (fully deterministic) to 1.0 (fully random)
   *
   * @returns Subsubagent temperature setting (number between 0.0 and 1.0)
   *
   * @example
   * ```typescript
   * const temp = await configManager.getSubagentTemperature();
   * console.log(`Subsubagent execution temperature: ${temp}`); // e.g., "0.4"
   * ```
   */
  getSubagentTemperature = async (): Promise<number> => {
    const config = await this._loadRaw();
    return config.subagentTemp;
  };

  /**
   * Get the maximum number of retry attempts for failed subtasks.
   *
   * **Purpose:** When a subagent fails to complete a task (compilation error,
   * syntax error, test failure, etc.), it automatically retries up to this many times,
   * using error feedback to guide the next attempt.
   *
   * **Trade-offs:**
   * - More retries (3–5): Higher chance of success, but longer time-to-result
   * - Fewer retries (1–2): Faster failure detection, but may give up early
   * - Default: 3 retries (good balance)
   *
   * **Typical Range:** 0–5 attempts
   *
   * @returns Maximum retry count (non-negative integer)
   *
   * @example
   * ```typescript
   * const maxRetries = await configManager.getMaxRetries();
   * for (let attempt = 1; attempt <= maxRetries; attempt++) {
   *   try {
   *     await subagent.execute(task);
   *     break; // success
   *   } catch (error) {
   *     if (attempt === maxRetries) throw error;
   *     // retry
   *   }
   * }
   * ```
   */
  getMaxRetries = async (): Promise<number> => {
    const config = await this._loadRaw();
    return config.retries;
  };

  /**
   * Get the temperature setting for a specific role (agent or subagent).
   *
   * **Purpose:** Unified getter that returns temperature based on the role parameter.
   * Useful when you need to select temperature dynamically based on the current context.
   *
   * **Equivalent to:**
   * - role === "agent" ? getAgentTemperature() : getSubagentTemperature()
   *
   * **Parameters:**
   * - "agent": Returns agent temperature (default 0.1, deterministic)
   * - "subagent": Returns subagent temperature (default 0.4, creative)
   *
   * @param role Either "agent" or "subagent"
   * @returns Temperature for the specified role (number between 0.0 and 1.0)
   *
   * @example
   * ```typescript
   * const role: ConfigRole = determineCurrentRole();
   * const temp = await configManager.getTemperature(role);
   * console.log(`Using temperature ${temp} for ${role}`);
   * ```
   */
  getTemperature = async (role: ConfigRole): Promise<number> => {
    const config = await this._loadRaw();
    // Select temperature based on role: agent uses agentTemp, subagent uses subagentTemp
    return role === "agent" ? config.agentTemp : config.subagentTemp;
  };

  /**
   * Get the maximum number of retry attempts for failed subtasks.
   *
   * **Note:** This is an alias for getMaxRetries(). Use getMaxRetries() for clarity.
   *
   * @returns Maximum retry count (non-negative integer)
   * @deprecated Use getMaxRetries() instead for clearer naming
   */
  getRetries = async (): Promise<number> => {
    const config = await this._loadRaw();
    return config.retries;
  };

  /**
   * Get the operation timeout setting in milliseconds.
   *
   * **Purpose:** Maximum time allowed for any task execution before timing out.
   * Prevents hangs on stuck operations (blocked file reads, unresponsive external APIs, etc.).
   *
   * **Trade-offs:**
   * - Longer timeouts (300–600s): Allows complex LLM operations to complete
   * - Shorter timeouts (5–30s): Fast failure, better UX but may interrupt legitimate work
   * - Default: 600_000ms (10 minutes, generous for LLM work)
   *
   * **Typical Range:**
   * - Quick operations: 5,000–10,000ms (5–10s)
   * - Complex LLM tasks: 300,000–600,000ms (5–10 minutes)
   *
   * @returns Timeout in milliseconds (positive number)
   *
   * @example
   * ```typescript
   * const timeoutMs = await configManager.getTimeout();
   * const abortController = new AbortController();
   * const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
   * try {
   *   await operationWithAbort({ signal: abortController.signal });
   * } finally {
   *   clearTimeout(timeoutHandle);
   * }
   * ```
   */
  getTimeout = async (): Promise<number> => {
    const config = await this._loadRaw();
    return config.timeout;
  };

  /**
   * Get the maximum context budget fraction (reserved for system use).
   *
   * **Purpose:** When ContextBuilder constructs LLM context windows, it reserves
   * this fraction of the total context for system messages and metadata, leaving
   * the remainder for user preferences, session history, and the current task.
   *
   * **How It's Used:**
   * ContextBuilder reserves `maxContextBudget * tokenLimit` tokens for:
   * - System prompts and role definitions
   * - Tool schemas and descriptions
   * - Metadata and formatting
   *
   * The remaining tokens go to:
   * - User preferences and rules
   * - Conversation history
   * - Current task and context
   *
   * **Trade-offs:**
   * - Higher budget (0.3–0.4): More room for system messages, less for user context
   * - Lower budget (0.1–0.15): Less system overhead, more space for task context
   * - Default: 0.2 (20% reserved, 80% for user/task context)
   *
   * **Typical Range:** 0.1–0.4 (10%–40% reservation)
   *
   * @returns Max context budget as fraction (number between 0.0 and 1.0)
   *
   * @example
   * ```typescript
   * const budget = await configManager.getMaxContextBudget();
   * const modelContextLimit = 4096; // tokens
   * const systemReserve = Math.floor(budget * modelContextLimit);
   * const availableForContext = modelContextLimit - systemReserve;
   * console.log(`System: ${systemReserve} tokens, Context: ${availableForContext} tokens`);
   * ```
   */
  getMaxContextBudget = async (): Promise<number> => {
    const config = await this._loadRaw();
    return config.maxContextBudget;
  };

  /**
   * Get the complete server configuration.
   *
   * **Purpose:** Returns the full ServerConfig object with all settings.
   * Useful for comprehensive configuration inspection or debugging.
   *
   * **Contents:**
   * - subagentModel, subagentModel (model names)
   * - subagentModelSupportsTools, subagentModelSupportsTools (capability flags)
   * - agentTemp, subagentTemp (temperature settings)
   * - retries (retry attempts)
   * - timeout (operation timeout)
   * - maxContextBudget (context reservation)
   * - lastConsolidatedAt (optional: timestamp of last preference consolidation)
   *
   * **Performance Note:**
   * Returns a fresh read from disk each time. If you need multiple values,
   * call getAll() once and extract what you need, rather than calling
   * individual getters multiple times.
   *
   * @returns Complete ServerConfig object with all configuration values
   *
   * @example
   * ```typescript
   * const config = await configManager.getAll();
   * console.log(JSON.stringify(config, null, 2));
   * // {
   * //   subagentModel: "llama2",
   * //   subagentModel: "mistral",
   * //   agentTemp: 0.1,
   * //   subagentTemp: 0.4,
   * //   retries: 3,
   * //   timeout: 600000,
   * //   maxContextBudget: 0.2,
   * //   ...
   * // }
   * ```
   */
  getAll = async (): Promise<ServerConfig> => {
    return this._loadRaw();
  };

  /**
   * Update a single writable configuration key and persist to disk.
   *
   * **Purpose:**
   * Atomically updates one configuration value (temperature, retries, timeout, etc.)
   * and saves the entire config to disk. This is the main way to modify config
   * other than model names (which use setModel() for cache invalidation).
   *
   * **Writable Keys:**
   * Only keys in WRITABLE_CONFIG_KEYS can be modified:
   * - agentTemp, subagentTemp (temperature: 0–1)
   * - subagentModelSupportsTools, subagentModelSupportsTools (boolean)
   * - retries (non-negative integer)
   * - timeout (non-negative milliseconds)
   * - maxContextBudget (0–1 fraction)
   * - lastConsolidatedAt (ISO string)
   *
   * **Not Writable:**
   * - subagentModel, subagentModel: Use setModel() instead (triggers cache invalidation)
   *
   * **Validation:**
   * 1. Key must be in WRITABLE_CONFIG_KEYS list (throws if not)
   * 2. Value must match expected type for the key
   * 3. Value must be in valid range (e.g., temp 0–1, retries >= 0)
   * 4. Throws ConfigError with details if validation fails
   *
   * **Atomicity:**
   * The entire operation is atomic via mutex.run():
   * - Load current config
   * - Update one key
   * - Save atomically (temp file + rename)
   * - If crash occurs, disk file is unchanged
   *
   * **Called By:**
   * - Router.config.set command handler
   * - ContextBuilder (via cache invalidation callback)
   *
   * @param key Configuration key name (e.g., "agentTemp", "timeout")
   * @param value New value for the key (type depends on key)
   * @throws {ConfigError} If key is not writable or value fails validation
   *
   * @example
   * ```typescript
   * // Set subagent temperature to 0.2
   * await configManager.set("agentTemp", 0.2);
   *
   * // Set retry attempts
   * await configManager.set("retries", 5);
   *
   * // Set timeout to 30 seconds
   * await configManager.set("timeout", 30_000);
   *
   * // These throw ConfigError:
   * await configManager.set("subagentModel", "llama2"); // Not writable, use setModel
   * await configManager.set("agentTemp", 1.5);      // Out of range (0–1)
   * await configManager.set("retries", -1);         // Invalid (must be >= 0)
   * ```
   */
  set = async (key: string, value: unknown): Promise<void> => {
    return this.mutex.run(async () => {
      // Step 1: Validate that the requested key is writable
      // WRITABLE_CONFIG_KEYS is a whitelist of keys that can be modified
      // subagentModel and subagentModel are NOT writable here (use setModel instead)
      if (
        !WRITABLE_CONFIG_KEYS.includes(
          key as (typeof WRITABLE_CONFIG_KEYS)[number],
        )
      ) {
        throw new ConfigError(`Invalid config key: ${key}`);
      }

      // Step 2: Validate value type and range based on which key is being set
      // Each key has specific constraints that must be satisfied

      if (key === "agentTemp" || key === "subagentTemp") {
        // Temperature must be a number between 0 (deterministic) and 1 (random)
        if (typeof value !== "number") {
          throw new ConfigError(`${key} must be a number`);
        }
        if (value < 0 || value > 1) {
          throw new ConfigError(`${key} must be between 0 and 1`);
        }
      } else if (key === "retries") {
        // Retries must be a non-negative integer (0, 1, 2, 3, ...)
        if (typeof value !== "number") {
          throw new ConfigError(`retries must be a number`);
        }
        if (value < 0 || !Number.isInteger(value)) {
          throw new ConfigError(`retries must be a non-negative integer`);
        }
      } else if (key === "timeout") {
        // Timeout must be a non-negative number of milliseconds
        if (typeof value !== "number") {
          throw new ConfigError(`timeout must be a number`);
        }
        if (value < 0) {
          throw new ConfigError(`timeout must be non-negative`);
        }
      } else if (key === "maxContextBudget") {
        // Context budget must be a fraction between 0 and 1 (0% to 100%)
        if (typeof value !== "number") {
          throw new ConfigError(`maxContextBudget must be a number`);
        }
        if (value < 0 || value > 1) {
          throw new ConfigError(`maxContextBudget must be between 0 and 1`);
        }
      } else if (
        key === "subagentModelSupportsTools" ||
        key === "subagentModelSupportsTools"
      ) {
        // Tool support flags must be exactly true or false
        if (typeof value !== "boolean") {
          throw new ConfigError(`${key} must be a boolean`);
        }
      } else if (key === "lastConsolidatedAt") {
        // Consolidation timestamp must be an ISO string (e.g., "2024-01-15T10:30:00Z")
        if (typeof value !== "string") {
          throw new ConfigError(
            `lastConsolidatedAt must be a string (ISO timestamp)`,
          );
        }
      }

      // Step 3: Load current configuration from disk (read-fresh approach)
      // We use _loadRaw directly because we're already holding the mutex via mutex.run()
      // This avoids a re-entrant call to mutex.acquire() which would deadlock
      const config = await this._loadRaw();

      // Step 4: Create new config object with the updated key value
      // Uses object spread: {...config} copies all current values, then [key]: value
      // overwrites just the key we're modifying. All other keys stay unchanged.
      // Cast to ServerConfig to satisfy TypeScript (the key/value pair is valid by validation above)
      const nextConfig = { ...config, [key]: value } as ServerConfig;

      // Step 5: Persist the updated configuration atomically to disk
      // We use _saveRaw directly for the same reason as _loadRaw above
      // Atomic write ensures the file is either fully updated or unchanged (no corruption)
      await this._saveRaw(nextConfig);
    });
  };

  /**
   * Update the agent or subagent model name and trigger cache invalidation.
   *
   * **Purpose:**
   * Sets the Ollama model name for either the agent (planner) or subagent (executor),
   * and notifies the cache invalidation callback so ContextBuilder knows to refresh
   * its model-specific caches (token counts, capabilities, etc.).
   *
   * **Two Roles:**
   * - "agent": Task planning model (used to decompose tasks into subtasks)
   * - "subagent": Task execution model (used to execute individual subtasks)
   *
   * **Key Behavior:**
   * 1. Trims whitespace from model name (allows " llama2 " → "llama2")
   * 2. Validates model name is not empty
   * 3. Loads current config from disk
   * 4. Saves new config atomically
   * 5. **Calls onModelChanged() callback if model actually changed**
   *    - Callback receives: oldModel (previous name) and role ("agent" or "subagent")
   *    - ContextBuilder uses this to clear cached token counts, capabilities, etc.
   *
   * **Why Separate from set()?**
   * Model changes are special because ContextBuilder caches model-specific information.
   * When the model changes, those caches become invalid. The onModelChanged callback
   * allows cache holders to clear stale data.
   *
   * **Atomicity:**
   * The entire operation is atomic via mutex.run():
   * - Load current config
   * - Update model name
   * - Save atomically
   * - Call callback (only if changed)
   *
   * **Validation:**
   * - Model name must not be empty (throws ConfigError)
   * - Model name is NOT validated against available Ollama models
   *   (validation happens when the model is actually used)
   *
   * **Cache Invalidation Flow:**
   * ```
   * setModel("agent", "llama2")
   *   → Load config
   *   → Save config with agentModel: "llama2"
   *   → onModelChanged?.("previous-model", "agent")
   *     → ContextBuilder clears agentModel caches
   *     → Next context build fetches token limits from new model
   * ```
   *
   * **Called By:**
   * - Router.model.set command handler
   * - Initialization code (first model setup)
   * - Admin scripts
   *
   * @param role Which model to update: "agent" or "subagent"
   * @param modelName The new Ollama model name (will be trimmed of whitespace)
   * @throws {ConfigError} If model name is empty (only whitespace)
   *
   * @example
   * ```typescript
   * // Set agent model to llama2
   * await configManager.setModel("agent", "llama2");
   * // → onModelChanged("previous-model", "agent") called if changed
   *
   * // Set subagent model with whitespace (auto-trimmed)
   * await configManager.setModel("subagent", "  mistral  ");
   * // → stored as "mistral", onModelChanged called if changed
   *
   * // This throws ConfigError:
   * await configManager.setModel("agent", "");      // empty
   * await configManager.setModel("agent", "   ");   // whitespace only
   * ```
   */
  setModel = async (role: ConfigRole, modelName: string): Promise<void> => {
    return this.mutex.run(async () => {
      // Step 1: Trim accidental whitespace from the provided model name
      // This allows callers to pass " llama2 " without failing validation
      const trimmedModelName = modelName.trim();

      // Step 2: Validate that the model name is not empty or whitespace-only
      // Empty model names are invalid; the model slot should remain empty ("") if unconfigured
      if (trimmedModelName.length === 0) {
        throw new ConfigError(
          role === "agent"
            ? "Agent model name cannot be empty."
            : "Subagent model name cannot be empty.",
        );
      }

      // Step 3: Load current configuration from disk (fresh read)
      // We use _loadRaw directly because we're already holding the mutex
      // This avoids re-entrant calls to mutex.acquire() which would deadlock
      const config = await this._loadRaw();

      // Step 4: Save the PREVIOUS model name for the specified role
      // This is sent to the onModelChanged callback so listeners can invalidate caches
      // Example: previousModel = "llama2" when switching to "mistral"
      const previousModel =
        role === "agent" ? config.agentModel : config.subagentModel;

      // Step 5: Create new config object with the updated model name
      // Uses conditional to select which field to update (agentModel or subagentModel)
      // Spreads all other config values unchanged
      const nextConfig: ServerConfig =
        role === "agent"
          ? { ...config, agentModel: trimmedModelName }
          : { ...config, subagentModel: trimmedModelName };

      // Step 6: Persist the new configuration to disk atomically
      // We use _saveRaw directly for the same reason as _loadRaw above
      // If the process crashes during write, the original config file is unchanged
      await this._saveRaw(nextConfig);

      // Step 7: Notify listeners of the model change (only if it actually changed)
      // This callback allows ContextBuilder and other services to invalidate
      // model-specific caches (token counts, capabilities, formatting rules, etc.)
      // Example flow:
      //   - Caller invokes setModel("agent", "mistral")
      //   - Config is saved with agentModel: "mistral"
      //   - onModelChanged is called with ("llama2", "agent")
      //   - ContextBuilder clears cached tokenCounts["llama2"]
      //   - Next context build uses "mistral" and fetches fresh token data
      if (previousModel !== trimmedModelName) {
        this.onModelChanged?.(previousModel, role);
      }
    });
  };

  /**
   * Get the provider name currently serving the agent (planning) role.
   *
   * @returns Provider name (e.g. "ollama", "vllm-gpu"); defaults to "ollama".
   */
  getAgentProvider = async (): Promise<string> => {
    const config = await this._loadRaw();
    return config.agentProvider;
  };

  /**
   * Get the provider name currently serving the subagent (execution) role.
   *
   * @returns Provider name (e.g. "ollama", "vllm-gpu"); defaults to "ollama".
   */
  getSubagentProvider = async (): Promise<string> => {
    const config = await this._loadRaw();
    return config.subagentProvider;
  };

  /**
   * Look up one provider's connection details.
   *
   * @param name Provider name (never "ollama" — that provider is built in
   *   and never stored here).
   * @returns Connection details, or undefined if not configured.
   */
  getProvider = async (
    name: string,
  ): Promise<{ baseUrl: string; apiKey?: string } | undefined> => {
    const config = await this._loadRaw();
    return config.providers[name];
  };

  /**
   * Get all configured non-Ollama providers.
   *
   * @returns Provider map keyed by name.
   */
  getProviders = async (): Promise<
    Record<string, { baseUrl: string; apiKey?: string }>
  > => {
    const config = await this._loadRaw();
    return config.providers;
  };

  /**
   * Add or update a non-Ollama provider entry.
   *
   * @param name Provider name (must not be empty or "ollama", which is reserved).
   * @param providerConfig Connection details for the provider.
   * @throws {ConfigError} If name is empty, reserved, or baseUrl is empty.
   */
  addProvider = async (
    name: string,
    providerConfig: { baseUrl: string; apiKey?: string },
  ): Promise<void> => {
    return this.mutex.run(async () => {
      const trimmedName = name.trim();
      if (trimmedName.length === 0) {
        throw new ConfigError("Provider name cannot be empty.");
      }
      if (trimmedName === "ollama") {
        throw new ConfigError("'ollama' is a reserved provider name.");
      }
      const baseUrl = providerConfig.baseUrl?.trim() ?? "";
      if (baseUrl.length === 0) {
        throw new ConfigError("Provider baseUrl cannot be empty.");
      }
      const apiKey = providerConfig.apiKey?.trim();

      const config = await this._loadRaw();
      const nextProviders = {
        ...config.providers,
        [trimmedName]: apiKey ? { baseUrl, apiKey } : { baseUrl },
      };
      await this._saveRaw({ ...config, providers: nextProviders });
    });
  };

  /**
   * Remove a non-Ollama provider entry.
   *
   * @param name Provider name to remove.
   * @throws {ConfigError} If name is "ollama", not configured, or currently
   *   in use by the agent or subagent role.
   */
  removeProvider = async (name: string): Promise<void> => {
    return this.mutex.run(async () => {
      const trimmedName = name.trim();
      if (trimmedName === "ollama") {
        throw new ConfigError("Cannot remove the built-in 'ollama' provider.");
      }
      const config = await this._loadRaw();
      if (!config.providers[trimmedName]) {
        throw new ConfigError(`Provider '${trimmedName}' is not configured.`);
      }
      if (
        config.agentProvider === trimmedName ||
        config.subagentProvider === trimmedName
      ) {
        throw new ConfigError(
          `Provider '${trimmedName}' is in use. Switch agent/subagent to another provider first.`,
        );
      }
      const nextProviders = { ...config.providers };
      delete nextProviders[trimmedName];
      await this._saveRaw({ ...config, providers: nextProviders });
    });
  };

  /**
   * Update which provider serves a role, without changing its model.
   *
   * @param role Which role to update: "agent" or "subagent".
   * @param providerName Provider name; must be "ollama" or a name already in `providers`.
   * @throws {ConfigError} If providerName is empty or not configured.
   */
  setProvider = async (
    role: ConfigRole,
    providerName: string,
  ): Promise<void> => {
    return this.mutex.run(async () => {
      const trimmedProvider = providerName.trim();
      if (trimmedProvider.length === 0) {
        throw new ConfigError("Provider name cannot be empty.");
      }
      const config = await this._loadRaw();
      if (trimmedProvider !== "ollama" && !config.providers[trimmedProvider]) {
        throw new ConfigError(
          `Provider '${trimmedProvider}' is not configured. Run /providers add ${trimmedProvider} first.`,
        );
      }
      const nextConfig: ServerConfig =
        role === "agent"
          ? { ...config, agentProvider: trimmedProvider }
          : { ...config, subagentProvider: trimmedProvider };
      await this._saveRaw(nextConfig);
    });
  };

  /**
   * Update both the provider and model for a role in one atomic write, and
   * trigger the same cache-invalidation callback as setModel().
   *
   * @param role Which role to update: "agent" or "subagent".
   * @param providerName Provider name; must be "ollama" or a name already in `providers`.
   * @param modelName The new model name (will be trimmed of whitespace).
   * @throws {ConfigError} If providerName is empty/unconfigured or modelName is empty.
   */
  setRoleModel = async (
    role: ConfigRole,
    providerName: string,
    modelName: string,
  ): Promise<void> => {
    return this.mutex.run(async () => {
      const trimmedProvider = providerName.trim();
      const trimmedModelName = modelName.trim();
      if (trimmedProvider.length === 0) {
        throw new ConfigError("Provider name cannot be empty.");
      }
      if (trimmedModelName.length === 0) {
        throw new ConfigError(
          role === "agent"
            ? "Agent model name cannot be empty."
            : "Subagent model name cannot be empty.",
        );
      }

      const config = await this._loadRaw();
      if (trimmedProvider !== "ollama" && !config.providers[trimmedProvider]) {
        throw new ConfigError(
          `Provider '${trimmedProvider}' is not configured. Run /providers add ${trimmedProvider} first.`,
        );
      }

      const previousModel =
        role === "agent" ? config.agentModel : config.subagentModel;

      const nextConfig: ServerConfig =
        role === "agent"
          ? {
              ...config,
              agentModel: trimmedModelName,
              agentProvider: trimmedProvider,
            }
          : {
              ...config,
              subagentModel: trimmedModelName,
              subagentProvider: trimmedProvider,
            };

      await this._saveRaw(nextConfig);

      if (previousModel !== trimmedModelName) {
        this.onModelChanged?.(previousModel, role);
      }
    });
  };
}
