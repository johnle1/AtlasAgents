import type { TaskFrame } from "../transport/frames.js";
import type {
  SessionInfo,
  TaskModelOverrides,
} from "../orchestration/types.js";
import type { PreferenceRule } from "../orchestration/interfaces.js";
import type { PerConnection } from "../container/types.js";
import type { OllamaClient } from "../ollama/client.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";
import type { IConfigManager } from "../orchestration/interfaces/configInterfaces.js";
import type { MaxSubagentsParam } from "../orchestration/maxSubagents.js";
import type { RouteId, StreamKind } from "@loopycode/shared";

/**
 * Represents an authenticated TCP/RSocket session for routing and cleanup.
 *
 * @remarks
 * This interface carries the minimum context needed to route a request
 * and clean up resources when the connection closes. The `userId` identifies
 * the authenticated user (or "anonymous" for unauthenticated connections),
 * while `requesterId` is a stable identifier for the RSocket connection used
 * to abort in-flight streams when the client disconnects.
 *
 * The `requesterId` is critical for cleanup: when a client disconnects,
 * the server must abort any long-running streams (like task execution) to
 * prevent resource leaks.
 *
 * @example
 * ```ts
 * const session: Session = {
 *   userId: "user_123",
 *   requesterId: "req_abc456"
 * };
 * ```
 */
export interface Session {
  /**
   * Resolved user id from token validation, or "anonymous" for empty tokens.
   *
   * @remarks
   * This value comes from the authentication middleware. If the client
   * provides no token or an invalid token, the value is "anonymous".
   */
  userId: string;

  /**
   * Stable id for this RSocket connection used to abort in-flight streams.
   *
   * @remarks
   * This ID is assigned by the RSocket transport layer and remains stable
   * for the lifetime of the connection. It's used as a key in maps that track
   * per-connection state (like active task streams) so that state can be
   * cleaned up when the connection closes.
   */
  requesterId: string;
}

/**
 * Client→server command route and stream kind vocabulary, plus the
 * `kind: "task"` stream payload shape.
 *
 * @remarks
 * Sourced from `@loopycode/shared` so the client can validate route/stream
 * names against the exact same union the server enforces, instead of
 * sending unchecked strings. See `packages/shared/src/protocol/serverProtocol.ts`.
 */
export type {
  RouteId,
  StreamKind,
  TaskStreamPayload,
} from "@loopycode/shared";
export {
  ROUTE_IDS,
  isRouteId,
  STREAM_KINDS,
  isStreamKind,
} from "@loopycode/shared";

/**
 * Async function signature for one command route implementation.
 *
 * @remarks
 * This type defines the contract that all command handlers must implement.
 * Each handler receives the authenticated session and the parsed JSON payload,
 * then returns a JSON-serializable result or throws an error.
 *
 * The payload is typed as `unknown` because different routes expect different
 * payload shapes. Individual handlers are responsible for validating and
 * casting the payload to the expected type.
 *
 * Handlers should throw `ValidationError` for client errors (invalid input)
 * and `NotFoundError` for missing resources. Other errors are treated as
 * internal server errors.
 *
 * @param session - The authenticated session context for this request.
 * @param payload - The parsed JSON payload from the client. Shape varies by route.
 * @returns A JSON-serializable result to send back to the client.
 *
 * @example
 * ```ts
 * const handler: CommandHandler = async (session, payload) => {
 *   const body = payload as { name?: string };
 *   const modelName = String(body.name ?? "");
 *   await ollama.deleteModel(modelName);
 *   return { ok: true };
 * };
 * ```
 */
export type CommandHandler = (
  session: Session,
  payload: unknown,
) => Promise<unknown>;

/**
 * Async function signature for one streaming route implementation.
 *
 * @remarks
 * This type defines the contract for streaming handlers. Unlike command
 * handlers, stream handlers can send multiple incremental responses over time
 * using the `emit` callback.
 *
 * The `emit` function accepts `TaskFrame` objects, which are encoded and sent
 * to the client as part of the RSocket stream. Handlers should call `emit`
 * to send progress updates, partial results, or other incremental data.
 *
 * The `signal` parameter is an AbortSignal that becomes signaled when the
 * client disconnects. Handlers must monitor this signal and abort their work
 * promptly to avoid resource leaks.
 *
 * @param session - The authenticated session context for this stream.
 * @param payload - The parsed JSON payload from the client. Shape varies by stream kind.
 * @param emit - Callback to send frames to the client over the stream.
 * @param signal - AbortSignal that becomes signaled when the client disconnects.
 * @returns A promise that resolves when the stream completes normally.
 *
 * @example
 * ```ts
 * const handler: StreamHandler = async (session, payload, emit, signal) => {
 *   for await (const progress of downloadModel(payload.name, signal)) {
 *     emit({ type: "progress", data: progress });
 *   }
 *   emit({ type: "complete", data: {} });
 * };
 * ```
 */
export type StreamHandler = (
  session: Session,
  payload: unknown,
  emit: (frame: TaskFrame) => void,
  signal: AbortSignal,
) => Promise<void>;

/**
 * Injectable collaborators that the Router delegates to without owning state.
 *
 * @remarks
 * This interface defines the dependency injection contract for the Router.
 * The Router itself is stateless and holds only references to these collaborators,
 * which are provided at construction time.
 *
 * The `commands` and `streams` maps are partial: missing entries result in
 * a "not implemented" error rather than a silent failure. This allows the
 * router to be extended incrementally as new routes are added.
 *
 * @example
 * ```ts
 * const deps: RouterDeps = {
 *   commands: {
 *     "models.list": async () => ({ models: await ollama.listModels() }),
 *     "config.get": async () => await config.getAll()
 *   },
 *   streams: {
 *     "task": taskStreamHandler,
 *     "models.pull": pullHandler
 *   }
 * };
 * const router = new Router(deps);
 * ```
 */
export interface RouterDeps {
  /**
   * Partial map of command route handlers.
   *
   * @remarks
   * Missing entries throw "Route not implemented yet" when called.
   * This allows gradual implementation of routes during development.
   */
  commands?: Partial<Record<RouteId, CommandHandler>>;

  /**
   * Partial map of stream handlers.
   *
   * @remarks
   * Missing entries throw "Stream handler not implemented yet" when called.
   * This allows gradual implementation of stream handlers during development.
   */
  streams?: Partial<Record<StreamKind, StreamHandler>>;
}

/**
 * Interface for the task orchestrator with a runTask method.
 *
 * @remarks
 * This interface abstracts the task execution logic from the routing layer.
 * The orchestrator is responsible for planning, coordinating, and executing
 * user tasks using AI agents.
 *
 * The `runTask` method accepts optional parameters for customizing execution:
 * - `perConn`: Per-connection state for brokers and temporary resources
 * - `modelOverrides`: Temporary model overrides for this specific task
 * - `maxSubagents`: Limits the number of concurrent subagents
 *
 * @example
 * ```ts
 * await orchestrator.runTask(
 *   session,
 *   "Add authentication to the API",
 *   (frame) => emit(frame),
 *   abortSignal,
 *   perConnection,
 *   { agentModel: "gemma3:27b" },
 *   { max: 5 }
 * );
 * ```
 */
export interface IOrchestrator {
  /**
   * Executes a task and streams results to the client.
   *
   * @param session - Session information including user ID and context.
   * @param taskText - The natural language task description to execute.
   * @param emit - Callback to send task frames to the client.
   * @param signal - AbortSignal for cancellation when the client disconnects.
   * @param perConn - Optional per-connection state for resources.
   * @param modelOverrides - Optional model overrides for this task.
   * @param maxSubagents - Optional limits on concurrent subagent execution.
   */
  runTask(
    session: SessionInfo,
    taskText: string,
    emit: (frame: TaskFrame) => void,
    signal: AbortSignal,
    perConn?: PerConnection,
    modelOverrides?: TaskModelOverrides,
    maxSubagents?: MaxSubagentsParam,
  ): Promise<void>;
}

/**
 * Type for a function that transforms preference rules into memory entries.
 *
 * @remarks
 * This transformer converts structured preference rules into a format
 * suitable for storage in the memory system. The transformation typically
 * involves grouping rules by topic and converting them to string arrays.
 *
 * @param rules - Array of preference rules to transform.
 * @returns Array of memory entries, each with a topic and associated rules.
 *
 * @example
 * ```ts
 * const transformer: PreferenceRulesTransformer = (rules) => {
 *   return rules.map(rule => ({
 *     topic: rule.topic,
 *     rules: rule.patterns.map(p => p.description)
 *   }));
 * };
 * ```
 */
export type PreferenceRulesTransformer = (
  rules: PreferenceRule[],
) => Array<{ topic: string; rules: string[] }>;

/**
 * Dependencies required to build a fully configured Router with all handlers.
 *
 * @remarks
 * This interface aggregates all the services and factories needed to
 * construct command and stream handlers. Each handler closes over these
 * dependencies to perform its work.
 *
 * The dependencies include:
 * - Model client and provider registry for AI operations
 * - Configuration manager for settings
 * - Skills and preferences managers for learning features
 * - Session manager for conversation state
 * - Orchestrator for task execution
 * - Per-connection state management
 * - Transformer functions for data conversion
 *
 * @example
 * ```ts
 * const deps: RouterBuilderDeps = {
 *   ollama: ollamaClient,
 *   providerRegistry: providerRegistry,
 *   config: configManager,
 *   skills: skillManager,
 *   prefs: preferenceStore,
 *   session: sessionManager,
 *   orchestrator: agentOrchestrator,
 *   brokerByRequester: new Map(),
 *   createPerConnection: (id, emit) => createPerConnection(id, emit),
 *   preferenceRulesToMemoryEntries: transformRules
 * };
 * const router = buildRouter(deps);
 * ```
 */
export type RouterBuilderDeps = {
  /**
   * HTTP client for communicating with Ollama and other model providers.
   */
  ollama: OllamaClient;

  /**
   * Registry of available model providers and their configurations.
   */
  providerRegistry: ProviderRegistry;

  /**
   * Base URL the `ollama` client was constructed with (e.g.
   * `"http://localhost:11434"`), if known.
   *
   * @remarks
   * Used only by `models.storage` to tell whether Ollama's model directory
   * is readable from this server's own filesystem (host is localhost) or
   * lives on a remote machine (any other host) — see `ollama/modelStorage.ts`.
   * Omitted defaults to treating Ollama as local.
   */
  ollamaBaseUrl?: string;

  /**
   * Manager for application configuration and settings.
   */
  config: IConfigManager;

  /**
   * Skills management interface for saving skill definitions.
   */
  skills: {
    /**
     * Saves multiple skill definitions to storage.
     *
     * @param skills - Array of skill objects with name and content.
     * @returns Number of skills successfully saved.
     */
    saveAll: (
      skills: Array<{ name: string; content: string }>,
    ) => Promise<number>;
  };

  /**
   * Preferences management interface for user preference rules.
   */
  prefs: {
    /**
     * Retrieves all stored preference rules.
     *
     * @returns Array of all preference rules in the system.
     */
    getAll: () => Promise<PreferenceRule[]>;

    /**
     * Deletes all preference rules for a specific topic.
     *
     * @param topic - The topic whose rules should be deleted.
     * @returns Number of rules deleted.
     */
    deleteByTopic: (topic: string) => Promise<number>;

    /**
     * Clears all preference rules from storage.
     */
    clear: () => Promise<void>;
  };

  /**
   * Session management interface for conversation state.
   */
  session: {
    /**
     * Checks if a session exists in storage.
     *
     * @returns `true` if a session exists, `false` otherwise.
     */
    exists: () => Promise<boolean>;

    /**
     * Clears the current session and returns its content.
     *
     * @returns The serialized session content that was cleared.
     */
    clear: () => Promise<string>;

    /**
     * Saves a session snapshot to storage.
     *
     * @param snapshot - The serialized session content to save.
     */
    saveSnapshot: (snapshot: string) => Promise<void>;
  };

  /**
   * Task orchestrator for planning and executing user tasks.
   */
  orchestrator: IOrchestrator;

  /**
   * Map of requester IDs to per-connection state objects.
   *
   * @remarks
   * This map tracks active connections and their associated state,
   * allowing cleanup when connections close.
   */
  brokerByRequester: Map<string, PerConnection>;

  /**
   * Factory function for creating per-connection state objects.
   *
   * @param requesterId - The unique ID for this connection.
   * @param emit - Callback for sending frames to the client.
   * @returns A new PerConnection instance for this connection.
   */
  createPerConnection: (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ) => PerConnection;

  /**
   * Transformer function for converting preference rules to memory entries.
   */
  preferenceRulesToMemoryEntries: PreferenceRulesTransformer;
};
