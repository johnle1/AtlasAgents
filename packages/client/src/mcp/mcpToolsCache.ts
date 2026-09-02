/**
 * Per-server disk cache of MCP tool discovery results.
 *
 * @remarks
 * One file per server (named by a hash of its serverId) inside
 * `mcpToolsCache/`, so a config change or discovery result for one server
 * costs an O(1) file write instead of rewriting every server's tools. Each
 * entry is validated independently: a content-based `marker` (see
 * `mcpServerMarkers.ts`) detects a config/secret change, and `discoveredAt`
 * + `pinned` decide how long a marker match can still be trusted — an
 * unpinned server (e.g. `npx -y pkg` with no version) can change its tools
 * without any config change at all, so it also expires on a TTL (see
 * `mcpSyncPlan.ts`); a version-pinned one is trusted indefinitely.
 *
 * Superseded the single-blob `mcpToolsCache.json`, which keyed everything on
 * one opaque marker (`config.json`'s mtime + workspace root + TokenSave
 * state) — any config write invalidated every server's tools at once. A
 * leftover file from that era is deleted on read; the one-time discovery
 * cost that causes is preferable to trying to split its flat tool array
 * back apart by server.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CONFIG_DIR, ensureDirs } from "../config/index.js";
import type { McpToolDef } from "./mcpRegistry.js";

const CACHE_DIR = path.join(CONFIG_DIR, "mcpToolsCache");
const LEGACY_CACHE_FILE = path.join(CONFIG_DIR, "mcpToolsCache.json");

/** One server's cached discovery result. */
export type CachedEntry = {
  serverId: string;
  /** Content fingerprint of that server's config + secrets — see `computeServerMarker`. */
  marker: string;
  tools: McpToolDef[];
  /** `Date.now()` when this entry was last (re)discovered. */
  discoveredAt: number;
  /** Version-pinned servers never expire on TTL — see `isVersionPinned`. */
  pinned: boolean;
  /** Disabled via `/mcp disable` — retained so `/mcp enable` needs no re-discovery. */
  inactive?: boolean;
};

const fileNameFor = (serverId: string): string =>
  `${createHash("sha256").update(serverId).digest("hex")}.json`;

/** Removes the pre-migration single-blob cache file, if it's still there. */
const cleanupLegacyCache = (): void => {
  try {
    fs.unlinkSync(LEGACY_CACHE_FILE);
  } catch {
    // Already gone, or never existed — nothing to do.
  }
};

/**
 * Loads every persisted cache entry, keyed by `serverId`.
 *
 * @remarks
 * Skips individually unparseable files rather than failing the whole load —
 * one corrupt entry shouldn't force every server back through discovery.
 */
export const loadMcpToolsCache = (): Record<string, CachedEntry> => {
  cleanupLegacyCache();
  const entries: Record<string, CachedEntry> = {};
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(CACHE_DIR);
  } catch {
    return entries;
  }
  for (const fileName of fileNames) {
    try {
      const raw = fs.readFileSync(path.join(CACHE_DIR, fileName), "utf-8");
      const entry = JSON.parse(raw) as CachedEntry;
      if (entry && typeof entry.serverId === "string") {
        entries[entry.serverId] = entry;
      }
    } catch {
      // Corrupt file — skip it, that server just re-discovers this sync.
    }
  }
  return entries;
};

/** Persists one server's entry, atomically (temp file + rename). */
export const writeCacheEntry = (entry: CachedEntry): void => {
  ensureDirs();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const destination = path.join(CACHE_DIR, fileNameFor(entry.serverId));
  const tempPath = path.join(CACHE_DIR, `.tmp-${randomUUID()}.json`);
  fs.writeFileSync(tempPath, JSON.stringify(entry), { encoding: "utf-8" });
  fs.renameSync(tempPath, destination);
};

/** Deletes one server's cache entry, if present. */
export const deleteCacheEntry = (serverId: string): void => {
  try {
    fs.unlinkSync(path.join(CACHE_DIR, fileNameFor(serverId)));
  } catch {
    // Already gone.
  }
};
