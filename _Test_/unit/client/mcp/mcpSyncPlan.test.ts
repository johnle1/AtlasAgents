/**
 * Unit tests — client mcp/mcpSyncPlan.ts
 *
 * Pure planning logic — no mocks, no disk, no network. This is the core of
 * the O(N) -> O(Δ) MCP sync optimization: verifies that touching one server
 * never triggers work for any other server.
 *
 * Category checklist:
 * - Normal: add/remove/change one server only affects that server
 * - Boundary: disable-then-enable round trip reuses cache, TTL/pin edges
 * - Error: expired unpinned entry still discovers; pinned entry never does
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_MS,
  effectiveTtlMs,
  isEntryFresh,
  planMcpMutation,
  planMcpRefresh,
  planMcpSync,
} from "../../../../packages/client/src/mcp/mcpSyncPlan.js";
import type { CachedEntry } from "../../../../packages/client/src/mcp/mcpToolsCache.js";

const entry = (overrides: Partial<CachedEntry> & { serverId: string }): CachedEntry => ({
  marker: "m",
  tools: [],
  discoveredAt: Date.now(),
  pinned: false,
  ...overrides,
});

describe("effectiveTtlMs", () => {
  it("stays within +/-20% of the base TTL (normal)", () => {
    const ttl = effectiveTtlMs("some-server", DEFAULT_TTL_MS);
    expect(ttl).toBeGreaterThanOrEqual(DEFAULT_TTL_MS * 0.8);
    expect(ttl).toBeLessThanOrEqual(DEFAULT_TTL_MS * 1.2);
  });

  it("is deterministic for the same serverId (normal — stable across runs)", () => {
    expect(effectiveTtlMs("github")).toBe(effectiveTtlMs("github"));
  });

  it("differs across serverIds, spreading out expiry (boundary — avoids a thundering herd)", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const ttls = new Set(ids.map((id) => effectiveTtlMs(id)));
    expect(ttls.size).toBeGreaterThan(1);
  });
});

describe("isEntryFresh", () => {
  it("a pinned entry is always fresh, no matter how old (normal)", () => {
    const old = entry({ serverId: "s", pinned: true, discoveredAt: 0 });
    expect(isEntryFresh(old, Date.now() + DEFAULT_TTL_MS * 100)).toBe(true);
  });

  it("an unpinned entry expires past its TTL (normal)", () => {
    const e = entry({ serverId: "s", pinned: false, discoveredAt: 0 });
    expect(isEntryFresh(e, effectiveTtlMs("s") + 1)).toBe(false);
  });

  it("an unpinned entry is fresh just before its TTL (boundary)", () => {
    const e = entry({ serverId: "s", pinned: false, discoveredAt: 1000 });
    expect(isEntryFresh(e, 1000 + effectiveTtlMs("s") - 1)).toBe(true);
  });
});

describe("planMcpSync", () => {
  it("adding one server only discovers that server (normal — the core O(Δ) guarantee)", () => {
    const cached = {
      a: entry({ serverId: "a", marker: "ma" }),
      b: entry({ serverId: "b", marker: "mb" }),
    };
    const plan = planMcpSync(cached, { a: "ma", b: "mb", c: "mc" }, new Set(), Date.now());
    expect(plan.discover).toEqual(["c"]);
    expect(plan.reuse.sort()).toEqual(["a", "b"]);
    expect(plan.drop).toEqual([]);
  });

  it("removing one server produces zero discovery — it's only in drop (normal)", () => {
    const cached = {
      a: entry({ serverId: "a", marker: "ma" }),
      b: entry({ serverId: "b", marker: "mb" }),
    };
    const plan = planMcpSync(cached, { a: "ma" }, new Set(), Date.now());
    expect(plan.discover).toEqual([]);
    expect(plan.reuse).toEqual(["a"]);
    expect(plan.drop).toEqual(["b"]);
  });

  it("editing one server's args only re-discovers that one (normal)", () => {
    const cached = {
      a: entry({ serverId: "a", marker: "old-marker" }),
      b: entry({ serverId: "b", marker: "mb" }),
    };
    const plan = planMcpSync(cached, { a: "new-marker", b: "mb" }, new Set(), Date.now());
    expect(plan.discover).toEqual(["a"]);
    expect(plan.reuse).toEqual(["b"]);
  });

  it("unrelated config fields changing leaves every marker (and the plan) untouched (normal)", () => {
    const cached = { a: entry({ serverId: "a", marker: "ma" }) };
    const desired = { a: "ma" }; // marker unchanged since it's content-based, not mtime-based
    const plan = planMcpSync(cached, desired, new Set(), Date.now());
    expect(plan.discover).toEqual([]);
    expect(plan.reuse).toEqual(["a"]);
  });

  it("a disabled server moves to deactivate, not drop (normal — distinguishes disable from remove)", () => {
    const cached = { a: entry({ serverId: "a", marker: "ma" }) };
    const plan = planMcpSync(cached, {}, new Set(["a"]), Date.now());
    expect(plan.deactivate).toEqual(["a"]);
    expect(plan.drop).toEqual([]);
  });

  it("re-enabling a disabled server with an unchanged, unexpired marker reuses it (normal — spawn-free enable)", () => {
    const cached = { a: entry({ serverId: "a", marker: "ma", inactive: true }) };
    const plan = planMcpSync(cached, { a: "ma" }, new Set(), Date.now());
    expect(plan.reuse).toEqual(["a"]);
    expect(plan.discover).toEqual([]);
  });

  it("an already-inactive entry is not re-deactivated (boundary — no repeated work)", () => {
    const cached = { a: entry({ serverId: "a", marker: "ma", inactive: true }) };
    const plan = planMcpSync(cached, {}, new Set(["a"]), Date.now());
    expect(plan.deactivate).toEqual([]);
  });

  it("a pinned entry never re-discovers no matter how stale (normal)", () => {
    const cached = { a: entry({ serverId: "a", marker: "ma", pinned: true, discoveredAt: 0 }) };
    const plan = planMcpSync(cached, { a: "ma" }, new Set(), Date.now() + DEFAULT_TTL_MS * 1000);
    expect(plan.reuse).toEqual(["a"]);
  });

  it("an unpinned entry past its TTL re-discovers even with an unchanged marker (error — staleness the marker can't see)", () => {
    const cached = { a: entry({ serverId: "a", marker: "ma", pinned: false, discoveredAt: 0 }) };
    const plan = planMcpSync(cached, { a: "ma" }, new Set(), effectiveTtlMs("a") + 1);
    expect(plan.discover).toEqual(["a"]);
  });

  it("a server with no cache entry at all is discovered (boundary — first run)", () => {
    const plan = planMcpSync({}, { a: "ma" }, new Set(), Date.now());
    expect(plan.discover).toEqual(["a"]);
  });
});

describe("planMcpMutation", () => {
  it("remove drops only the named server, with no discovery (normal — the O(1) remove)", () => {
    const plan = planMcpMutation(
      { op: "remove", serverId: "a" },
      { a: entry({ serverId: "a" }) },
      {},
      new Set(),
      Date.now(),
    );
    expect(plan).toEqual({ reuse: [], discover: [], deactivate: [], drop: ["a"] });
  });

  it("toggle-off (disable) deactivates only the named server (normal)", () => {
    const plan = planMcpMutation(
      { op: "toggle", serverId: "a" },
      { a: entry({ serverId: "a" }) },
      {},
      new Set(["a"]),
      Date.now(),
    );
    expect(plan).toEqual({ reuse: [], discover: [], deactivate: ["a"], drop: [] });
  });

  it("toggle-on (enable) reuses a fresh, matching cache entry with no spawn (normal)", () => {
    const plan = planMcpMutation(
      { op: "toggle", serverId: "a" },
      { a: entry({ serverId: "a", marker: "ma" }) },
      { a: "ma" },
      new Set(),
      Date.now(),
    );
    expect(plan).toEqual({ reuse: ["a"], discover: [], deactivate: [], drop: [] });
  });

  it("toggle-on (enable) discovers when the config changed while disabled (normal)", () => {
    const plan = planMcpMutation(
      { op: "toggle", serverId: "a" },
      { a: entry({ serverId: "a", marker: "old" }) },
      { a: "new" },
      new Set(),
      Date.now(),
    );
    expect(plan.discover).toEqual(["a"]);
  });

  it("add discovers a server with no prior cache entry (normal)", () => {
    const plan = planMcpMutation(
      { op: "add", serverId: "a" },
      {},
      { a: "ma" },
      new Set(),
      Date.now(),
    );
    expect(plan.discover).toEqual(["a"]);
  });

  it("never touches any server other than the named one (normal — isolation guarantee)", () => {
    const cached = {
      a: entry({ serverId: "a", marker: "ma" }),
      b: entry({ serverId: "b", marker: "mb" }),
      c: entry({ serverId: "c", marker: "mc" }),
    };
    const plan = planMcpMutation(
      { op: "remove", serverId: "b" },
      cached,
      { a: "ma", c: "mc" },
      new Set(),
      Date.now(),
    );
    expect(plan.drop).toEqual(["b"]);
    expect(plan.discover).toEqual([]);
    expect(plan.reuse).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });
});

describe("planMcpRefresh", () => {
  it("with no target, forces discovery of every active server regardless of freshness (normal)", () => {
    const cached = {
      a: entry({ serverId: "a", marker: "ma", pinned: true }),
      b: entry({ serverId: "b", marker: "mb" }),
    };
    const plan = planMcpRefresh(cached, { a: "ma", b: "mb" }, new Set());
    expect(plan.discover.sort()).toEqual(["a", "b"]);
    expect(plan.reuse).toEqual([]);
  });

  it("overrides even a pinned server's exemption (normal — the only way to re-check a pin)", () => {
    const cached = { a: entry({ serverId: "a", marker: "ma", pinned: true }) };
    const plan = planMcpRefresh(cached, { a: "ma" }, new Set(), "a");
    expect(plan.discover).toEqual(["a"]);
  });

  it("with a target, only that server is forced — the rest are reused (normal)", () => {
    const cached = {
      a: entry({ serverId: "a", marker: "ma" }),
      b: entry({ serverId: "b", marker: "mb" }),
    };
    const plan = planMcpRefresh(cached, { a: "ma", b: "mb" }, new Set(), "a");
    expect(plan.discover).toEqual(["a"]);
    expect(plan.reuse).toEqual(["b"]);
  });

  it("a target that isn't currently active discovers nothing (boundary)", () => {
    const plan = planMcpRefresh({}, { a: "ma" }, new Set(), "nonexistent");
    expect(plan.discover).toEqual([]);
  });

  it("still reconciles deactivate/drop alongside the forced refresh (boundary)", () => {
    const cached = {
      a: entry({ serverId: "a", marker: "ma" }),
      removed: entry({ serverId: "removed", marker: "x" }),
    };
    const plan = planMcpRefresh(cached, { a: "ma" }, new Set(), undefined);
    expect(plan.drop).toEqual(["removed"]);
  });
});
