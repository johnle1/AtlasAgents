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
 * JSON body of a streamed `kind: "task"` request from the client.
 *
 * @remarks
 * This interface defines the shape of the initial payload sent by the client
 * when starting a task execution stream. The `text` field contains the user's
 * natural language task description, while the model and temperature fields
 * control the AI inference behavior.
 *
 * The temperature values range from 0.0 (more deterministic) to 1.0 (more
 * creative). The `subagentModel` is used for the main coordinator agent, while
 * `subsubagentModel` is used for subtask execution agents.
 *
 * @example
 * ```ts
 * const request: TaskRequest = {
 *   text: "Add authentication to the API",
 *   subagentModel: "gemma3:27b",
 *   subsubagentModel: "gemma3:9b",
 *   agentTemp: 0.7,
 *   subagentTemp: 0.5
 * };
 * ```
 */
export interface TaskRequest {
  /**
   * The natural language task description from the user.
   *
   * @remarks
   * This is the primary input to the task execution system. The text is
   * passed to the AI agent as the user's request to be fulfilled.
   */
  text: string;

  /**
   * Model name for the main coordinator agent.
   *
   * @remarks
   * This agent breaks down the task into subtasks and coordinates their
   * execution. It typically uses a larger model for better planning and
   * reasoning capabilities.
   */
  subagentModel: string;

  /**
   * Model name for subtask execution agents.
   *
   * @remarks
   * These agents execute individual subtasks. They typically use smaller,
   * faster models for efficiency since they handle focused, well-defined
   * operations.
   */
  subsubagentModel: string;

  /**
   * Sampling temperature for the coordinator agent.
   *
   * @remarks
   * Temperature controls randomness in the model's output. Lower values (0.0-0.3)
   * produce more deterministic, focused responses. Higher values (0.7-1.0)
   * produce more creative, diverse responses. A value of 0.7 is a common
   * default for general-purpose task planning.
   */
  agentTemp: number;

  /**
   * Sampling temperature for subtask execution agents.
   *
   * @remarks
   * Typically lower than `agentTemp` since subtask execution requires more
   * focused, deterministic behavior. Values around 0.3-0.5 are common for
   * code generation and other precise operations.
   */
  subagentTemp: number;
}

/**
 * Command route strings the server recognizes for requestResponse traffic.
 *
 * @remarks
 * This union type defines the complete set of command routes supported by
 * the server's request/response API. Each route corresponds to a specific
 * operation (e.g., listing models, updating configuration, managing providers).
 *
 * Routes are grouped by namespace:
 * - `models.*`: Model management operations
 * - `config.*`: Configuration management
 * - `providers.*`: Model provider management
 * - `skills.*`: Skill synchronization
 * - `memory.*`: Memory and learning operations
 * - `session.*`: Session management
 * - `plan.*`: Plan-related operations
 * - `mcp.tools.*`: MCP tool synchronization
 *
 * @example
 * ```ts
 * const route: RouteId = "models.list";
 * ```
 */
export type RouteId =
  | "models.list"
  | "models.delete"
  | "models.show"
  | "models.running"
  | "config.get"
  | "config.set"
  | "config.setModel"
  | "providers.list"
  | "providers.add"
  | "providers.remove"
  | "providers.listModels"
  | "skills.sync"
  | "memory.get"
  | "memory.forget"
  | "memory.clear"
  | "session.exists"
  | "session.clear"
  | "plan.respond"
  | "mcp.tools.sync";

/**
 * Fixed list of all RouteId values for runtime validation.
 *
 * @remarks
 * This readonly array provides an O(1) way to check if a string is a valid
 * route identifier. It's used to construct a Set for fast membership testing
 * in the `isRouteId` type guard.
 *
 * The `as const` assertion ensures TypeScript treats this as a tuple of
 * literal string types rather than a generic string array.
 *
 * @example
 * ```ts
 * if (ROUTE_IDS.includes(clientRoute)) {
 *   // Route is valid
 * }
 * ```
 */
export const ROUTE_IDS: readonly RouteId[] = [
  "models.list",
  "models.delete",
  "models.show",
  "models.running",
  "config.get",
  "config.set",
  "config.setModel",
  "providers.list",
  "providers.add",
  "providers.remove",
  "providers.listModels",
  "skills.sync",
  "memory.get",
  "memory.forget",
  "memory.clear",
  "session.exists",
  "session.clear",
  "plan.respond",
  "mcp.tools.sync",
] as const;

// Pre-computed Set for O(1) membership testing in isRouteId
const ROUTE_ID_SET = new Set<string>(ROUTE_IDS);

/**
 * Type guard that narrows an arbitrary string to RouteId when it matches the known set.
 *
 * @remarks
 * This function provides runtime validation for route strings received from
 * untrusted clients. It uses a pre-computed Set for O(1) membership testing,
 * making it efficient for high-traffic scenarios.
 *
 * Use this function before indexing into the `RouterDeps.commands` map to
 * ensure the route is valid and avoid runtime errors.
 *
 * @param value - Raw route string from the client envelope.
 * @returns `true` when `value` is a supported route, enabling TypeScript to
 *   narrow the type from `string` to `RouteId`.
 *
 * @example
 * ```ts
 * const route = parseRouteFromClient(request);
 * if (isRouteId(route)) {
 *   // TypeScript now knows route is RouteId
 *   const handler = commands[route];
 * } else {
 *   throw new Error(`Unknown route: ${route}`);
 * }
 * ```
 */
export const isRouteId = (value: string): value is RouteId => {
  return ROUTE_ID_SET.has(value);
};

/**
 * Stream kind strings the server recognizes for requestStream traffic.
 *
 * @remarks
 * This union type defines the supported streaming operations. Unlike command
 * routes (which are request/response), streams maintain a long-lived connection
 * for sending incremental updates.
 *
 * The supported stream kinds are:
 * - `task`: Executes a user task and streams progress/results
 * - `models.pull`: Streams model download progress
 * - `explore`: Streams codebase exploration results
 *
 * @example
 * ```ts
 * const kind: StreamKind = "task";
 * ```
 */
export type StreamKind = "task" | "models.pull" | "explore";

/**
 * Fixed list of all StreamKind values for runtime validation.
 *
 * @remarks
 * This readonly array provides the complete set of valid stream kinds for
 * validation. Like `ROUTE_IDS`, it uses `as const` to preserve literal types
 * and is used to construct a Set for fast membership testing.
 *
 * @example
 * ```ts
 * if (STREAM_KINDS.includes(clientKind)) {
 *   // Stream kind is valid
 * }
 * ```
 */
export const STREAM_KINDS: readonly StreamKind[] = [
  "task",
  "models.pull",
  "explore",
] as const;

// Pre-computed Set for O(1) membership testing in isStreamKind
const STREAM_KIND_SET = new Set<string>(STREAM_KINDS);

/**
 * Type guard that narrows an arbitrary string to StreamKind when it matches the known set.
 *
 * @remarks
 * This function validates stream kind strings from clients, similar to
 * `isRouteId` but for streaming operations. It's used to ensure the client
 * requests a supported stream type before establishing the stream.
 *
 * @param value - Raw stream kind string from the client envelope.
 * @returns `true` when `value` is a supported stream kind, enabling TypeScript
 *   to narrow the type from `string` to `StreamKind`.
 *
 * @example
 * ```ts
 * const kind = parseStreamKindFromClient(request);
 * if (isStreamKind(kind)) {
 *   // TypeScript now knows kind is StreamKind
 *   const handler = streams[kind];
 * } else {
 *   throw new Error(`Unknown stream kind: ${kind}`);
 * }
 * ```
 */
export const isStreamKind = (value: string): value is StreamKind => {
  return STREAM_KIND_SET.has(value);
};

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
 * Async function signature for streaming task execution on the server.
 *
 * @remarks
 * This type is similar to `StreamHandler` but specifically for task execution.
 * It emits raw text tokens rather than structured frames, which are then
 * wrapped in frame format by the calling code.
 *
 * This handler is invoked by the Router's `routeTask` method when a client
 * initiates a task execution stream. The handler coordinates with the
 * AgentOrchestrator to plan and execute the task, streaming results back
 * to the client in real-time.
 *
 * @param session - The authenticated session context for this task.
 * @param req - The task request containing text, models, and temperature settings.
 * @param emit - Callback to send individual text tokens to the client.
 * @param signal - AbortSignal that becomes signaled when the client disconnects.
 * @returns A promise that resolves when task execution completes.
 *
 * @example
 * ```ts
 * const handler: TaskHandler = async (session, req, emit, signal) => {
 *   await orchestrator.runTask(
 *     session,
 *     req.text,
 *     (token) => emit(token),
 *     signal
 *   );
 * };
 * ```
 */
export type TaskHandler = (
  session: Session,
  req: TaskRequest,
  emit: (token: string) => void,
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
 * The `task` handler is optional because task execution may be handled
 * through the general stream routing mechanism in some configurations.
 *
 * @example
 * ```ts
 * const deps: RouterDeps = {
 *   commands: {
 *     "models.list": async () => ({ models: await ollama.listModels() }),
 *     "config.get": async () => await config.getAll()
 *   },
 *   streams: {
 *     "task": taskHandler,
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

  /**
   * Optional streaming task handler for AgentOrchestrator.
   *
   * @remarks
   * If provided, this handler is used for task execution streams.
   * If omitted, tasks may be handled through the general stream routing.
   */
  task?: TaskHandler;
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
