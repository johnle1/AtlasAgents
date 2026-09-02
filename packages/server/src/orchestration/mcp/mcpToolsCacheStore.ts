/**
 * Disk-persisted cache of discovered MCP tools, keyed by client + workspace,
 * so a reconnecting client can skip re-discovery when nothing changed.
 *
 * @remarks
 * Keyed by `(clientId, workspaceRoot)`, not workspace alone — this server
 * supports multiple different clients sharing one instance with no per-user
 * auth identity (every authenticated client resolves to the same `"shared"`
 * user id — see `auth/middleware.ts`), so a cache keyed only by workspace
 * path could serve one client another client's cached tools if they happened
 * to report the same path. `clientId` is a random value the client generates
 * once and persists locally (see the client's `config/clientId.ts`) — not a
 * security boundary, just enough to keep different installations' cache
 * entries from colliding.
 *
 * Persisted to disk (not just kept in memory, unlike `PerConnection` state)
 * so the cache survives both a client reconnect *and* a server restart —
 * `PerConnection` is deliberately torn down on every disconnect, which is
 * exactly what made an in-memory-only cache useless for this problem.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteJson } from "../../utils/atomicWriteJson.js";
import type { McpToolSyncPayload } from "./mcpToolSchema.js";

const CACHE_REL_PATH = "user-data/mcpToolsCache.json";

/**
 * `tools` here is the raw payload as the client sent it (pre-`ToolSchema`
 * conversion) — not `McpToolEntry[]` (the server's internal, already-
 * converted registry shape). A `sync.check` hit hands this same raw shape
 * straight back to the client, which reuses it as-is (both sides use the
 * same `{ name, description?, inputSchema, readOnly? }` shape); the check
 * handler converts to `McpToolEntry[]` only for `perConnection.mcpTools`.
 *
 * `marker` is an opaque composite string (config mtime + workspaceRoot +
 * TokenSave install/index state — see the client's
 * `mcp/mcpToolsCache.ts`), compared by **equality**, not ordering: unlike a
 * timestamp it isn't monotonic (e.g. deleting `.tokensave/` flips a boolean
 * back), so "newest wins" doesn't apply here — only "identical or not".
 */
type CacheEntry = { marker: string; tools: McpToolSyncPayload[] };

const cacheKey = (clientId: string, workspaceRoot: string): string =>
  `${clientId}::${workspaceRoot}`;

/**
 * @example
 * ```ts
 * const store = new McpToolsCacheStore({ rootDir: dataRootDirectory });
 * const entry = store.get(clientId, workspaceRoot);
 * if (!entry || entry.marker !== marker) {
 *   // re-discover, then:
 *   await store.set(clientId, workspaceRoot, marker, tools);
 * }
 * ```
 */
export class McpToolsCacheStore {
  private readonly filePath: string;
  private entries: Record<string, CacheEntry>;

  constructor(dependencies: { rootDir: string }) {
    this.filePath = path.join(dependencies.rootDir, CACHE_REL_PATH);
    this.entries = this.loadFromDisk();
  }

  private loadFromDisk(): Record<string, CacheEntry> {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, CacheEntry>)
        : {};
    } catch {
      return {};
    }
  }

  /** Returns the cached entry for `(clientId, workspaceRoot)`, if any. */
  get(clientId: string, workspaceRoot: string): CacheEntry | undefined {
    return this.entries[cacheKey(clientId, workspaceRoot)];
  }

  /** Persists `tools` for `(clientId, workspaceRoot)`, tagged with `marker`. */
  async set(
    clientId: string,
    workspaceRoot: string,
    marker: string,
    tools: McpToolSyncPayload[],
  ): Promise<void> {
    this.entries[cacheKey(clientId, workspaceRoot)] = { marker, tools };
    await atomicWriteJson(this.filePath, this.entries, "mcpToolsCache");
  }
}
