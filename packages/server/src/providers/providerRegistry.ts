/**
 * Registry for resolving LLM provider names to clients, enabling multi-provider support.
 *
 * @remarks
 * This module is the architectural seam that enables multi-provider support without
 * modifying Agent or Subagent. Both still depend on {@link IOllamaClient} as before,
 * but the instance injected for each role ({@link RoleRoutedClient}) now:
 *
 * 1. Re-reads the role's configured provider on every call (no caching)
 * 2. Constructs a fresh {@link OpenAiCompatibleAdapter} for non-Ollama providers
 * 3. Returns the shared native Ollama client for the built-in "ollama" provider
 * 4. Respects per-task provider overrides via `getRoleClient(role, overrideProvider)`
 *
 * **Provider types:**
 * - `"ollama"` — Built-in, uses shared {@link IOllamaClient} with native Ollama protocol
 * - Any other name — Uses {@link OpenAiCompatibleAdapter}, routed to baseUrl + apiKey from config
 *
 * **No caching pattern:**
 * Config is re-read on every call (same pattern as ConfigManager). This means:
 * - `/set agent provider vllm` takes effect immediately (no restart needed)
 * - Per-task provider overrides work transparently
 * - Configuration changes are always visible
 *
 * **Architecture:**
 * - {@link ProviderRegistry} — Instantiates providers by name, holds role-routed clients
 * - {@link RoleRoutedClient} — Implements {@link IOllamaClient}, delegates to role's current provider
 * - Agent/Subagent — Inject a {@link RoleRoutedClient} for their role, never know about providers
 *
 * @example
 * ```ts
 * const registry = new ProviderRegistry({
 *   config: configManager,
 *   ollamaClient: nativeOllamaClient,
 * });
 *
 * // Agent gets a role-routed client for "agent"
 * const agentClient = registry.getRoleClient("agent");
 * // Every call now re-reads config to find which provider "agent" is using
 *
 * // Per-task override: use a specific provider for one task
 * const overrideClient = registry.getRoleClient("agent", "gpt-4");
 * // This call uses OpenAI, regardless of what "agent" is configured to use
 * ```
 *
 * @see {@link RoleRoutedClient} for the client that routes by role
 * @see {@link OpenAiCompatibleAdapter} for OpenAI-compatible provider implementation
 */

import type {
  IOllamaAdminClient,
  IOllamaClient,
} from "../orchestration/interfaces/ollamaInterfaces.js";
import type { ChatOptions, Message } from "../orchestration/types.js";
import type { ToolSchema } from "../orchestration/tools/types.js";
import type { ConfigRole } from "../config/index.js";
import { ConfigError } from "../config/index.js";
import { OpenAiCompatibleAdapter } from "./openAiCompatibleAdapter.js";
import { SingleModelAdmin } from "./openAiCompatibleAdmin.js";

/**
 * The built-in provider name that always resolves to the native Ollama client.
 *
 * @remarks
 * This is a special case in the registry: "ollama" doesn't require configuration
 * (no baseUrl or apiKey needed) and always returns the shared, pre-initialized
 * Ollama client. This allows Ollama to work out-of-the-box without configuration.
 */
export const OLLAMA_PROVIDER_NAME = "ollama";

/**
 * Config surface that ProviderRegistry needs to instantiate and route providers.
 *
 * @remarks
 * The registry doesn't own configuration — it delegates to ConfigManager through
 * this interface. This keeps provider resolution decoupled from config storage.
 *
 * @example
 * ```ts
 * const config: ProviderRegistryConfig = {
 *   async getAgentProvider() { return "gpt-4"; },
 *   async getSubagentProvider() { return "ollama"; },
 *   async getProvider(name) {
 *     if (name === "ollama") return undefined; // Built-in, no config needed
 *     return { baseUrl: "https://api.openai.com/v1", apiKey: "sk-..." };
 *   }
 * };
 * ```
 */
export type ProviderRegistryConfig = {
  /**
   * Returns the provider name configured for the Agent role.
   * Re-read on every call (no caching), so config changes are immediately visible.
   */
  getAgentProvider(): Promise<string>;

  /**
   * Returns the provider name configured for the Subagent role.
   * Re-read on every call (no caching), so config changes are immediately visible.
   */
  getSubagentProvider(): Promise<string>;

  /**
   * Returns the configuration (baseUrl, apiKey) for a non-Ollama provider.
   * Returns undefined if the provider is not configured.
   *
   * @param name - Provider name, e.g. "gpt-4" or "vllm-local".
   * @returns Configuration for the provider, or undefined if not configured.
   */
  getProvider(
    name: string,
  ): Promise<{ baseUrl: string; apiKey?: string } | undefined>;
};

/**
 * Minimal interface for accessing role-routed LLM clients.
 *
 * @remarks
 * Agent and Subagent depend on this interface. It hides the complexity of
 * provider resolution and role routing behind a simple method that returns
 * an {@link IOllamaClient} for a specific role.
 *
 * @example
 * ```ts
 * // In Agent constructor
 * constructor(registry: IProviderRegistry) {
 *   this.client = registry.getRoleClient("agent");
 *   // Every call to this.client now routes through the configured provider
 * }
 * ```
 */
export interface IProviderRegistry {
  /**
   * Returns an IOllamaClient bound to one role ("agent" or "subagent").
   *
   * @remarks
   * The returned client re-reads the role's configured provider on every call,
   * so configuration changes take effect immediately without restarting Agent/Subagent.
   *
   * When `overrideProvider` is set (per-task provider selection from CLI),
   * it wins over the role's configured provider for that specific call. This allows
   * "use vLLM for this one task" without changing the persistent configuration.
   *
   * @param role - The role to get a client for ("agent" or "subagent").
   * @param overrideProvider - Optional per-task provider override (e.g., "gpt-4").
   *   If set, this provider is used instead of reading the role's configured provider.
   *   Not persisted; only applies to this specific call.
   * @returns An IOllamaClient that routes all calls through the appropriate provider.
   *
   * @example
   * ```ts
   * const agentClient = registry.getRoleClient("agent");
   * // Routes to whatever provider "agent" is configured to use
   *
   * const overrideClient = registry.getRoleClient("agent", "gpt-4");
   * // Routes to OpenAI's GPT-4, regardless of agent's configuration
   * ```
   */
  getRoleClient(role: ConfigRole, overrideProvider?: string): IOllamaClient;
}

/**
 * Central registry for resolving provider names to LLM clients.
 *
 * @remarks
 * ProviderRegistry serves two responsibilities:
 *
 * 1. **Provider resolution:** Maps provider names to clients via {@link getClient} and {@link getAdmin}.
 *    - For "ollama": returns the shared native Ollama client (no config needed)
 *    - For others: constructs a fresh {@link OpenAiCompatibleAdapter} with config from ConfigManager
 *
 * 2. **Role-based routing:** Creates {@link RoleRoutedClient} instances for each role (agent, subagent).
 *    - Agent and Subagent receive one of these as their IOllamaClient dependency
 *    - Each call re-reads config to support dynamic provider switching
 *    - Per-task overrides (one-off provider selection) bypass the configured provider
 *
 * **Design pattern:** Factory + dependency injection. The registry is the single place that
 * knows how to construct clients; Agent/Subagent just depend on IOllamaClient without caring
 * how providers are resolved.
 *
 * @example
 * ```ts
 * const registry = new ProviderRegistry({
 *   config: configManager,
 *   ollamaClient: ollamaClient,
 * });
 *
 * // Agent gets a role-routed client
 * const agentClient = registry.getRoleClient("agent");
 * await agentClient.chat("mistral-7b", messages, options);
 * // ↓ re-reads config ↓
 * // If agent is set to "vllm": routes to vLLM
 * // If agent is set to "ollama": routes to native Ollama
 * ```
 */
export class ProviderRegistry implements IProviderRegistry {
  /**
   * Cached role-routed clients, one per role.
   * These are reused across calls (not recreated each time), but the client
   * itself re-reads config on every call, so configuration changes are visible.
   */
  private readonly roleClients: Record<ConfigRole, RoleRoutedClient>;

  /**
   * Creates a new ProviderRegistry.
   *
   * @param deps - Dependencies:
   *   - `config`: ConfigManager interface for reading provider configs and role selections
   *   - `ollamaClient`: Shared native Ollama client, reused for all "ollama" calls
   *
   * @remarks
   * The registry creates role-routed clients for "agent" and "subagent" at construction time
   * and reuses them. These clients themselves re-read config on every call, so the registry
   * doesn't need to recreate them when config changes.
   *
   * @example
   * ```ts
   * const registry = new ProviderRegistry({
   *   config: configManager,
   *   ollamaClient: nativeOllamaClient,
   * });
   * ```
   */
  constructor(
    private readonly deps: {
      config: ProviderRegistryConfig;
      ollamaClient: IOllamaClient & IOllamaAdminClient;
    },
  ) {
    // Create role-routed clients for the two standard roles.
    // These are cached and reused, but they re-read config on every call.
    this.roleClients = {
      agent: new RoleRoutedClient(this, deps.config, "agent"),
      subagent: new RoleRoutedClient(this, deps.config, "subagent"),
    };
  }

  /**
   * Returns a role-routed IOllamaClient, with optional per-task provider override.
   *
   * @remarks
   * If no override is provided, returns the cached role-routed client for that role.
   * This client re-reads config on every call, so configuration changes are immediately visible.
   *
   * If an override is provided, creates a one-off role-routed client that uses the override
   * instead of the configured provider. This is not cached, since it's specific to a single
   * task and won't be reused.
   *
   * @param role - The role ("agent" or "subagent") to get a client for.
   * @param overrideProvider - Optional per-task provider override. If provided, this provider
   *   is used instead of reading the role's configured provider. Not persisted.
   * @returns An IOllamaClient that routes calls through the appropriate provider.
   *
   * @example
   * ```ts
   * // Use the configured provider for agent
   * const client1 = registry.getRoleClient("agent");
   *
   * // Use a specific provider, overriding agent's configuration for this call only
   * const client2 = registry.getRoleClient("agent", "gpt-4");
   * ```
   */
  getRoleClient = (
    role: ConfigRole,
    overrideProvider?: string,
  ): IOllamaClient => {
    // Trim the override to handle cases with accidental whitespace.
    const trimmedOverride = overrideProvider?.trim();
    if (trimmedOverride) {
      // One-off client for this override — not cached, since it's specific
      // to a single task's model overrides rather than the role's steady
      // configured provider. A new instance is created each time.
      return new RoleRoutedClient(
        this,
        this.deps.config,
        role,
        trimmedOverride,
      );
    }
    // No override: return the cached role-routed client, which re-reads config on each call.
    return this.roleClients[role];
  };

  /**
   * Resolves a provider name to an IOllamaClient (chat operations).
   *
   * @remarks
   * This is the internal method that RoleRoutedClient calls to get the actual client
   * for a provider. It handles:
   * - "ollama" → returns the shared native Ollama client
   * - Other names → constructs a fresh OpenAiCompatibleAdapter with config from ConfigManager
   *
   * Constructing a fresh adapter for each call is cheap (no persistent connection state
   * to maintain) and ensures isolation between calls.
   *
   * @param providerName - The provider to resolve, e.g. "ollama", "gpt-4", "vllm".
   * @returns An IOllamaClient for the provider.
   * @throws {@link ConfigError} if the provider is not configured (except "ollama").
   *
   * @example
   * ```ts
   * const client1 = await registry.getClient("ollama");
   * // Returns shared ollamaClient
   *
   * const client2 = await registry.getClient("gpt-4");
   * // Returns new OpenAiCompatibleAdapter("https://api.openai.com/v1", "sk-...")
   * ```
   */
  getClient = async (providerName: string): Promise<IOllamaClient> => {
    // The built-in "ollama" provider doesn't require configuration.
    // Return the shared native Ollama client that was pre-initialized.
    if (providerName === OLLAMA_PROVIDER_NAME) {
      return this.deps.ollamaClient;
    }

    // For non-Ollama providers, read configuration from ConfigManager.
    const providerConfig = await this.deps.config.getProvider(providerName);
    // If the provider is not configured, throw an error with instructions on how to configure it.
    if (!providerConfig) {
      throw new ConfigError(
        `Provider '${providerName}' not configured. Run /providers add ${providerName} first.`,
      );
    }

    // Construct and return a fresh OpenAI-compatible adapter for this provider.
    // It's cheap to create (no persistent state), so we create a new one per call.
    return new OpenAiCompatibleAdapter(
      providerConfig.baseUrl,
      providerConfig.apiKey ?? "",
    );
  };

  /**
   * Resolves a provider name to an IOllamaAdminClient (model management operations).
   *
   * @remarks
   * Similar to {@link getClient}, but returns an admin client for model management
   * operations (list models, pull models, etc.). For Ollama, this is the shared
   * admin client. For others, it's a {@link SingleModelAdmin} adapter that translates
   * admin operations to OpenAI-compatible equivalents (where supported).
   *
   * @param providerName - The provider to resolve.
   * @returns An IOllamaAdminClient for model management on the provider.
   * @throws {@link ConfigError} if the provider is not configured (except "ollama").
   *
   * @example
   * ```ts
   * const admin = await registry.getAdmin("ollama");
   * // Returns shared ollamaClient (which implements IOllamaAdminClient)
   *
   * const admin2 = await registry.getAdmin("vllm");
   * // Returns SingleModelAdmin wrapper for vLLM
   * ```
   */
  getAdmin = async (providerName: string): Promise<IOllamaAdminClient> => {
    // The built-in "ollama" provider has full admin support.
    // Return the shared native Ollama client.
    if (providerName === OLLAMA_PROVIDER_NAME) {
      return this.deps.ollamaClient;
    }

    // For non-Ollama providers, read configuration from ConfigManager.
    const providerConfig = await this.deps.config.getProvider(providerName);
    // If the provider is not configured, throw an error.
    if (!providerConfig) {
      throw new ConfigError(
        `Provider '${providerName}' not configured. Run /providers add ${providerName} first.`,
      );
    }

    // Construct and return a SingleModelAdmin adapter for this provider.
    // This handles model management operations (list, pull, etc.) for OpenAI-compatible backends.
    return new SingleModelAdmin(
      providerConfig.baseUrl,
      providerConfig.apiKey ?? "",
    );
  };
}

/**
 * IOllamaClient bound to one role ("agent" or "subagent"), routing calls through the configured provider.
 *
 * @remarks
 * RoleRoutedClient is the key abstraction that enables dynamic provider switching without
 * reconstructing Agent or Subagent. Every method follows the same pattern:
 * 1. Re-read the role's configured provider (or use the override if set)
 * 2. Get the actual client for that provider (via ProviderRegistry)
 * 3. Delegate the call to the real client
 *
 * **No caching:** Configuration is re-read on every call. This means:
 * - `/set agent provider vllm` takes effect on the very next chat call
 * - No need to restart Agent or rebuild dependency injection
 * - Multi-provider workflows can switch providers mid-task
 *
 * **Override support:** When constructed with an `overrideProvider`, that provider is used
 * instead of reading the configured provider. This enables per-task provider selection
 * without persisting the change to configuration.
 *
 * **Architecture:** This is a thin wrapper that implements {@link IOllamaClient} by delegating
 * to the real provider's client. It's the "dispatch layer" between the orchestration
 * (Agent/Subagent) and the providers (Ollama, vLLM, OpenAI, etc.).
 *
 * @example
 * ```ts
 * // Cached, role-routed client for Agent
 * // On each call, it reads the configured provider for "agent" and delegates to it
 * const agentClient = new RoleRoutedClient(registry, config, "agent");
 * await agentClient.chat("mistral-7b", messages, options);
 * // ↓ reads config ↓ delegates to active provider ↓
 *
 * // Per-task override: use OpenAI for this call only
 * const overrideClient = new RoleRoutedClient(registry, config, "agent", "gpt-4");
 * await overrideClient.chat("gpt-4", messages, options);
 * // ↓ uses OpenAI, ignoring agent's configuration ↓
 * ```
 */
export class RoleRoutedClient implements IOllamaClient {
  /**
   * Creates a role-routed client.
   *
   * @param registry - The ProviderRegistry to resolve provider names to clients.
   * @param config - ConfigManager interface for reading role and provider configuration.
   * @param role - The role this client is bound to ("agent" or "subagent").
   * @param overrideProvider - Optional per-task provider override. If set, this provider
   *   is always used instead of reading the configured provider. Useful for one-off
   *   provider selection without persisting the change.
   *
   * @remarks
   * If overrideProvider is not set, the client will re-read the configured provider
   * on every call via config.getAgentProvider() or config.getSubagentProvider().
   *
   * @example
   * ```ts
   * // Standard role-routed client (reads config on each call)
   * const agentClient = new RoleRoutedClient(registry, config, "agent");
   *
   * // Per-task override (always uses vllm)
   * const overrideClient = new RoleRoutedClient(registry, config, "agent", "vllm");
   * ```
   */
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly config: ProviderRegistryConfig,
    private readonly role: ConfigRole,
    /** When set, this provider is used instead of reading the role's configured provider. */
    private readonly overrideProvider?: string,
  ) {}

  /**
   * Resolves the provider to use for this role, reading config if needed.
   *
   * @remarks
   * This method encapsulates the resolution logic:
   * 1. If overrideProvider is set, use it (one-off selection)
   * 2. Otherwise, read the configured provider for this role
   * 3. Get the actual client from the registry
   *
   * Called by every method (chat, chatStream, chatWithTools) to support dynamic provider switching.
   *
   * @returns An IOllamaClient for the resolved provider.
   * @throws {@link ConfigError} if the provider is not configured.
   *
   * @example
   * ```ts
   * // For a client without override
   * const client = await roleRoutedClient.resolveClient();
   * // Reads: agent is configured to use "vllm"
   * // Returns: OpenAiCompatibleAdapter for vLLM
   *
   * // For a client with override
   * const client = await overrideClient.resolveClient();
   * // Ignores config, uses: "gpt-4"
   * // Returns: OpenAiCompatibleAdapter for OpenAI
   * ```
   */
  private resolveClient = async (): Promise<IOllamaClient> => {
    // Determine which provider to use: override takes priority, otherwise read config.
    const providerName =
      this.overrideProvider ??
      (this.role === "agent"
        ? await this.config.getAgentProvider()
        : await this.config.getSubagentProvider());
    // Get the actual client from the registry.
    return this.registry.getClient(providerName);
  };

  /**
   * Sends messages to the model and returns the complete response.
   *
   * @remarks
   * This method re-reads the configured provider on each call, allowing
   * configuration changes to take effect immediately.
   *
   * @param model - The model to use, e.g. "mistral-7b" or "gpt-4".
   * @param messages - Conversation history.
   * @param options - Request options (temperature, signal, etc.).
   * @returns The model's complete response as a string.
   *
   * @example
   * ```ts
   * const response = await roleRoutedClient.chat("mistral-7b", messages, {
   *   temperature: 0.7
   * });
   * ```
   */
  chat = async (
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): Promise<string> => {
    // Resolve the provider and delegate the call to it.
    const client = await this.resolveClient();
    return client.chat(model, messages, options);
  };

  /**
   * Streams the model's text response token-by-token.
   *
   * @remarks
   * Like chat(), this re-reads the configured provider on each call.
   * Uses async generators to stream tokens as they arrive.
   *
   * @param model - The model to use.
   * @param messages - Conversation history.
   * @param options - Request options.
   * @yields Text tokens as they arrive from the model.
   *
   * @example
   * ```ts
   * for await (const token of roleRoutedClient.chatStream(model, messages, options)) {
   *   process.stdout.write(token); // Real-time output
   * }
   * ```
   */
  chatStream = async function* (
    this: RoleRoutedClient,
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    // Resolve the provider and yield all tokens from its stream.
    const client = await this.resolveClient();
    yield* client.chatStream(model, messages, options);
  };

  /**
   * Streams messages with tool availability, collecting tool calls and content.
   *
   * @remarks
   * Like the other methods, this re-reads the configured provider on each call.
   * Supports both text streaming and tool-call accumulation.
   *
   * @param model - The model to use (should be tool-capable).
   * @param messages - Conversation history.
   * @param tools - Available tools the model can call.
   * @param options - Request options.
   * @param onToken - Optional callback for each content token.
   * @returns Result with content, thinking tokens, and tool calls.
   *
   * @example
   * ```ts
   * const result = await roleRoutedClient.chatWithTools(
   *   "gpt-4",
   *   messages,
   *   tools,
   *   options,
   *   (token) => console.log(token) // Display tokens as they arrive
   * );
   * console.log("Tool calls:", result.toolCalls);
   * ```
   */
  chatWithTools = async (
    model: string,
    messages: Message[],
    tools: ToolSchema[],
    options: ChatOptions,
    onToken?: (token: string) => void,
  ) => {
    // Resolve the provider and delegate the call to it.
    const client = await this.resolveClient();
    return client.chatWithTools(model, messages, tools, options, onToken);
  };
}
