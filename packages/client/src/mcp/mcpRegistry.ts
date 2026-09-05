/**
 * Generic multi-server MCP connection manager.
 *
 * @remarks
 * Generalizes what {@link "./tokenSaveClient.js"} did for a single hardcoded
 * server into an N-server registry: one connection (stdio or streamable
 * HTTP) per configured `mcpServers` entry, each with its own serialized
 * operation queue (an MCP stdio transport is not safe for concurrent use;
 * queuing per-server rather than globally lets independent servers proceed
 * in parallel). Also owns tool-name namespacing and the read-only lookup
 * the approval gate in `fileProxy/handlers/mcpHandlers.ts` consults.
 *
 * TokenSave is grandfathered as the one server whose tools keep their bare
 * `tokensave_*` names (existing prompts/docs/tests reference them directly,
 * and as the sole pre-existing server it has no collision to avoid). Every
 * other server's tools are namespaced `mcp__<serverId>__<toolName>` so two
 * servers can't collide on a shared tool name like `"search"`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerConfig } from "../config/types.js";

/** Prefix marking a namespaced (non-tokensave) tool name. */
export const MCP_NAMESPACE_PREFIX = "mcp__";

/**
 * Prefix marking an `mcpSecrets` entry as a raw HTTP header rather than the
 * bearer `token` field — `mcpSecrets[serverId]["header:X-Api-Key"]` becomes
 * the literal `X-Api-Key` request header. Lets a custom HTTP server
 * authenticate with something other than `Authorization: Bearer`.
 */
export const HEADER_SECRET_PREFIX = "header:";

/**
 * Builds the model-facing tool name for `toolName` on `serverId`.
 *
 * @example
 * ```ts
 * namespaceToolName("github", "create_issue"); // "mcp__github__create_issue"
 * namespaceToolName("tokensave", "tokensave_search"); // "tokensave_search"
 * ```
 */
export const namespaceToolName = (serverId: string, toolName: string): string =>
  serverId === "tokensave"
    ? toolName
    : `${MCP_NAMESPACE_PREFIX}${serverId}__${toolName}`;

/** Result of successfully splitting a namespaced tool name back into its parts. */
export type ParsedMcpTool = { serverId: string; toolName: string };

/**
 * Reverses {@link namespaceToolName}.
 *
 * @param namespacedName - A tool name as the model would call it.
 * @returns The server id and bare tool name, or `null` if `namespacedName`
 *   matches neither the `mcp__<server>__<tool>` shape nor a bare
 *   `tokensave_*` name.
 */
export const parseNamespacedTool = (
  namespacedName: string,
): ParsedMcpTool | null => {
  if (namespacedName.startsWith(MCP_NAMESPACE_PREFIX)) {
    const rest = namespacedName.slice(MCP_NAMESPACE_PREFIX.length);
    const separatorIndex = rest.indexOf("__");
    if (separatorIndex === -1) {
      return null;
    }
    return {
      serverId: rest.slice(0, separatorIndex),
      toolName: rest.slice(separatorIndex + 2),
    };
  }
  if (namespacedName.startsWith("tokensave_")) {
    return { serverId: "tokensave", toolName: namespacedName };
  }
  return null;
};

/** One tool as discovered from an MCP server, with read-only-ness already resolved. */
export type McpToolDef = {
  /** Bare tool name as the server itself advertises it (not namespaced). */
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** Resolved from the tool's own `annotations.readOnlyHint`, falling back to the server config's `readOnly`. */
  readOnly: boolean;
};

/** Metadata the approval gate needs for one namespaced tool. */
export type McpToolMetadata = {
  serverId: string;
  toolName: string;
  readOnly: boolean;
};

/** namespacedName -> metadata, populated at discovery/sync time. */
const toolRegistry = new Map<string, McpToolMetadata>();

/** Records a discovered tool's metadata for later approval-gate lookups. */
export const registerToolMetadata = (
  serverId: string,
  toolName: string,
  readOnly: boolean,
): void => {
  toolRegistry.set(namespaceToolName(serverId, toolName), {
    serverId,
    toolName,
    readOnly,
  });
};

/** Looks up a previously-registered tool's metadata by its namespaced (model-facing) name. */
export const getToolMetadata = (
  namespacedName: string,
): McpToolMetadata | undefined => toolRegistry.get(namespacedName);

/** @internal Test-only reset of the module-level tool registry. */
export const resetToolRegistryForTests = (): void => {
  toolRegistry.clear();
};

/**
 * Rebuilds the tool-metadata registry from scratch using cached discovery
 * results, with no network/spawn activity.
 *
 * @remarks
 * `toolRegistry` is normally populated as a side effect of {@link listMcpTools}
 * during real discovery. A cache hit skips discovery entirely, which used to
 * leave the registry empty — a cached tool would round-trip to the model
 * fine (the server already had it), but calling it failed closed at the
 * approval gate with "not allowed — it was not discovered from a connected
 * MCP server." Call this after every sync (cache hit or not) so the
 * registry always reflects the full set of tools actually available this
 * session.
 *
 * Synchronous, clear-then-rebuild: safe against the approval gate's
 * synchronous {@link getToolMetadata} read, which can never observe a
 * partially-rebuilt registry. An `inactive` entry (disabled server, cache
 * retained) is skipped, so its tools are neither callable nor listed.
 */
export const rebuildToolRegistry = (
  entries: Record<string, { tools: McpToolDef[]; inactive?: boolean }>,
): void => {
  toolRegistry.clear();
  for (const [serverId, entry] of Object.entries(entries)) {
    if (entry.inactive) {
      continue;
    }
    for (const tool of entry.tools) {
      registerToolMetadata(serverId, tool.name, tool.readOnly);
    }
  }
};

type ServerConnection = {
  client: Client;
};

const connections = new Map<string, ServerConnection>();

/**
 * Per-server operation queues, tracked independently of {@link connections}
 * so the very first call for a not-yet-connected server still serializes
 * correctly against a second call that arrives before the connection
 * finishes establishing (both would otherwise see "no connection yet" and
 * race to connect/spawn concurrently).
 */
const operationQueues = new Map<string, Promise<unknown>>();

/**
 * Serializes operations against one server's connection.
 *
 * @remarks
 * Per-server (not global): independent servers' calls can proceed in
 * parallel, but two calls to the same stdio-backed server never race on its
 * one transport — including the very first call, before any connection
 * exists yet.
 */
export const enqueueMcpOperation = <T>(
  serverId: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const priorQueue = operationQueues.get(serverId) ?? Promise.resolve();
  const run = priorQueue.then(operation, operation);
  operationQueues.set(
    serverId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
};

/** Builds the extra HTTP headers derived from one server's `mcpSecrets`. */
const buildHttpHeaders = (secrets: Record<string, string>): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (secrets.token) {
    headers.Authorization = `Bearer ${secrets.token}`;
  }
  for (const [key, value] of Object.entries(secrets)) {
    if (key.startsWith(HEADER_SECRET_PREFIX)) {
      headers[key.slice(HEADER_SECRET_PREFIX.length)] = value;
    }
  }
  return headers;
};

/** Which concrete HTTP transport class to build for a `transport: "http"` config. */
export type HttpTransportKind = "streamableHttp" | "sse";

/**
 * Builds the transport for one server's connection.
 *
 * @remarks
 * Exported (rather than module-private) so it's directly unit-testable —
 * {@link getMcpClient} is the only real caller. `httpKind` only applies to
 * `transport: "http"` configs; `getMcpClient` tries `"streamableHttp"`
 * first and falls back to `"sse"` on a connect failure (see below), since
 * most remote MCP servers speak streamable HTTP but some older ones only
 * speak SSE.
 *
 * @param serverId - Used only to name the server in a thrown error message.
 * @throws {@link Error} When `config.url` doesn't parse as a URL.
 */
export const buildTransport = (
  serverId: string,
  config: McpServerConfig,
  secrets: Record<string, string>,
  httpKind: HttpTransportKind = "streamableHttp",
): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport => {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      // The SDK merges this with its own curated safe-default environment
      // (PATH, HOME, …) rather than the full parent process env — so this
      // only needs to carry the credentials this server actually needs.
      env: secrets,
    });
  }

  let endpoint: URL;
  try {
    endpoint = new URL(config.url);
  } catch {
    throw new Error(`MCP server "${serverId}" has an invalid URL: ${config.url}`);
  }

  const headers = buildHttpHeaders(secrets);
  return httpKind === "sse"
    ? new SSEClientTransport(endpoint, { requestInit: { headers } })
    : new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } });
};

const closeConnectionIfCurrent = async (
  serverId: string,
  connection: ServerConnection,
): Promise<void> => {
  await connection.client.close();
  if (connections.get(serverId) === connection) {
    connections.delete(serverId);
  }
};

/**
 * Remembers which HTTP transport kind last successfully connected for a
 * server, so a later reconnect goes straight to the one that works instead
 * of re-probing streamable-HTTP-then-SSE every time. Cleared only when a
 * server is genuinely removed/dropped (see {@link disconnectMcpClient}'s
 * `forgetTransportKind` option) — a transient connect error mid-session
 * must not throw away a choice that was correct a moment ago.
 */
const httpTransportKindByServer = new Map<string, HttpTransportKind>();

/**
 * Pins `serverId`'s HTTP transport kind ahead of its first connect.
 *
 * @remarks
 * Used by `/mcp add ... --transport sse` (or `--transport http`) to skip
 * the streamable-HTTP-then-SSE probing dance entirely when the caller
 * already knows which one the server speaks.
 */
export const pinHttpTransportKind = (
  serverId: string,
  kind: HttpTransportKind,
): void => {
  httpTransportKindByServer.set(serverId, kind);
};

const connectAndStore = async (
  serverId: string,
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport,
): Promise<Client> => {
  const client = new Client({ name: "atlasagents", version: "1.0.0" });
  await client.connect(transport);
  connections.set(serverId, { client });
  return client;
};

/**
 * Returns a connected client for `serverId`, reusing an existing live
 * connection when one exists and reconnecting otherwise.
 *
 * @remarks
 * Liveness is checked with a cheap `listTools` call before reuse — mirrors
 * the pattern the single-server TokenSave client used, generalized to any
 * number of servers each tracked independently.
 *
 * For `transport: "http"`, tries streamable HTTP first (or whichever kind
 * previously won for this server), and falls back to SSE exactly once on
 * failure — some remote MCP servers still only speak the older SSE
 * transport. When both fail, the *original* (streamable-HTTP) error
 * propagates, since that's the transport most servers actually implement
 * and the more informative failure to surface.
 *
 * @param serverId - The `mcpServers` config key.
 * @param config - That server's connection shape.
 * @param secrets - That server's credential bundle from `mcpSecrets`.
 */
export const getMcpClient = async (
  serverId: string,
  config: McpServerConfig,
  secrets: Record<string, string>,
): Promise<Client> => {
  const existing = connections.get(serverId);
  if (existing) {
    try {
      await existing.client.listTools({});
      return existing.client;
    } catch {
      await closeConnectionIfCurrent(serverId, existing);
    }
  }

  if (config.transport !== "http") {
    return connectAndStore(serverId, buildTransport(serverId, config, secrets));
  }

  const preferredKind = httpTransportKindByServer.get(serverId) ?? "streamableHttp";
  try {
    const client = await connectAndStore(
      serverId,
      buildTransport(serverId, config, secrets, preferredKind),
    );
    httpTransportKindByServer.set(serverId, preferredKind);
    return client;
  } catch (error) {
    if (preferredKind === "sse") {
      throw error; // Already on the fallback kind — nothing left to try.
    }
    try {
      const client = await connectAndStore(
        serverId,
        buildTransport(serverId, config, secrets, "sse"),
      );
      httpTransportKindByServer.set(serverId, "sse");
      return client;
    } catch {
      throw error; // Propagate the original streamable-HTTP failure, not the fallback's.
    }
  }
};

/**
 * Closes and forgets the connection for `serverId`, if one exists.
 *
 * @param forgetTransportKind - Pass `true` only when `serverId` is being
 *   genuinely removed or dropped (e.g. `/mcp remove`, or a config change
 *   that drops it from `mcpServers` entirely) — clears the remembered
 *   streamable-HTTP-vs-SSE choice too, so a server later re-added under the
 *   same id re-probes from scratch rather than trusting a stale answer.
 *   Left `false` (default) for a transient reconnect, which should keep
 *   the remembered choice.
 */
export const disconnectMcpClient = async (
  serverId: string,
  { forgetTransportKind = false }: { forgetTransportKind?: boolean } = {},
): Promise<void> => {
  const existing = connections.get(serverId);
  if (existing) {
    await closeConnectionIfCurrent(serverId, existing);
  }
  if (forgetTransportKind) {
    httpTransportKindByServer.delete(serverId);
  }
};

/** @internal Test-only reset of the module-level HTTP-transport-kind memory. */
export const resetHttpTransportKindForTests = (): void => {
  httpTransportKindByServer.clear();
};

/** Closes every open connection — used on shutdown and between tests. */
export const disconnectAllMcpClients = async (): Promise<void> => {
  await Promise.all(
    Array.from(connections.keys()).map((serverId) =>
      disconnectMcpClient(serverId),
    ),
  );
};

/**
 * Resolves whether one discovered tool should be treated as read-only.
 *
 * @remarks
 * The tool's own MCP `annotations.readOnlyHint` wins when present; a
 * server-wide `readOnly` config override is the fallback; an unmarked tool
 * on a server with no override defaults to **not** read-only — the safer
 * default, since an unknown tool might mutate state.
 */
export const resolveToolReadOnly = (
  annotationsReadOnlyHint: boolean | undefined,
  serverConfig: McpServerConfig,
): boolean => annotationsReadOnlyHint ?? serverConfig.readOnly ?? false;

/**
 * Discovers every tool `serverId` exposes, paginating through `listTools`,
 * resolving each one's read-only-ness, and registering it for later
 * approval-gate lookups.
 *
 * @param serverId - The `mcpServers` config key.
 * @param config - That server's connection shape.
 * @param secrets - That server's credential bundle from `mcpSecrets`.
 * @returns The discovered tools (bare names, not namespaced).
 */
export const listMcpTools = async (
  serverId: string,
  config: McpServerConfig,
  secrets: Record<string, string>,
): Promise<McpToolDef[]> => {
  const client = await getMcpClient(serverId, config, secrets);
  const tools: McpToolDef[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    for (const tool of page.tools) {
      const readOnly = resolveToolReadOnly(
        tool.annotations?.readOnlyHint,
        config,
      );
      registerToolMetadata(serverId, tool.name, readOnly);
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: (tool.inputSchema ?? {
          type: "object",
          properties: {},
        }) as Record<string, unknown>,
        readOnly,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);

  return tools;
};

/**
 * Calls one tool on `serverId`, serialized against that server's queue.
 *
 * @param serverId - The `mcpServers` config key.
 * @param config - That server's connection shape.
 * @param secrets - That server's credential bundle from `mcpSecrets`.
 * @param toolName - Bare (non-namespaced) tool name.
 * @param args - Tool call arguments.
 */
export const callMcpToolOnServer = (
  serverId: string,
  config: McpServerConfig,
  secrets: Record<string, string>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> =>
  enqueueMcpOperation(serverId, async () => {
    try {
      const client = await getMcpClient(serverId, config, secrets);
      return await client.callTool({ name: toolName, arguments: args });
    } catch (error) {
      await disconnectMcpClient(serverId);
      throw error;
    }
  });
