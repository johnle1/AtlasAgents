/**
 * Wire note: the CLI client uses `memory.get` for `/memory show` (see
 * packages/client/src/connection.ts). The original architecture doc
 * mentioned `memory.show`; only `memory.get` is registered here so the
 * client and server stay aligned without extra aliases.
 */

/**
 * <Summary>
 * What it does:
 *   Identifies one authenticated TCP/RSocket session for routing and cleanup.
 *
 * Used by:
 *   - Router.routeCommand, Router.routeTask — passed to downstream handlers.
 *
 * Produced by:
 *   - RSocketServer — builds a Session after AuthMiddleware.validate succeeds.
 * </Summary>
 */
export interface Session {
  /** Resolved user id from token validation (or "anonymous" for empty token). */
  userId: string

  /** Stable id for this RSocket connection used to abort in-flight streams. */
  requesterId: string
}

/**
 * <Summary>
 * What it does:
 *   Describes the JSON body of a streamed `kind: "task"` request from the client.
 *
 * Used by:
 *   - Router.routeTask — forwarded to the task handler.
 *
 * Produced by:
 *   - RSocketServer — parses the initial requestStream payload.
 * </Summary>
 */
export interface TaskRequest {
  /** User task text. */
  text: string

  /** Advisor role model name. */
  advisorModel: string

  /** Agent role model name. */
  agentModel: string

  /** Advisor sampling temperature. */
  advisorTemp: number

  /** Agent sampling temperature. */
  agentTemp: number
}

/**
 * <Summary>
 * What it does:
 *   Command route strings the server recognises for requestResponse traffic.
 *
 * Used by:
 *   - Router.routeCommand — validates incoming `type` fields.
 *
 * Produced by:
 *   - None (fixed protocol surface).
 * </Summary>
 */
export type RouteId =
  | 'models.list'
  | 'config.get'
  | 'config.set'
  | 'skills.sync'
  | 'memory.get'
  | 'memory.forget'
  | 'memory.clear'

/**
 * <Summary>
 * What it does:
 *   Fixed list of all RouteId values for runtime validation.
 *
 * Used by:
 *   - isRouteId — membership checks.
 *
 * Produced by:
 *   - None (static list).
 * </Summary>
 */
export const ROUTE_IDS: readonly RouteId[] = [
  'models.list',
  'config.get',
  'config.set',
  'skills.sync',
  'memory.get',
  'memory.forget',
  'memory.clear',
] as const

const ROUTE_ID_SET = new Set<string>(ROUTE_IDS)

/**
 * <Summary>
 * What it does:
 *   Narrows an arbitrary string to RouteId when it matches the known set.
 *
 * Parameters:
 *   @param {string} value — Raw route string from the client envelope.
 *
 * Returns:
 *   @returns {value is RouteId} — true when value is a supported route.
 *
 * Dependencies:
 *   - ROUTE_ID_SET — O(1) lookup table.
 *
 * Dependants:
 *   - Router.routeCommand — rejects unknown routes early.
 * </Summary>
 */
export const isRouteId = (value: string): value is RouteId => {
  return ROUTE_ID_SET.has(value)
}

/**
 * <Summary>
 * What it does:
 *   Async function signature for one command route implementation.
 *
 * Used by:
 *   - RouterDeps.commands — handler map values.
 *
 * Produced by:
 *   - Future collaborator wiring (OllamaClient, ConfigManager, etc.).
 * </Summary>
 */
export type CommandHandler = (
  session: Session,
  payload: unknown,
) => Promise<unknown>

/**
 * <Summary>
 * What it does:
 *   Async function signature for streaming task execution on the server.
 *
 * Used by:
 *   - RouterDeps.task — optional single task pipeline.
 *
 * Produced by:
 *   - Future AdvisorOrchestrator wiring.
 * </Summary>
 */
export type TaskHandler = (
  session: Session,
  req: TaskRequest,
  emit: (token: string) => void,
  signal: AbortSignal,
) => Promise<void>

/**
 * <Summary>
 * What it does:
 *   Injectable collaborators the Router delegates to without owning state.
 *
 * Used by:
 *   - Router constructor — stores references for dispatch.
 *
 * Produced by:
 *   - Server bootstrap in packages/server/src/index.ts.
 * </Summary>
 */
export interface RouterDeps {
  /** Partial map: missing entries throw "Route not implemented yet". */
  commands?: Partial<Record<RouteId, CommandHandler>>

  /** Optional streaming task handler for AdvisorOrchestrator. */
  task?: TaskHandler
}

/**
 * <Summary>
 * What it does:
 *   Pure routing layer that dispatches authenticated commands and tasks to
 *   injectable handlers based on route strings and payload shapes.
 *
 * How it fits in the system:
 *   Sits between RSocketServer (transport + auth) and domain services; holds
 *   no mutable state beyond injected deps.
 *
 * Dependencies:
 *   - RouterDeps — command handler map and optional task handler.
 *
 * Dependants:
 *   - RSocketServer — calls routeCommand and routeTask after auth.
 * </Summary>
 */
export class Router {
  /**
   * @param {RouterDeps} deps — Collaborator references for dispatch.
   */
  constructor(private readonly deps: RouterDeps) {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Dispatches one JSON command envelope to the correct CommandHandler.
   *
   * How it does it (step by step):
   *   1. Verifies `type` is a known RouteId — throws on unknown strings.
   *   2. Looks up deps.commands[type] — throws when handler not wired yet.
   *   3. Awaits the handler(session, payload) and returns its JSON-serialisable result.
   *
   * Parameters:
   *   @param {Session} session — Authenticated user + connection id.
   *   @param {string} type — Route id e.g. "models.list".
   *   @param {unknown} payload — Parsed JSON payload from the client envelope.
   *
   * Returns:
   *   @returns {Promise<unknown>} — Handler result for the RSocket ok envelope.
   *
   * @throws {Error} — Unknown route or missing handler wiring.
   *
   * Dependencies:
   *   - isRouteId — validates the route string.
   *   - RouterDeps.commands — handler lookup table.
   *
   * Dependants:
   *   - RSocketServer.requestResponse path.
   * </Summary>
   */
  routeCommand = async (
    session: Session,
    type: string,
    payload: unknown,
  ): Promise<unknown> => {
    if (!isRouteId(type)) {
      throw new Error(`Unknown route: ${type}`)
    }
    const handler = this.deps.commands?.[type]
    if (!handler) {
      throw new Error(`Route not implemented yet: ${type}`)
    }
    return handler(session, payload)
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Delegates a parsed task request to the configured TaskHandler when present.
   *
   * How it does it (step by step):
   *   1. Reads deps.task — throws when undefined.
   *   2. Awaits deps.task(session, req, emit, signal) for streaming work.
   *
   * Parameters:
   *   @param {Session} session — Authenticated user + connection id.
   *   @param {TaskRequest} req — Parsed task JSON from the client.
   *   @param {(token: string) => void} emit — Callback for one streamed text chunk.
   *   @param {AbortSignal} signal — Aborts when the client disconnects or cancels.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the task handler finishes.
   *
   * @throws {Error} — When no task handler is configured.
   *
   * Dependencies:
   *   - RouterDeps.task — optional AdvisorOrchestrator entry point.
   *
   * Dependants:
   *   - RSocketServer.requestStream path.
   * </Summary>
   */
  routeTask = async (
    session: Session,
    req: TaskRequest,
    emit: (token: string) => void,
    signal: AbortSignal,
  ): Promise<void> => {
    const task = this.deps.task
    if (!task) {
      throw new Error('Task handler not configured')
    }
    await task(session, req, emit, signal)
  }
}
