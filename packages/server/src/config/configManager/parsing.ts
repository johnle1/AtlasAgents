/**
 * Boundary parsing: turns raw disk JSON into a validated `ServerConfig`.
 * Every field is coerced through a small typed helper (`asString`,
 * `asNumber`, `asBoolean`, `storedModel`, `asProviders`) so `mergeConfig`
 * always returns a fully-populated, type-safe object — this is the only
 * place in the config module that trusts unvalidated `unknown` data.
 */

import { SERVER_DEFAULTS, type ServerConfig } from "./types.js";

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
export const parseStoredConfig = (rawContent: string): Record<string, unknown> => {
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
 * validate model capability flags (agentModelSupportsTools, subagentModelSupportsTools).
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
 * - **Model names** (agentModel, subagentModel): Extracted via storedModel()
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
 *   agentModel: "llama2",
 *   subagentModel: "mistral",
 *   agentTemp: 0.2,
 *   // ... etc
 * });
 * // → {agentModel: "llama2", subagentModel: "mistral", agentTemp: 0.2, retries: 3, ...}
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
export const mergeConfig = (storedConfig: Record<string, unknown>): ServerConfig => {
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
 *   server restart. Model names (agentModel, subagentModel) are excluded as
 *   they require special handling via setModel() for cache invalidation.
 *
 * Used by:
 *   - set — validates that the requested key is writable.
 *
 * Excluded from this list:
 *   - agentModel, subagentModel — require setModel() for cache invalidation.
 * </Summary>
 */
export const WRITABLE_CONFIG_KEYS = [
  "agentTemp",
  "subagentTemp",
  "agentModelSupportsTools",
  "subagentModelSupportsTools",
  "retries",
  "timeout",
  "maxContextBudget",
  "lastConsolidatedAt",
] as const satisfies ReadonlyArray<keyof ServerConfig>;
