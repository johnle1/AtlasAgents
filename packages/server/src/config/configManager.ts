import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteJson } from "../utils/atomicWriteJson.js";
import type { IConfigManager } from "../orchestration/interfaces.js";
import {
  ConfigDecryptionError,
  decryptSecrets,
  encryptSecrets,
  initializeCipher,
  isUnlocked,
  rotateKey,
  unlockCipher,
  type SecretsEnvelope,
} from "@atlasagents/shared";
import { Mutex } from "./mutex.js";
import {
  CONFIG_REL_PATH,
  EXISTING_PASSPHRASE_LABEL,
  MAX_PASSPHRASE_ATTEMPTS,
  NEW_PASSPHRASE_LABEL,
  ConfigError,
  type ServerConfig,
  type ConfigRole,
} from "./types.js";
import {
  parseStoredConfig,
  mergeConfig,
  normaliseKeepAlive,
  WRITABLE_CONFIG_KEYS,
} from "./parsing.js";

/**
 * Server-wide configuration manager for models, timeouts, and behavior settings.
 *
 * **Responsibility:**
 * - Reads/writes `./user-data/config.json` relative to the server process cwd
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
 * const agentModel = await configManager.getAgentModel(); // throws if not set
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

      // Step 2: Parse JSON string
      // parseStoredConfig() handles malformed JSON gracefully by returning {}
      const storedConfig = parseStoredConfig(rawContent);

      // Step 2b: Provider apiKey/baseUrl entries are encrypted at rest under
      // $providersSecrets. Decrypt them back into storedConfig.providers
      // before mergeConfig()'s existing asProviders() validation runs, so
      // that logic doesn't need to know about the envelope at all. A file
      // with no $providersSecrets (e.g. defaults-only, no providers yet) is
      // left as-is — the next _saveRaw() call writes the envelope when
      // providers are first saved. Decryption errors (locked cipher, wrong
      // passphrase, tampered data) deliberately propagate below rather than
      // being treated like a missing file — see the ENOENT-only check in
      // the catch block. The message is annotated with where it came from
      // first: this getter may be reached from any config read (e.g.
      // getAgentModel()), and without that context a bare "Config cipher is
      // locked" error gives an operator no hint that provider secrets —
      // not the field they asked for — are what's actually blocked.
      if (storedConfig.$providersSecrets) {
        try {
          storedConfig.providers = decryptSecrets(
            storedConfig.$providersSecrets as SecretsEnvelope,
          );
        } catch (error) {
          if (error instanceof Error) {
            error.message = `Provider secrets decryption failed while loading config: ${error.message}`;
          }
          throw error;
        }
      }

      // Step 3: Merge with defaults — fills in any missing keys with SERVER_DEFAULTS
      return mergeConfig(storedConfig);
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
    // Provider apiKey/baseUrl entries are sensitive — encrypt them into a
    // single envelope rather than writing them as plaintext JSON. `set()`
    // writes every field through this same path, including plenty that have
    // nothing to do with providers (numCtx, keepAlive, agentTemp, ...), so
    // skip the cipher requirement — and the `$providersSecrets` envelope —
    // for the one case where neither is actually needed: nothing to encrypt
    // (`providers` is empty) AND no passphrase has been established this
    // process (`!isUnlocked()`). That's exactly a fresh, standalone process
    // that never called unlockOrSetupProvidersCipher — e.g. a standalone
    // script writing config fields directly — which otherwise failed every
    // write with ConfigCipherLockedError for a field with no secret in it.
    //
    // Once a passphrase HAS been established (isUnlocked() is true — e.g.
    // right after `unlockOrSetupProvidersCipher`'s reset flow calls
    // initializeCipher), keep writing the envelope even with empty
    // providers: `unlockOrSetupProvidersCipher` uses its *presence* on disk
    // to decide whether to prompt for an existing passphrase (case 2) or
    // offer first-time setup (case 1) on the next run, and losing that
    // marker would make a deliberately-reset, still-passphrase-protected
    // file indistinguishable from one that was never protected at all.
    const { providers, ...rest } = config;
    const hasProviders = Object.keys(providers).length > 0;
    const onDisk =
      hasProviders || isUnlocked()
        ? { ...rest, $providersSecrets: encryptSecrets(providers) }
        : rest;

    // Delegate to utility function which handles atomic writes and directory creation
    // This guarantees the file is either fully written or unchanged on crash
    await atomicWriteJson(this.configPath, onDisk, "config");
  };

  /**
   * Offers a menu to reset the encrypted provider secrets after repeated
   * wrong passphrase attempts, rather than looping forever with no way out.
   *
   * @remarks
   * Reuses the same injected `promptPassphrase` callback for the menu and
   * confirmation text — no new parameter, so existing call sites/tests are
   * unaffected. "Reset" backs up the current file (so the choice isn't
   * quite as irreversible as the confirmation text says — the encrypted
   * backup survives in case the passphrase is remembered later), strips the
   * `$providersSecrets` envelope, and writes everything else back unchanged.
   *
   * @param promptPassphrase - The injected prompt callback.
   * @param stored - The already-parsed on-disk object; every field except
   *   `$providersSecrets`/`providers` is preserved across a reset.
   * @returns `"unlocked"` if the user reset (cipher is now ready to use
   *   with a fresh passphrase); `"retry"` if the caller should go back to
   *   prompting for the original passphrase (chose "try again", or backed
   *   out of the reset confirmation).
   * @throws {Error} When the user chooses to quit.
   */
  private offerProvidersPassphraseReset = async (
    promptPassphrase: (label: string) => Promise<string>,
    stored: Record<string, unknown>,
  ): Promise<"unlocked" | "retry"> => {
    const choice = (
      await promptPassphrase(
        `Wrong passphrase ${MAX_PASSPHRASE_ATTEMPTS} times in a row.\n` +
          "  [r] Reset — discard the encrypted provider API keys and set a new passphrase now\n" +
          "  [t] Try again\n" +
          "  [q] Quit\n" +
          "Choose [r/t/q]: ",
      )
    )
      .trim()
      .toLowerCase()
      .charAt(0);

    if (choice === "q") {
      throw new Error("Aborted: provider-secrets passphrase not entered.");
    }
    if (choice !== "r") {
      return "retry";
    }

    const confirmed =
      (
        await promptPassphrase(
          "This will permanently discard your saved provider API keys. " +
            'This cannot be undone.\nType "yes" to confirm, or anything else to cancel: ',
        )
      )
        .trim()
        .toLowerCase() === "yes";
    if (!confirmed) {
      return "retry";
    }

    const backupPath = `${this.configPath}.bak-${Date.now()}`;
    await fs.copyFile(this.configPath, backupPath);
    await fs.chmod(backupPath, 0o600);

    const {
      $providersSecrets: _oldSecrets,
      providers: _oldProviders,
      ...rest
    } = stored;
    initializeCipher(await promptPassphrase(NEW_PASSPHRASE_LABEL));
    await this._saveRaw(mergeConfig(rest));

    process.stderr.write(
      "Reset. Your provider API keys were cleared — re-add them with " +
        `/providers add. Your previous encrypted config was backed up to ${backupPath}.\n`,
    );
    return "unlocked";
  };

  /**
   * Prompts for a passphrase and unlocks the provider-secrets cipher.
   *
   * @remarks
   * Must be called once, before any other method on this instance, at
   * server startup — {@link _loadRaw}/{@link _saveRaw} depend on the cipher
   * already being unlocked. Three cases, mirroring the client's
   * `unlockOrSetupConfigCipher` in `packages/client/src/config.ts`:
   *
   * 0. **Cipher already unlocked**: the server entry point unlocks the
   *    shared cipher once, up front, via `startupSecrets.ts`'s
   *    `unlockOrSetupStartupCipher` — which protects the auth password and
   *    port under the very same key/salt as this method protects
   *    `providers` under. Prompting a second time for the same passphrase
   *    would be redundant, so this returns immediately. Standalone callers
   *    that never unlock anything else first (most unit tests) are
   *    unaffected — `isUnlocked()` is false for them, so they fall through
   *    to the normal prompting flow below.
   * 1. **No config file yet** (first run), or a file with no
   *    `$providersSecrets` yet: prompts to set a new passphrase and
   *    initializes the cipher. The first {@link _saveRaw} call creates the
   *    encrypted envelope when providers are saved.
   * 2. **config file has `$providersSecrets`**: prompts for the existing
   *    passphrase and unlocks against it, re-prompting on a wrong entry.
   *    After {@link MAX_PASSPHRASE_ATTEMPTS} consecutive wrong entries,
   *    offers a reset menu (see {@link offerProvidersPassphraseReset})
   *    rather than looping forever with no way out for an operator who's
   *    forgotten it.
   *
   * @param promptPassphrase - Injected prompt function (e.g. the server's
   *   existing masked-input startup prompt), for testability and so this
   *   module doesn't need its own TTY-handling code.
   */
  unlockOrSetupProvidersCipher = async (
    promptPassphrase: (label: string) => Promise<string>,
  ): Promise<void> => {
    if (isUnlocked()) {
      return;
    }

    const promptNewPassphrase = () => promptPassphrase(NEW_PASSPHRASE_LABEL);

    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.configPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        initializeCipher(await promptNewPassphrase());
        return;
      }
      throw error;
    }

    const stored = parseStoredConfig(rawContent);

    if (stored.$providersSecrets) {
      const envelope = stored.$providersSecrets as SecretsEnvelope;
      let wrongAttempts = 0;
      for (;;) {
        const passphrase = await promptPassphrase(EXISTING_PASSPHRASE_LABEL);
        try {
          unlockCipher(passphrase, envelope);
          return;
        } catch (error) {
          if (!(error instanceof ConfigDecryptionError)) {
            throw error;
          }
          wrongAttempts += 1;
          if (wrongAttempts < MAX_PASSPHRASE_ATTEMPTS) {
            process.stderr.write("Wrong passphrase. Try again.\n");
            continue;
          }
          if (
            (await this.offerProvidersPassphraseReset(
              promptPassphrase,
              stored,
            )) === "unlocked"
          ) {
            return;
          }
          wrongAttempts = 0;
        }
      }
    }

    // Config exists but has no $providersSecrets yet (defaults-only file).
    initializeCipher(await promptNewPassphrase());
  };

  /**
   * Rotates the passphrase protecting persisted provider secrets, re-encrypting
   * them under a fresh salt/key without losing the existing provider API keys.
   *
   * @remarks
   * Requires `currentPassphrase` explicitly rather than trusting whatever the
   * cipher happens to already be unlocked with — the same discipline as
   * changing a password normally requires re-entering the old one, so a
   * process left unlocked and unattended can't have its provider secrets
   * rotated by anyone who doesn't actually know the current passphrase.
   *
   * If persisting the re-encrypted config fails (disk full, permissions),
   * the in-memory cipher is rolled back to `currentPassphrase` so it stays
   * consistent with what's actually on disk — otherwise a failed rotation
   * would leave the running server holding a key that can no longer decrypt
   * its own config file until the next restart.
   *
   * @param currentPassphrase - The passphrase currently protecting the
   *   on-disk `$providersSecrets` envelope.
   * @param newPassphrase - The passphrase to rotate to.
   * @throws {ConfigError} When no config file exists yet, or no provider
   *   secrets have ever been encrypted (nothing to rotate).
   * @throws {ConfigDecryptionError} When `currentPassphrase` is wrong.
   *
   * @example
   * ```typescript
   * await configManager.rotateProvidersPassphrase("old-pass", "new-pass");
   * // Provider API keys are unchanged; the passphrase to unlock them is not.
   * ```
   */
  rotateProvidersPassphrase = async (
    currentPassphrase: string,
    newPassphrase: string,
  ): Promise<void> => {
    return this.mutex.run(async () => {
      let rawContent: string;
      try {
        rawContent = await fs.readFile(this.configPath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ConfigError(
            "No config file exists yet — nothing to rotate.",
          );
        }
        throw error;
      }

      const stored = parseStoredConfig(rawContent);
      const envelope = stored.$providersSecrets as SecretsEnvelope | undefined;
      if (!envelope) {
        throw new ConfigError(
          "No provider secrets are encrypted yet — nothing to rotate.",
        );
      }

      // Verifies currentPassphrase against the on-disk envelope, decrypts
      // it, and swaps the cipher's cached key to a fresh derivation of
      // newPassphrase — throws ConfigDecryptionError before any of that
      // swap happens if currentPassphrase is wrong.
      const plaintextProviders = rotateKey<
        Record<string, { baseUrl: string; apiKey?: string }>
      >(currentPassphrase, newPassphrase, envelope);

      try {
        const nextConfig = mergeConfig({
          ...stored,
          providers: plaintextProviders,
        });
        await this._saveRaw(nextConfig);
      } catch (saveError) {
        // Roll back so the cached key matches what's actually on disk.
        unlockCipher(currentPassphrase, envelope);
        throw saveError;
      }
    });
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
   * After getting the model name, check getSubagentModelSupportsTools() to determine
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
   *   const supportsTools = await configManager.getSubagentModelSupportsTools();
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
   * Get whether the agent model supports Ollama's extended `think` mode.
   *
   * @remarks
   * Probed via `syncAgentThinkingSupport` at startup and whenever the agent
   * model changes, then cached here. Ollama rejects `think: true` outright
   * for models that don't advertise the `"thinking"` capability, so the
   * agent must check this before requesting it.
   *
   * @returns True if the agent model supports Ollama's `think` mode.
   */
  getAgentModelSupportsThinking = async (): Promise<boolean> => {
    const config = await this._loadRaw();
    return config.agentModelSupportsThinking;
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
   * @returns Subagent temperature setting (number between 0.0 and 1.0)
   *
   * @example
   * ```typescript
   * const temp = await configManager.getSubagentTemperature();
   * console.log(`Subagent execution temperature: ${temp}`); // e.g., "0.4"
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
   * Get the configured Ollama runtime context window (`num_ctx`), if set.
   *
   * @remarks
   * Undefined means "not configured" — callers should fall back to Ollama's
   * own default (4096) rather than guessing a value. Set via `/set numCtx`.
   *
   * @returns Configured `num_ctx` in tokens, or `undefined` if unset.
   */
  getNumCtx = async (): Promise<number | undefined> => {
    const config = await this._loadRaw();
    return config.numCtx;
  };

  /**
   * Get the configured Ollama `keep_alive` duration.
   *
   * @remarks
   * Controls how long Ollama keeps a model resident in VRAM after use.
   * Defaults to `"30m"` — see {@link SERVER_DEFAULTS.keepAlive}.
   *
   * @returns Duration string with a unit (e.g. `"30m"`), or the number `-1`
   *   to never unload. Never the string `"-1"` — Ollama rejects that, so
   *   `set()` and the disk merge both normalize it to the number.
   */
  getKeepAlive = async (): Promise<string | number> => {
    const config = await this._loadRaw();
    return config.keepAlive;
  };

  /**
   * Get the complete server configuration.
   *
   * **Purpose:** Returns the full ServerConfig object with all settings.
   * Useful for comprehensive configuration inspection or debugging.
   *
   * **Contents:**
   * - agentModel, subagentModel (model names)
   * - agentModelSupportsTools, subagentModelSupportsTools (capability flags)
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
   * //   agentModel: "llama2",
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
   * - agentModelSupportsTools, subagentModelSupportsTools (boolean)
   * - retries (non-negative integer)
   * - timeout (non-negative milliseconds)
   * - maxContextBudget (0–1 fraction)
   * - lastConsolidatedAt (ISO string)
   *
   * **Not Writable:**
   * - agentModel, subagentModel: Use setModel() instead (triggers cache invalidation)
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
   * // Set agent temperature to 0.2
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
      // agentModel and subagentModel are NOT writable here (use setModel instead)
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
        key === "agentModelSupportsTools" ||
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
      } else if (key === "numCtx") {
        // Ollama runtime context window must be a positive integer token count
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new ConfigError(`numCtx must be a number`);
        }
        if (value <= 0 || !Number.isInteger(value)) {
          throw new ConfigError(`numCtx must be a positive integer`);
        }
      } else if (key === "keepAlive") {
        // Ollama keep_alive: a duration string with a unit ("30m", "1h",
        // "90s"), or -1 to never unload. Accepting any non-empty string let a
        // value through that Ollama's Go duration parser rejects, 400-ing
        // every model request until the config was hand-edited. `"-1"` is
        // normalized to the number, which is the only form Ollama honors.
        const normalisedKeepAlive = normaliseKeepAlive(value);
        if (normalisedKeepAlive === null) {
          throw new ConfigError(
            `keepAlive must be an Ollama duration like "30m", "1h" or "90s", or -1 to never unload`,
          );
        }
        value = normalisedKeepAlive;
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
   * @returns Provider name (e.g. "ollama", "lmstudio"); defaults to "ollama".
   */
  getAgentProvider = async (): Promise<string> => {
    const config = await this._loadRaw();
    return config.agentProvider;
  };

  /**
   * Get the provider name currently serving the subagent (execution) role.
   *
   * @returns Provider name (e.g. "ollama", "lmstudio"); defaults to "ollama".
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
