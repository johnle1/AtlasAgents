/**
 * Wire note: the CLI client uses `memory.get` for `/memory show` (see
 * packages/client/src/connection.ts). The original architecture doc
 * mentioned `memory.show`; only `memory.get` is registered here so the
 * client and server stay aligned without extra aliases.
 */

import type { TaskFrame } from "../transport/frames.js";
import type {
  Session,
  TaskRequest,
  RouteId,
  ROUTE_IDS,
  StreamKind,
  STREAM_KINDS,
  CommandHandler,
  StreamHandler,
  TaskHandler,
  RouterDeps,
} from "./types.js";
import { isRouteId, isStreamKind } from "./types.js";

export {
  Session,
  TaskRequest,
  RouteId,
  ROUTE_IDS,
  StreamKind,
  STREAM_KINDS,
  CommandHandler,
  StreamHandler,
  TaskHandler,
  RouterDeps,
  isRouteId,
  isStreamKind,
};

/**
 * Pure routing layer that dispatches authenticated commands and streams to injectable handlers.
 *
 * @remarks
 * The Router sits between the RSocket transport layer (which handles authentication
 * and connection management) and the domain services (which implement actual business
 * logic). It holds no mutable state beyond the injected dependencies, making it
 * stateless and thread-safe.
 *
 * The Router validates incoming route strings, looks up the appropriate handler,
 * and delegates execution. It supports both request/response patterns (for commands)
 * and streaming patterns (for long-running operations like task execution).
 *
 * **Error handling:** The Router throws descriptive errors for unknown routes
 * or unimplemented handlers, allowing the transport layer to return appropriate
 * error responses to clients.
 *
 * **Extensibility:** New routes can be added by providing additional handlers in
 * the `RouterDeps` object without modifying the Router class itself.
 *
 * @example
 * ```ts
 * const deps: RouterDeps = {
 *   commands: {
 *     "models.list": async () => ({ models: await ollama.listModels() }),
 *     "config.get": async () => await config.getAll()
 *   },
 *   streams: {
 *     "task": taskHandler
 *   }
 * };
 * const router = new Router(deps);
 *
 * // Handle a command
 * const result = await router.routeCommand(session, "models.list", {});
 *
 * // Handle a stream
 * await router.routeStream(session, "task", payload, emit, signal);
 * ```
 */
export class Router {
  /**
   * Creates a new Router instance with the provided dependencies.
   *
   * @param deps - Collaborator references for dispatch, including command and stream handlers.
   */
  constructor(private readonly deps: RouterDeps) {}

  /**
   * Dispatches a JSON command envelope to the correct CommandHandler.
   *
   * @remarks
   * This method handles request/response patterns where the client expects a
   * single JSON response. It validates the route string, looks up the appropriate
   * handler, and returns the handler's result.
   *
   * The method performs three steps:
   * 1. Validates that `type` is a known `RouteId` using `isRouteId`
   * 2. Looks up the handler in `deps.commands[type]`
   * 3. Invokes the handler with the session and payload
   *
   * If the route is unknown or the handler is not implemented, the method throws
   * a descriptive error that the transport layer can convert to an appropriate
   * error response.
   *
   * @param session - Authenticated session containing user ID and connection ID.
   * @param type - Route identifier (e.g., "models.list", "config.get").
   * @param payload - Parsed JSON payload from the client envelope. Shape varies by route.
   * @returns The handler's result, which must be JSON-serializable for the response.
   * @throws {@link Error} When the route is unknown or the handler is not implemented.
   *
   * @example
   * ```ts
   * try {
   *   const result = await router.routeCommand(
   *     session,
   *     "models.list",
   *     {}
   *   );
   *   console.log(result.models); // [{ name: "gemma3:27b", ... }]
   * } catch (err) {
   *   if (err.message.includes("Unknown route")) {
   *     // Handle client error
   *   }
   * }
   * ```
   */
  routeCommand = async (
    session: Session,
    type: string,
    payload: unknown,
  ): Promise<unknown> => {
    // Validate the route string before attempting handler lookup
    if (!isRouteId(type)) {
      throw new Error(`Unknown route: ${type}`);
    }

    // Look up the handler - this may be undefined if not implemented
    const handler = this.deps.commands?.[type];
    if (!handler) {
      throw new Error(`Route not implemented yet: ${type}`);
    }

    // Delegate to the handler and return its result
    return handler(session, payload);
  };

  /**
   * Dispatches a stream request to the correct StreamHandler.
   *
   * @remarks
   * This method handles streaming patterns where the client expects multiple
   * incremental responses over time. It validates the stream kind, looks up the
   * appropriate handler, and provides it with an `emit` callback for sending
   * frames to the client.
   *
   * The method performs three steps:
   * 1. Validates that `kind` is a known `StreamKind` using `isStreamKind`
   * 2. Looks up the handler in `deps.streams[kind]`
   * 3. Invokes the handler with session, payload, emit callback, and abort signal
   *
   * The `emit` callback allows handlers to send incremental updates to the client.
   * The `signal` parameter becomes signaled when the client disconnects, allowing
   * handlers to abort work promptly and avoid resource leaks.
   *
   * @param session - Authenticated session containing user ID and connection ID.
   * @param kind - Stream kind identifier (e.g., "task", "models.pull", "explore").
   * @param payload - Parsed JSON payload from the client envelope. Shape varies by stream kind.
   * @param emit - Callback for sending individual frames to the client over the stream.
   * @param signal - AbortSignal that becomes signaled when the client disconnects.
   * @returns A promise that resolves when the stream handler completes normally.
   * @throws {@link Error} When the stream kind is unknown or the handler is not implemented.
   *
   * @example
   * ```ts
   * try {
   *   await router.routeStream(
   *     session,
   *     "task",
   *     { text: "Add authentication" },
   *     (frame) => console.log("Sending:", frame),
   *     abortSignal
   *   );
   * } catch (err) {
   *   if (err.message.includes("Unknown stream kind")) {
   *     // Handle client error
   *   }
   * }
   * ```
   */
  routeStream = async (
    session: Session,
    kind: string,
    payload: unknown,
    emit: (frame: TaskFrame) => void,
    signal: AbortSignal,
  ): Promise<void> => {
    // Validate the stream kind before attempting handler lookup
    if (!isStreamKind(kind)) {
      throw new Error(`Unknown stream kind: ${kind}`);
    }

    // Look up the handler - this may be undefined if not implemented
    const handler = this.deps.streams?.[kind];
    if (!handler) {
      throw new Error(`Stream handler not implemented yet: ${kind}`);
    }

    // Delegate to the handler with streaming callbacks
    return handler(session, payload, emit, signal);
  };

  /**
   * Delegates a parsed task request to the configured TaskHandler.
   *
   * @remarks
   * This method is a specialized entry point for task execution streams.
   * Unlike `routeStream`, which handles general streaming operations, this
   * method is specifically designed for the task execution workflow.
   *
   * The method validates that a task handler is configured and then delegates
   * to it. The task handler is responsible for coordinating with the
   * AgentOrchestrator to plan and execute the task, streaming results back
   * through the `emit` callback.
   *
   * This method exists because task execution has special requirements:
   - It uses a specific payload format (`TaskRequest`)
   - It emits raw text tokens rather than structured frames
   - It requires tight integration with the orchestrator
   *
   * @param session - Authenticated session containing user ID and connection ID.
   * @param req - Parsed task request containing text, models, and temperature settings.
   * @param emit - Callback for sending individual text tokens to the client.
   * @param signal - AbortSignal that becomes signaled when the client disconnects.
   * @returns A promise that resolves when task execution completes.
   * @throws {@link Error} When no task handler is configured in the dependencies.
   *
   * @example
   * ```ts
   * const taskRequest: TaskRequest = {
   *   text: "Add authentication to the API",
   *   subagentModel: "gemma3:27b",
   *   subsubagentModel: "gemma3:9b",
   *   agentTemp: 0.7,
   *   subagentTemp: 0.5
   * };
   *
   * try {
   *   await router.routeTask(
   *     session,
   *     taskRequest,
   *     (token) => process.stdout.write(token),
   *     abortSignal
   *   );
   * } catch (err) {
   *   if (err.message.includes("not configured")) {
   *     // Task execution not available in this configuration
   *   }
   * }
   * ```
   */
  routeTask = async (
    session: Session,
    req: TaskRequest,
    emit: (token: string) => void,
    signal: AbortSignal,
  ): Promise<void> => {
    // Check if a task handler is configured
    const task = this.deps.task;
    if (!task) {
      throw new Error("Task handler not configured");
    }

    // Delegate to the task handler for execution
    await task(session, req, emit, signal);
  };
}
