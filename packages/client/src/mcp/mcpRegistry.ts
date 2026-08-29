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
import type { McpServerConfig } from "../config/types.js";

/** Prefix marking a namespaced (non-tokensave) tool name. */
export const MCP_NAMESPACE_PREFIX = "mcp__";

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

const buildTransport = (
  config: McpServerConfig,
  secrets: Record<string, string>,
): StdioClientTransport | StreamableHTTPClientTransport => {
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
  const headers: Record<string, string> = {};
  if (secrets.token) {
    headers.Authorization = `Bearer ${secrets.token}`;
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
  });
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
 * Returns a connected client for `serverId`, reusing an existing live
 * connection when one exists and reconnecting otherwise.
 *
 * @remarks
 * Liveness is checked with a cheap `listTools` call before reuse — mirrors
 * the pattern the single-server TokenSave client used, generalized to any
 * number of servers each tracked independently.
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

  const transport = buildTransport(config, secrets);
  const client = new Client({ name: "atlasagents", version: "1.0.0" });
  await client.connect(transport);
  connections.set(serverId, { client });
  return client;
};

/** Closes and forgets the connection for `serverId`, if one exists. */
export const disconnectMcpClient = async (serverId: string): Promise<void> => {
  const existing = connections.get(serverId);
  if (existing) {
    await closeConnectionIfCurrent(serverId, existing);
  }
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
