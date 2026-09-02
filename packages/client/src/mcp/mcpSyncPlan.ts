/**
 * Pure planning: decides which MCP servers need re-discovery vs. can be
 * served from cache, without touching disk, network, or spawning anything.
 *
 * @remarks
 * Three entry points cover the three ways a sync can be triggered:
 * - {@link planMcpSync} — startup/reconnect: reconcile the full cached state
 *   against the full desired state, discovering only what's new, changed,
 *   or expired.
 * - {@link planMcpMutation} — `/mcp add|remove|enable|disable`: the caller
 *   already knows exactly which one server changed, so the plan is decided
 *   without diffing against the rest of the cache at all.
 * - {@link planMcpRefresh} — `/mcp refresh`: force re-discovery regardless
 *   of marker match or pin status, for the one case where the user is
 *   explicitly saying "don't trust the cache this time."
 */

import { createHash } from "node:crypto";
import type { CachedEntry } from "./mcpToolsCache.js";

export type SyncPlan = {
  /** Cached tools can be reused as-is — no spawn, no round trip. */
  reuse: string[];
  /** Needs a fresh discovery pass (new, changed, expired, or forced). */
  discover: string[];
  /** Configured but disabled — retain cache, tear down any live connection. */
  deactivate: string[];
  /** No longer configured at all — evict cache entry, tear down connection. */
  drop: string[];
};

/** What `/mcp add|remove|enable|disable|refresh` tells the planner it already knows. */
export type McpSyncMutation =
  | { op: "add"; serverId: string }
  | { op: "remove"; serverId: string }
  | { op: "toggle"; serverId: string }
  | { op: "refresh"; serverId?: string };

/** Base TTL for an unpinned server's cached tools — see `isVersionPinned`. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Applies +/-20% deterministic jitter to `baseTtlMs`, keyed by `serverId`, so
 * a batch of servers cached at the same moment don't all expire at the same
 * instant and trigger a synchronized re-discovery storm.
 */
export const effectiveTtlMs = (
  serverId: string,
  baseTtlMs: number = DEFAULT_TTL_MS,
): number => {
  const digest = createHash("sha256").update(serverId).digest();
  const fraction = digest.readUInt32BE(0) / 0xffffffff; // 0..1, deterministic
  return Math.round(baseTtlMs * (0.8 + 0.4 * fraction));
};

/**
 * Whether a cached entry's tools can still be trusted without re-checking.
 *
 * @remarks
 * A version-pinned server (see `isVersionPinned`) is trusted indefinitely —
 * it cannot silently change. Everything else expires on a jittered TTL,
 * since e.g. `npx -y pkg` with no version resolves to latest on every spawn
 * and can change its tools with no config edit at all.
 */
export const isEntryFresh = (entry: CachedEntry, now: number): boolean =>
  entry.pinned || now - entry.discoveredAt <= effectiveTtlMs(entry.serverId);

/**
 * Diffs the persisted cache against the currently-desired server set.
 *
 * @param cached - Every persisted entry, keyed by `serverId` (includes
 *   disabled/inactive servers — they aren't dropped from disk).
 * @param desiredActive - Leaf marker for each currently *enabled* server
 *   (see `computeServerMarker`), plus `"tokensave"` when available.
 * @param desiredInactiveIds - Configured but `enabled: false` servers —
 *   distinguished from a true removal, which is anything in `cached` that's
 *   in neither set.
 * @param now - Injected for deterministic tests.
 */
export const planMcpSync = (
  cached: Record<string, CachedEntry>,
  desiredActive: Record<string, string>,
  desiredInactiveIds: ReadonlySet<string>,
  now: number,
): SyncPlan => {
  const reuse: string[] = [];
  const discover: string[] = [];
  const deactivate: string[] = [];
  const drop: string[] = [];

  for (const [serverId, marker] of Object.entries(desiredActive)) {
    const entry = cached[serverId];
    if (!entry || entry.marker !== marker || !isEntryFresh(entry, now)) {
      discover.push(serverId);
    } else {
      reuse.push(serverId);
    }
  }

  for (const serverId of desiredInactiveIds) {
    const entry = cached[serverId];
    if (entry && !entry.inactive) {
      deactivate.push(serverId);
    }
  }

  for (const serverId of Object.keys(cached)) {
    if (!(serverId in desiredActive) && !desiredInactiveIds.has(serverId)) {
      drop.push(serverId);
    }
  }

  return { reuse, discover, deactivate, drop };
};

/**
 * Plans a single mutation-triggered sync. `/mcp add|remove|enable|disable`
 * already knows exactly which server changed, so this touches only that one
 * entry — no diff against the rest of the cache, an O(1) decision.
 */
export const planMcpMutation = (
  mutation: { op: "add" | "remove" | "toggle"; serverId: string },
  cached: Record<string, CachedEntry>,
  desiredActive: Record<string, string>,
  desiredInactiveIds: ReadonlySet<string>,
  now: number,
): SyncPlan => {
  const empty: SyncPlan = { reuse: [], discover: [], deactivate: [], drop: [] };
  const { serverId } = mutation;

  if (mutation.op === "remove") {
    return { ...empty, drop: [serverId] };
  }
  if (mutation.op === "toggle" && desiredInactiveIds.has(serverId)) {
    return { ...empty, deactivate: [serverId] };
  }
  // "add", or "toggle" enabling a server.
  const marker = desiredActive[serverId];
  if (!marker) {
    return empty; // Shouldn't happen — defensive.
  }
  const entry = cached[serverId];
  if (entry && entry.marker === marker && isEntryFresh(entry, now)) {
    return { ...empty, reuse: [serverId] };
  }
  return { ...empty, discover: [serverId] };
};

/**
 * Plans a forced refresh (`/mcp refresh [name]`) — the one path that
 * re-checks a server regardless of marker match or pin status, since the
 * user is explicitly overriding the cache. Without `targetServerId`,
 * refreshes every currently-active server.
 */
export const planMcpRefresh = (
  cached: Record<string, CachedEntry>,
  desiredActive: Record<string, string>,
  desiredInactiveIds: ReadonlySet<string>,
  targetServerId?: string,
): SyncPlan => {
  const activeIds = Object.keys(desiredActive);
  const discover = targetServerId
    ? activeIds.filter((id) => id === targetServerId)
    : activeIds;
  const reuse = activeIds.filter((id) => !discover.includes(id));

  const deactivate: string[] = [];
  for (const serverId of desiredInactiveIds) {
    const entry = cached[serverId];
    if (entry && !entry.inactive) {
      deactivate.push(serverId);
    }
  }

  const drop: string[] = [];
  for (const serverId of Object.keys(cached)) {
    if (!(serverId in desiredActive) && !desiredInactiveIds.has(serverId)) {
      drop.push(serverId);
    }
  }

  return { reuse, discover, deactivate, drop };
};
