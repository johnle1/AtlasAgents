/**
 * TokenSave CLI slash commands and bootstrap helpers (`/tokensave`).
 *
 * @remarks
 * TokenSave is an optional local indexer (`tokensave` on `PATH`) used for
 * faster workspace search. These helpers check install/index state, run
 * `tokensave init` with approval, sync curated MCP tools to the server, and
 * print status via the MCP bridge.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Connection } from "../connection/index.js";
import type { LocalFileProxy } from "../localFileProxy.js";
import { loadConfig, updateConfig } from "../config/index.js";
import type { McpServerConfig } from "../config/types.js";
import { printError, printLine, printSuccess } from "../renderer.js";
import { requestApprovalWithFeedback } from "../ui/approvalFlow.js";
import { refreshInkBanner } from "../ui/uiBridge.js";
import { callTokenSaveTool } from "../mcp/mcpBridge.js";
import {
  enqueueTokenSaveOperation,
  getTokenSaveClient,
  hasTokenSaveIndex,
  isTokenSaveOnPath,
  listCuratedTools,
} from "../mcp/tokenSaveClient.js";
import {
  disconnectMcpClient,
  listMcpTools,
  namespaceToolName,
  parseNamespacedTool,
  rebuildToolRegistry,
  type McpToolDef,
} from "../mcp/mcpRegistry.js";
import {
  deleteCacheEntry,
  loadMcpToolsCache,
  writeCacheEntry,
  type CachedEntry,
} from "../mcp/mcpToolsCache.js";
import {
  computeRootMarker,
  computeServerMarker,
  isVersionPinned,
} from "../mcp/mcpServerMarkers.js";
import {
  planMcpMutation,
  planMcpRefresh,
  planMcpSync,
  type McpSyncMutation,
  type SyncPlan,
} from "../mcp/mcpSyncPlan.js";
import { getClientId } from "../config/clientId.js";
import {
  fromServerConfigValues,
  toServerConfigValues,
  type ServerConfigValues,
} from "../config/serverConfigTranslation.js";
import { formatErrorMessage } from "./utils.js";

/** Response shape for the `sync.check` route — see `routerBuilder.ts`'s `createSyncCheckHandler`. */
type SyncCheckResponse = {
  mcp?: { upToDate: boolean; tools?: McpToolDef[] };
  config?:
    | { winner: "client" | "same"; changedAt: number }
    | { winner: "server"; changedAt: number; values: ServerConfigValues };
};

/**
 * Applies a `sync.check` config-reconciliation result locally.
 *
 * @remarks
 * `"client"`/`"same"` need no local write — the client's own values are
 * already what they should be (the server either just adopted them, or
 * nothing differs). `"server"` means the server's copy is newer: adopt its
 * values and bump the local `configChangedAt` to match, so both sides agree
 * exactly and a future comparison resolves to `"same"` rather than
 * re-triggering on the next connection.
 */
const applyConfigSyncResult = (result: SyncCheckResponse["config"]): void => {
  if (!result || result.winner !== "server") {
    return;
  }
  const updated = updateConfig({
    ...fromServerConfigValues(result.values),
    configChangedAt: result.changedAt,
  });
  refreshInkBanner(updated);
  printLine(
    `  Config updated from server: ${result.values.agentModel || "(agent model unset)"} / ${
      result.values.subagentModel || "(subagent model unset)"
    }`,
  );
};

const execFileAsync = promisify(execFile);

/**
 * Runs `tokensave init` in the given workspace.
 *
 * @remarks
 * Isolated as its own function (rather than an inline `execFileAsync` call in
 * {@link handleTokenSave}) so the actual process spawn is a single, swappable
 * seam — e.g. for a future test double — instead of buried inside a large
 * switch-case handler. Uses `execFile` (not a shell) so `init` is not
 * re-parsed by `/bin/sh`.
 *
 * @param workspaceRoot - Absolute path to run `tokensave init` in.
 */
const runTokenSaveInit = (workspaceRoot: string): Promise<unknown> =>
  execFileAsync("tokensave", ["init"], { cwd: workspaceRoot });

/**
 * Pretty-prints MCP / TokenSave tool payloads for the terminal.
 *
 * @param data - String or JSON-serializable value from the tool result.
 * @returns Display string (unchanged if already a string).
 */
const formatMcpData = (data: unknown): string => {
  if (typeof data === "string") {
    return data;
  }
  return JSON.stringify(data, null, 2);
};

/**
 * Discovers curated TokenSave tools and syncs them to the server.
 *
 * @remarks
 * No-ops (returns `0`) when `tokensave` is missing from `PATH` or the workspace
 * has no `.tokensave` index yet. Otherwise enqueues work on the TokenSave
 * client and sends `mcp.tools.sync` with the curated tool list.
 *
 * @param conn - Live RSocket connection.
 * @param workspaceRoot - Absolute workspace path used for the TokenSave client.
 * @returns Number of tools synced, or `0` when skipped / empty.
 *
 * @example
 * ```ts
 * const n = await syncTokenSaveTools(connection, "/proj");
 * ```
 */
export const syncTokenSaveTools = async (
  conn: Connection,
  workspaceRoot: string,
): Promise<number> => {
  if (!(await isTokenSaveOnPath())) {
    return 0;
  }
  if (!(await hasTokenSaveIndex(workspaceRoot))) {
    return 0;
  }

  return enqueueTokenSaveOperation(async () => {
    const client = await getTokenSaveClient(workspaceRoot);
    const tools = await listCuratedTools(client);
    if (tools.length === 0) {
      return 0;
    }

    await conn.sendCommand("mcp.tools.sync", { tools });
    return tools.length;
  });
};

/** Re-exported so callers (`mcpHandlers.ts`) don't need to import `mcp/mcpSyncPlan.js` directly. */
export type { McpSyncMutation };

/** How many servers `syncAllMcpTools` will discover concurrently during a full (non-mutation) plan. */
const DISCOVERY_CONCURRENCY = 6;

/** Runs `items` through `fn` with at most `limit` in flight at once. */
const mapWithConcurrency = async (
  items: string[],
  limit: number,
  fn: (item: string) => Promise<void>,
): Promise<void> => {
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < items.length) {
      const item = items[index++]!;
      await fn(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
};

/**
 * Discovers one server's tools and writes its cache entry.
 *
 * @remarks
 * On failure, leaves `cached`/disk untouched — a transient connect failure
 * must not overwrite a good previous entry with an empty one, nor fabricate
 * a fresh "no tools" entry that would then look authoritative until the
 * next config change.
 */
const discoverServer = async (
  serverId: string,
  serverConfig: McpServerConfig,
  secrets: Record<string, string>,
  marker: string,
  cached: Record<string, CachedEntry>,
): Promise<void> => {
  try {
    const tools = await listMcpTools(serverId, serverConfig, secrets);
    const entry: CachedEntry = {
      serverId,
      marker,
      tools,
      discoveredAt: Date.now(),
      pinned: isVersionPinned(serverConfig),
    };
    writeCacheEntry(entry);
    cached[serverId] = entry;
  } catch (error) {
    printError(
      `MCP server "${serverId}" failed to connect: ${formatErrorMessage(error)}`,
    );
  }
};

/** Discovers TokenSave's curated tools and writes its (reserved-serverId) cache entry. */
const discoverTokenSave = async (
  workspaceRoot: string,
  marker: string,
  cached: Record<string, CachedEntry>,
): Promise<void> => {
  try {
    const tokenSaveTools = await enqueueTokenSaveOperation(async () => {
      const client = await getTokenSaveClient(workspaceRoot);
      return listCuratedTools(client);
    });
    // Every TokenSave tool is a read-only search/lookup — see
    // ALLOWED_TOKENSAVE_TOOLS in mcp/tokenSaveClient.ts.
    const tools: McpToolDef[] = tokenSaveTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      readOnly: true,
    }));
    const entry: CachedEntry = {
      serverId: "tokensave",
      marker,
      tools,
      discoveredAt: Date.now(),
      pinned: false,
    };
    writeCacheEntry(entry);
    cached.tokensave = entry;
  } catch (error) {
    printError(`TokenSave failed to provide tools: ${formatErrorMessage(error)}`);
  }
};

/** Executes a {@link SyncPlan} against live connections and the on-disk cache. */
const applyMcpSyncPlan = async (
  plan: SyncPlan,
  workspaceRoot: string,
  mcpServers: Record<string, McpServerConfig>,
  mcpSecrets: Record<string, Record<string, string>>,
  desiredActive: Record<string, string>,
  cached: Record<string, CachedEntry>,
): Promise<void> => {
  for (const serverId of plan.drop) {
    await disconnectMcpClient(serverId, { forgetTransportKind: true });
    deleteCacheEntry(serverId);
    delete cached[serverId];
  }

  for (const serverId of plan.deactivate) {
    await disconnectMcpClient(serverId);
    const entry = cached[serverId];
    if (entry) {
      const updated: CachedEntry = { ...entry, inactive: true };
      writeCacheEntry(updated);
      cached[serverId] = updated;
    }
  }

  const discoverTokenSaveNow = plan.discover.includes("tokensave");
  const discoverServerIds = plan.discover.filter((id) => id !== "tokensave");

  await Promise.all([
    discoverTokenSaveNow
      ? discoverTokenSave(workspaceRoot, desiredActive.tokensave!, cached)
      : Promise.resolve(),
    mapWithConcurrency(discoverServerIds, DISCOVERY_CONCURRENCY, async (serverId) => {
      const serverConfig = mcpServers[serverId];
      if (!serverConfig) {
        return;
      }
      await discoverServer(
        serverId,
        serverConfig,
        mcpSecrets[serverId] ?? {},
        desiredActive[serverId]!,
        cached,
      );
    }),
  ]);

  // A previously-inactive entry that's back in the reused set (a re-enabled
  // server whose config didn't change) must have its flag cleared, or it
  // would be silently excluded from both the outgoing payload and the tool
  // registry below.
  for (const serverId of plan.reuse) {
    const entry = cached[serverId];
    if (entry?.inactive) {
      const updated: CachedEntry = { ...entry, inactive: false };
      writeCacheEntry(updated);
      cached[serverId] = updated;
    }
  }
};

/**
 * Reconstructs the per-server local cache from a `sync.check` hit's flat
 * tool list, so a warm restore from the server's own persisted cache also
 * warms up future mutation-triggered syncs (which never ask the server).
 */
const seedCacheFromFlatTools = (
  tools: McpToolDef[],
  mcpServers: Record<string, McpServerConfig>,
  desiredActive: Record<string, string>,
): void => {
  const byServerId = new Map<string, McpToolDef[]>();
  for (const tool of tools) {
    const parsed = parseNamespacedTool(tool.name);
    if (!parsed) {
      continue; // Can't attribute to a server — self-heals next full discovery.
    }
    const list = byServerId.get(parsed.serverId) ?? [];
    list.push({ ...tool, name: parsed.toolName });
    byServerId.set(parsed.serverId, list);
  }
  const now = Date.now();
  for (const [serverId, serverTools] of byServerId) {
    const marker = desiredActive[serverId];
    if (!marker) {
      continue;
    }
    writeCacheEntry({
      serverId,
      marker,
      tools: serverTools,
      discoveredAt: now,
      pinned:
        serverId === "tokensave" ? false : isVersionPinned(mcpServers[serverId]!),
    });
  }
};

/**
 * Syncs tools from TokenSave (if available) and every configured `mcpServers`
 * entry to the server, and reconciles the plaintext config overlap. Called
 * whenever *anything* about the configured server set (or config) might have
 * changed: bootstrap, `/mcp add|remove|enable|disable|refresh`, `/tokensave
 * init`'s post-init sync, and reconnect.
 *
 * @remarks
 * `mcp.tools.sync` **replaces** the server's whole tool list per call (see
 * `routerBuilder.ts`'s `createMcpToolsSyncHandler`) — so unlike
 * {@link syncTokenSaveTools}, which sends only TokenSave's tools and would
 * silently wipe out any already-synced GitHub/Jira/Slack tools, this
 * function always sends the complete set. A server that fails to connect is
 * skipped with a printed warning rather than failing the whole sync — one
 * misconfigured server shouldn't take down every other one's tools.
 *
 * Discovery (spawning `stdio` MCP servers, `http` handshakes) only runs for
 * servers that actually need it:
 * - `mutation` — `/mcp add|remove|enable|disable` already knows exactly
 *   which one server changed, so the decision is made locally with no
 *   network round trip at all (see `mcpSyncPlan.ts`'s `planMcpMutation`).
 *   `/mcp refresh` (`planMcpRefresh`) is the one path that forces
 *   re-discovery regardless of cache freshness or pin status.
 * - Otherwise (bootstrap/reconnect) — `sync.check` is tried first, a network
 *   round trip against the server's own disk-persisted cache
 *   (`McpToolsCacheStore`), which can restore a warm state even after the
 *   *local* per-server cache was wiped. A hit seeds the local cache for next
 *   time. A miss falls through to {@link planMcpSync}'s reconciliation: a
 *   content-based marker (see `mcpServerMarkers.ts`) per server, so only
 *   servers that are new, changed, or past their freshness TTL are
 *   discovered — everything else is served straight from the local cache
 *   with zero spawns.
 *
 * The config-reconciliation half (see {@link applyConfigSyncResult}) only
 * runs on the `sync.check` path, since it's unrelated to which MCP servers
 * changed.
 *
 * `clientId` (a random value persisted locally, see `config/clientId.js`)
 * disambiguates the server's MCP cache between different installations that
 * might report the same `workspaceRoot` — this server allows multiple
 * clients to share one instance with no per-user identity, so workspace path
 * alone isn't a safe cache key.
 *
 * @param conn - Live RSocket connection.
 * @param workspaceRoot - Absolute workspace path used for the TokenSave client.
 * @param mutation - What the caller already knows changed, if this sync was
 *   triggered by a specific `/mcp` command rather than bootstrap/reconnect.
 * @returns Total number of MCP tools synced across every server.
 */
export const syncAllMcpTools = async (
  conn: Connection,
  workspaceRoot: string,
  mutation?: McpSyncMutation,
): Promise<number> => {
  const clientId = getClientId();
  const [tokenSaveOnPath, tokenSaveIndexed] = await Promise.all([
    isTokenSaveOnPath(),
    hasTokenSaveIndex(workspaceRoot),
  ]);

  // A config read failure degrades to "no configured servers" rather than
  // propagating — TokenSave's own tools (handled separately) shouldn't sink.
  let mcpServers: Record<string, McpServerConfig> = {};
  let mcpSecrets: Record<string, Record<string, string>> = {};
  try {
    const config = loadConfig();
    mcpServers = config.mcpServers;
    mcpSecrets = config.mcpSecrets;
  } catch (error) {
    printError(`Could not read MCP server config: ${formatErrorMessage(error)}`);
  }

  const desiredActive: Record<string, string> = {};
  const desiredInactiveIds = new Set<string>();
  if (tokenSaveOnPath && tokenSaveIndexed) {
    desiredActive.tokensave = `${tokenSaveOnPath}::${tokenSaveIndexed}`;
  }
  for (const [serverId, serverConfig] of Object.entries(mcpServers)) {
    if (serverConfig.enabled === false) {
      desiredInactiveIds.add(serverId);
    } else {
      desiredActive[serverId] = computeServerMarker(
        serverId,
        serverConfig,
        mcpSecrets[serverId] ?? {},
      );
    }
  }

  const mcpMarker = computeRootMarker(desiredActive);

  const cached = loadMcpToolsCache();
  const plan: SyncPlan = mutation
    ? mutation.op === "refresh"
      ? planMcpRefresh(cached, desiredActive, desiredInactiveIds, mutation.serverId)
      : planMcpMutation(mutation, cached, desiredActive, desiredInactiveIds, Date.now())
    : planMcpSync(cached, desiredActive, desiredInactiveIds, Date.now());

  // Mutation-triggered syncs already know exactly what changed — skip the
  // network round trip and act directly (an O(1) decision instead of asking
  // the server to confirm what we already know). A no-op local plan (every
  // active server already reused, nothing to drop/deactivate) means our own
  // cache already answers the question, so there's nothing for the server's
  // copy to add either — asking would just be a redundant round trip.
  // Otherwise (bootstrap/reconnect with something the local cache can't
  // resolve) probe first: the server's own persisted cache can restore a
  // warm state even after the *local* cache was wiped by hand.
  const planIsNoop =
    plan.discover.length === 0 &&
    plan.deactivate.length === 0 &&
    plan.drop.length === 0;

  if (!mutation && !planIsNoop) {
    let configHalf: { changedAt: number; values: ServerConfigValues } | undefined;
    try {
      const localConfig = loadConfig();
      configHalf = {
        changedAt: localConfig.configChangedAt,
        values: toServerConfigValues(localConfig),
      };
    } catch {
      // A config read failure here just means the config half of sync.check
      // is skipped this round — it must not block the MCP half.
    }

    try {
      const check = await conn.sendCommand<SyncCheckResponse>("sync.check", {
        workspaceRoot,
        clientId,
        mcpMarker,
        config: configHalf,
      });
      applyConfigSyncResult(check.config);
      if (check.mcp?.upToDate) {
        const tools = check.mcp.tools ?? [];
        seedCacheFromFlatTools(tools, mcpServers, desiredActive);
        rebuildToolRegistry(loadMcpToolsCache());
        return tools.length;
      }
    } catch {
      // Old server without this route, or a transient failure — fall
      // through to the local plan exactly as before this optimization
      // existed.
    }
  }

  await applyMcpSyncPlan(
    plan,
    workspaceRoot,
    mcpServers,
    mcpSecrets,
    desiredActive,
    cached,
  );

  rebuildToolRegistry(cached);

  const payload: McpToolDef[] = [];
  for (const serverId of ["tokensave", ...Object.keys(mcpServers)]) {
    const entry = cached[serverId];
    if (!entry || entry.inactive) {
      continue;
    }
    for (const tool of entry.tools) {
      payload.push({
        name: namespaceToolName(serverId, tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnly: tool.readOnly,
      });
    }
  }

  if (payload.length === 0) {
    return 0;
  }

  await conn.sendCommand("mcp.tools.sync", {
    tools: payload,
    workspaceRoot,
    clientId,
    mcpMarker,
  });
  return payload.length;
};

/**
 * Prints a one-line tip to run `/tokensave init` when indexing would help.
 *
 * @remarks
 * Silent when TokenSave is not installed or an index already exists — avoids
 * nagging on every startup in those cases.
 *
 * @param workspaceRoot - Absolute workspace path to inspect.
 */
export const printTokenSaveInitTip = async (
  workspaceRoot: string,
): Promise<void> => {
  if (!(await isTokenSaveOnPath())) {
    return;
  }
  if (await hasTokenSaveIndex(workspaceRoot)) {
    return;
  }
  printLine(
    "  Tip: run /tokensave init for faster code search this session.",
  );
};

/**
 * Routes `/tokensave init | status`.
 *
 * @remarks
 * - `init` — requires `tokensave` on PATH, user approval, then `tokensave init`
 *   in the workspace and an optional tool sync
 * - `status` — calls the `tokensave_status` MCP tool and prints its data
 *
 * Workspace root comes from {@link LocalFileProxy.getWorkspaceRoot} when the
 * proxy is available, otherwise `process.cwd()`.
 *
 * @param sub - Subcommand after `/tokensave`.
 * @param _arg - Unused (reserved for future flags).
 * @param conn - Live RSocket connection for tool sync after init.
 * @param fileProxy - Optional proxy for resolving the workspace root.
 *
 * @example
 * ```ts
 * await handleTokenSave("init", "", connection, fileProxy);
 * await handleTokenSave("status", "", connection, fileProxy);
 * ```
 */
export const handleTokenSave = async (
  sub: string,
  _arg: string,
  conn: Connection,
  fileProxy?: LocalFileProxy,
): Promise<void> => {
  const workspaceRoot = fileProxy?.getWorkspaceRoot() ?? process.cwd();

  switch (sub) {
    case "init": {
      if (!(await isTokenSaveOnPath())) {
        printError(
          "TokenSave is not installed. Install it with: cargo install tokensave",
        );
        return;
      }

      if (await hasTokenSaveIndex(workspaceRoot)) {
        printSuccess("TokenSave is already initialized for this workspace.");
        return;
      }

      const { approved } = await requestApprovalWithFeedback(
        {
          type: "keepUndo",
          contextLabel:
            "Initialize TokenSave index (.tokensave/ folder will be created)",
        },
        "What should change?",
      );

      if (!approved) {
        printLine("TokenSave init cancelled.");
        return;
      }

      try {
        await runTokenSaveInit(workspaceRoot);
        printSuccess("TokenSave initialized. Syncing tools to server...");
        // syncAllMcpTools, not syncTokenSaveTools — mcp.tools.sync replaces
        // the whole tool list, so this must re-sync every configured MCP
        // server too, or this init would wipe out any of them already synced.
        const synced = await syncAllMcpTools(conn, workspaceRoot);
        if (synced > 0) {
          printSuccess(`Synced ${synced} tool(s) to server.`);
        }
      } catch (err) {
        printError(`TokenSave init failed: ${formatErrorMessage(err)}`);
      }
      break;
    }
    case "status": {
      try {
        const result = await callTokenSaveTool(
          workspaceRoot,
          "tokensave_status",
          {},
        );
        if (result.isError) {
          printError(result.errorMessage ?? "TokenSave status failed");
          return;
        }
        printLine(formatMcpData(result.data));
      } catch (err) {
        printError(`TokenSave status failed: ${formatErrorMessage(err)}`);
      }
      break;
    }
    default:
      printError("Usage: /tokensave init | /tokensave status");
  }
};
