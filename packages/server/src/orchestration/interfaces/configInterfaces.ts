/**
 * Manages model selection, provider configuration, and sampling parameters for the orchestration layer.
 *
 * @remarks
 * This interface abstracts read/write access to persisted configuration and session-level overrides.
 * Configuration covers model names, sampling temperatures, retry limits, provider connections,
 * and context budgets. The implementation handles both file-based persistence and in-session overrides,
 * enabling flexible model and provider switching without server restart.
 *
 * **Primary consumers:**
 * - **Agent** — retrieves model names and temperatures for planning.
 * - **Subagent** — retrieves model names and temperatures for task execution.
 * - **Router** — exposes config via `/config` endpoints for user querying and mutation.
 *
 * @example
 * ```ts
 * const agentModel = await configManager.getAgentModel();
 * const agentTemp = await configManager.getAgentTemperature();
 * await configManager.setModel("agent", "llama3.1");
 * ```
 */
export interface IConfigManager {
  /**
   * Returns the model name configured for the agent (planning) role.
   *
   * @remarks
   * Checks session-level overrides first, then falls back to persisted config.
   * The agent model is used for planning, reasoning, and combining task results.
   *
   * @returns Model identifier string (e.g., `"llama3.1"`, `"gemma3:27b"`).
   *
   * @example
   * ```ts
   * const model = await config.getAgentModel();
   * Returns the current agent model, respecting session overrides
   * ```
   */
  getAgentModel(): Promise<string>;

  /**
   * Returns the model name configured for the subagent (execution) role.
   *
   * @remarks
   * Checks session-level overrides first, then falls back to persisted config.
   * The subagent model is used for running individual tasks and subtasks.
   *
   * @returns Model identifier string (e.g., `"llama3.1"`, `"gemma3:27b"`).
   *
   * @example
   * ```ts
   * const model = await config.getSubagentModel();
   * ```
   */
  getSubagentModel(): Promise<string>;

  /**
   * Returns whether the agent model supports native tool calling.
   *
   * @remarks
   * Some models have native tool/function calling support built in, which enables structured
   * output and tool invocation without fallback parsing. Returns `false` for models requiring
   * manual tool schema injection and output parsing.
   *
   * @returns `true` if the model supports native tool calling; `false` otherwise.
   */
  getAgentModelSupportsTools(): Promise<boolean>;

  /**
   * Returns whether the subagent model supports native tool calling.
   *
   * @returns `true` if the model supports native tool calling; `false` otherwise.
   */
  getSubagentModelSupportsTools(): Promise<boolean>;

  /**
   * Returns whether the agent model supports Ollama's extended `think` mode.
   *
   * @remarks
   * Ollama rejects `think: true` with an HTTP 400 for models that don't
   * advertise the `"thinking"` capability, so callers must check this
   * before requesting it rather than assuming every model supports it.
   *
   * @returns `true` if the agent model supports extended thinking; `false` otherwise.
   */
  getAgentModelSupportsThinking(): Promise<boolean>;

  /**
   * Returns the sampling temperature for the agent (planning) role.
   *
   * @remarks
   * Checks session-level overrides first, then falls back to persisted config.
   * Temperature controls output randomness: `0.0` is deterministic (consistent planning),
   * higher values increase creativity. Typically low (0.1-0.3) to ensure reliable planning.
   *
   * @returns Temperature value. Common range: 0.0 (deterministic) to 1.0 (creative).
   *
   * @example
   * ```ts
   * const temp = await config.getAgentTemperature();
   *  Returns ~0.1-0.3 for consistent, predictable planning
   * ```
   */
  getAgentTemperature(): Promise<number>;

  /**
   * Returns the sampling temperature for the subagent (execution) role.
   *
   * @remarks
   * Checks session-level overrides first, then falls back to persisted config.
   * Typically higher than agent temperature (0.5-0.7) to allow task creativity while
   * remaining coherent.
   *
   * @returns Temperature value. Common range: 0.0 (deterministic) to 1.0 (creative).
   *
   * @example
   * ```ts
   * const temp = await config.getSubagentTemperature();
   * // Returns ~0.5-0.7 for balanced creativity and reliability
   * ```
   */
  getSubagentTemperature(): Promise<number>;

  /**
   * Returns the maximum number of retry attempts after an escalation response.
   *
   * @remarks
   * Checks session-level overrides first, then falls back to persisted config.
   * Enforces a minimum of 1 (at least one retry is always permitted).
   * When a model responds with an escalation signal, the orchestrator may retry up to this limit.
   *
   * @returns Maximum retry attempts (≥ 1).
   *
   * @example
   * ```ts
   * const maxRetries = await config.getMaxRetries();
   * Retry up to this many times before giving up
   * ```
   */
  getMaxRetries(): Promise<number>;

  /**
   * Returns the sampling temperature for a given role.
   *
   * @remarks
   * Convenience method that delegates to `getAgentTemperature()` or `getSubagentTemperature()`
   * based on the role parameter.
   *
   * @param role - Either `"agent"` (planning) or `"subagent"` (execution).
   * @returns Temperature value for the specified role.
   */
  getTemperature(role: "agent" | "subagent"): Promise<number>;

  /**
   * Returns the configured maximum retry attempts.
   *
   * @remarks
   * Convenience alias for `getMaxRetries()`. Used when the retry limit is needed without
   * specifying a role.
   *
   * @returns Maximum retry count (≥ 1).
   */
  getRetries(): Promise<number>;

  /**
   * Returns the maximum milliseconds allowed for a complete orchestration task.
   *
   * @remarks
   * Defines the timeout for the entire task execution, including planning, execution,
   * and retries. Exceeding this timeout should cancel remaining work.
   *
   * @returns Timeout in milliseconds.
   */
  getTimeout(): Promise<number>;

  /**
   * Returns the fraction of the model's context window reserved for memory injection.
   *
   * @remarks
   * Memory snippets are injected as a header in the system prompt. This budget ensures
   * memory doesn't crowd out the actual task prompt or response space. Expressed as a
   * decimal (e.g., 0.15 = 15% of available context).
   *
   * @returns Fraction of context window (typically 0.1–0.2).
   */
  getMaxContextBudget(): Promise<number>;

  /**
   * Returns the configured Ollama runtime context window (`num_ctx`), if set.
   *
   * @remarks
   * `undefined` means "not configured" — callers fall back to Ollama's own
   * default (4096) rather than guessing. Ollama-only; ignored for other
   * providers. Set via `atlas-detect-hardware --write` or `/set numCtx`.
   *
   * @returns Configured `num_ctx` in tokens, or `undefined` if unset.
   */
  getNumCtx(): Promise<number | undefined>;

  /**
   * Returns the configured Ollama `keep_alive` duration.
   *
   * @remarks
   * Controls how long Ollama keeps a model resident in VRAM after use.
   * Ollama-only; ignored for other providers.
   *
   * @returns A duration string with a unit (e.g. `"30m"`, `"1h"`), or the
   *   number `-1` to never unload. Never the string `"-1"`: Ollama parses a
   *   string `keep_alive` with Go's `time.ParseDuration`, which rejects a
   *   unitless value, so never-unload must go on the wire as a number.
   */
  getKeepAlive(): Promise<string | number>;

  /**
   * Returns the complete merged configuration object.
   *
   * @remarks
   * Combines defaults, persisted configuration, and session-level overrides into a single
   * object. Primarily used by the Router `/config` endpoint for exposing the full config state.
   *
   * @returns Configuration object with all keys and values.
   */
  getAll(): Promise<Record<string, unknown>>;

  /**
   * Updates one configuration key and persists the change.
   *
   * @remarks
   * Used by the Router `/config` endpoint to allow users to mutate config values.
   * Changes are immediately persisted to storage.
   *
   * @param key - Configuration key name.
   * @param value - New value for the key.
   *
   * @example
   * ```ts
   * await config.set("maxRetries", 5);
   * ```
   */
  set(key: string, value: unknown): Promise<void>;

  /**
   * Updates the model for a given role and triggers cache invalidation.
   *
   * @remarks
   * Switches the active model for either the agent (planning) or subagent (execution) role.
   * Persists the change and notifies any listeners that model-dependent caches should be invalidated.
   *
   * @param role - Either `"agent"` (planning) or `"subagent"` (execution).
   * @param modelName - Model identifier to switch to (e.g., `"llama3.1"`, `"gemma3:27b"`).
   *
   * @example
   * ```ts
   * await config.setModel("agent", "llama3.1");
   * Agent now uses llama3.1 for planning
   * ```
   */
  setModel(role: "agent" | "subagent", modelName: string): Promise<void>;

  /**
   * Returns the provider name configured for the agent (planning) role.
   *
   * @remarks
   * Defaults to `"ollama"` if no other provider is configured. Allows switching between
   * Ollama (local) and external providers (OpenAI-compatible APIs, etc.).
   *
   * @returns Provider name string (e.g., `"ollama"`, `"openai"`, custom provider names).
   *
   * @example
   * ```ts
   * const provider = await config.getAgentProvider();
   * console.log(provider); // "ollama" or name of external provider
   * ```
   */
  getAgentProvider(): Promise<string>;

  /**
   * Returns the provider name configured for the subagent (execution) role.
   *
   * @remarks
   * Defaults to `"ollama"` if no other provider is configured.
   *
   * @returns Provider name string (e.g., `"ollama"`, `"openai"`, custom provider names).
   */
  getSubagentProvider(): Promise<string>;

  /**
   * Looks up connection details for a specific provider by name.
   *
   * @remarks
   * The built-in Ollama provider is not configurable via this interface (it's always available).
   * This method retrieves configuration for external providers only.
   *
   * @param name - Provider name (never `"ollama"`). For example, `"openai"` or a custom provider name.
   * @returns Connection details (`{ baseUrl, apiKey? }`) or `undefined` if the provider is not configured.
   *
   * @example
   * ```ts
   * const provider = await config.getProvider("openai");
   * if (provider) {
   *   console.log(provider.baseUrl); // "https://api.openai.com/v1"
   * }
   * ```
   */
  getProvider(
    name: string,
  ): Promise<{ baseUrl: string; apiKey?: string } | undefined>;

  /**
   * Returns all configured external providers and their connection details.
   *
   * @remarks
   * Does not include the built-in Ollama provider. Returns an empty object if no
   * external providers are configured.
   *
   * @returns Map of provider name → connection details.
   *
   * @example
   * ```ts
   * const providers = await config.getProviders();
   * { "openai": { baseUrl: "...", apiKey: "..." }, ... }
   * ```
   */
  getProviders(): Promise<Record<string, { baseUrl: string; apiKey?: string }>>;

  /**
   * Registers or updates an external provider's connection details.
   *
   * @remarks
   * The provider name must not be empty and cannot be `"ollama"` (reserved for local Ollama).
   * Updates are persisted immediately. If a provider with this name already exists, it is updated.
   *
   * @param name - Provider name (e.g., `"openai"`, `"anthropic"`). Must not be empty or `"ollama"`.
   * @param providerConfig - Connection details: `baseUrl` (required) and optional `apiKey`.
   * @throws When `name` is empty, `"ollama"`, or invalid.
   *
   * @example
   * ```ts
   * await config.addProvider("openai", {
   *   baseUrl: "https://api.openai.com/v1",
   *   apiKey: process.env.OPENAI_API_KEY
   * });
   * ```
   */
  addProvider(
    name: string,
    providerConfig: { baseUrl: string; apiKey?: string },
  ): Promise<void>;

  /**
   * Removes a provider from configuration.
   *
   * @remarks
   * Cannot remove a provider that is currently in use by the agent or subagent role.
   * This prevents orphaning a role without a provider.
   *
   * @param name - Provider name to remove (e.g., `"openai"`).
   * @throws When the provider is in use by an active role.
   *
   * @example
   * ```ts
   * await config.removeProvider("openai");
   * Provider is no longer available for role assignment
   * ```
   */
  removeProvider(name: string): Promise<void>;

  /**
   * Switches a role to use a different provider, keeping the current model.
   *
   * @remarks
   * The new provider must be either `"ollama"` (always available) or a previously registered
   * external provider. This operation does not change the model name, so you may need to call
   * `setModel` afterward if the model name is not available on the new provider.
   *
   * @param role - Role to update: `"agent"` (planning) or `"subagent"` (execution).
   * @param providerName - Target provider name (must be `"ollama"` or already configured).
   * @throws When the provider name is not found or available.
   *
   * @example
   * ```ts
   * await config.setProvider("agent", "openai");
   * Agent planning now uses the configured OpenAI provider
   * ```
   */
  setProvider(role: "agent" | "subagent", providerName: string): Promise<void>;

  /**
   * Atomically switches both the provider and model for a role.
   *
   * @remarks
   * Combines `setProvider` and `setModel` into a single operation. Triggers cache invalidation
   * callbacks after both changes are persisted. Use this when switching to an entirely different
   * provider+model pair to avoid intermediate inconsistent state.
   *
   * @param role - Role to update: `"agent"` (planning) or `"subagent"` (execution).
   * @param providerName - Target provider name (must be `"ollama"` or already configured).
   * @param modelName - Model name available on the target provider (e.g., `"gpt-4"`, `"llama3.1"`).
   * @throws When the provider is not found or the model is invalid for the provider.
   *
   * @example
   * ```ts
   * await config.setRoleModel("agent", "openai", "gpt-4");
   * Agent planning now uses OpenAI's gpt-4 model
   * ```
   */
  setRoleModel(
    role: "agent" | "subagent",
    providerName: string,
    modelName: string,
  ): Promise<void>;
}
