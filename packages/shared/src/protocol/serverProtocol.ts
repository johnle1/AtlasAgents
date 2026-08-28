/**
 * Client→server RSocket protocol surface: the command/stream route names
 * and payload shapes a client sends to invoke server operations.
 *
 * @remarks
 * This is the inverse direction of {@link ClientRoute} in `clientProtocol.ts`
 * (server→client requests, e.g. the server asking the client to read a file
 * or run a shell command). The two protocols share no route names — this
 * file covers `models.*`, `config.*`, `providers.*`, `skills.sync`,
 * `memory.*`, `session.*`, `plan.respond`, `mcp.tools.sync` (commands) and
 * `task`/`models.pull`/`explore` (streams).
 */

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
  | "models.storage"
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
  "models.storage",
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
 * `isRouteId` but for streaming operations.
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
 * JSON body sent on `requestStream` when executing a user task.
 *
 * @remarks
 * Distinguishes streaming work from one-shot commands via `kind: "task"`.
 * Temperatures follow the usual sampling scale: `0` is deterministic; higher
 * values increase randomness. Model names must match what the target
 * provider has installed/available.
 *
 * @example
 * ```ts
 * const payload: TaskStreamPayload = {
 *   kind: "task",
 *   text: "Add unit tests for the banner layout helpers",
 *   subagentModel: "gemma3:27b",
 *   subsubagentModel: "gemma3:4b",
 *   agentProvider: "ollama",
 *   subagentProvider: "ollama",
 *   agentTemp: 0.2,
 *   subagentTemp: 0.3,
 * };
 * ```
 */
export type TaskStreamPayload = {
  /** Discriminator so the server treats this stream as task execution. */
  kind: "task";

  /** Natural-language task description from the user. */
  text: string;

  /** Subagent concurrency cap: `1` (focus), `2` (collab), `"max"`, or a custom number. */
  maxSubagents?: 1 | 2 | "max" | number;

  /** Model id for the agent role (planning / orchestration). */
  subagentModel: string;

  /** Model id for the subagent role (tool use / edits). */
  subsubagentModel: string;

  /** Provider serving the agent role (e.g. "ollama", "vllm-gpu"). */
  agentProvider: string;

  /** Provider serving the subagent role (e.g. "ollama", "vllm-gpu"). */
  subagentProvider: string;

  /** Agent sampling temperature in roughly `0.0`–`1.0`. */
  agentTemp: number;

  /** Subagent sampling temperature in roughly `0.0`–`1.0`. */
  subagentTemp: number;

  /**
   * Session approval mode. `"plan"` stops after confirm-plan; other values
   * execute. `"accept_edits"` / `"auto"` / `"bypass"` are client-side
   * permission policies the server does not enforce.
   */
  approvalMode?: TaskApprovalMode;

  /**
   * Client machine info, so the agent's `run_command` calls (which execute
   * on the client, not the server) use the right shell syntax. Optional —
   * an older client omitting this falls back to a POSIX/Linux default.
   */
  clientEnv?: ClientEnvPayload;
};

/** Client platform info reported with each task stream — see `TaskStreamPayload.clientEnv`. */
export type ClientEnvPayload = {
  /** Node's `process.platform` value, e.g. "darwin", "win32", "linux". */
  platform: string;
  /** Client shell, e.g. "/bin/zsh" or "cmd.exe" (best-effort, may be absent). */
  shell?: string;
  /** Free-form OS release string, e.g. "Darwin 25.6.0" (best-effort, may be absent). */
  osRelease?: string;
};

/**
 * Permission mode sent with a task stream.
 *
 * @remarks
 * Only `"plan"` changes server behavior (stop after confirm-plan).
 * Legacy `"auto_edit"` is accepted and treated like `"accept_edits"`.
 */
export type TaskApprovalMode =
  | "default"
  | "accept_edits"
  | "plan"
  | "auto"
  | "bypass"
  | "auto_edit";

/**
 * Coerces a task-payload approvalMode to a known token.
 *
 * @remarks
 * Legacy `"auto_edit"` becomes `"accept_edits"`. Unknown values become
 * `"default"` so an old or buggy client cannot strand the server.
 *
 * @param raw - Value from the stream payload.
 * @returns A known mode. `"plan"` is the only value the server special-cases.
 *
 * @example
 * ```ts
 * normalizeTaskApprovalMode("plan"); // "plan"
 * normalizeTaskApprovalMode("auto_edit"); // "accept_edits"
 * normalizeTaskApprovalMode("nope"); // "default"
 * ```
 */
export const normalizeTaskApprovalMode = (raw: unknown): TaskApprovalMode => {
  if (raw === "auto_edit") {
    return "accept_edits";
  }
  if (
    raw === "default" ||
    raw === "accept_edits" ||
    raw === "plan" ||
    raw === "auto" ||
    raw === "bypass"
  ) {
    return raw;
  }
  return "default";
};
