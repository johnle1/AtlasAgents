/**
 * Integration tests — shared protocol contract ↔ server router registration
 * (drift guard).
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : the shared `serverProtocol.ts` route/stream lists
 *                          and type guards against the REAL buildRouter +
 *                          Router dispatch.
 *
 * Why this file exists
 * --------------------
 * `shared/src/protocol/serverProtocol.ts` is the client-visible contract:
 * `ROUTE_IDS`/`STREAM_KINDS` are what a client may send. `routerBuilder.ts`
 * is what the server actually registers. These can drift in one direction
 * at runtime — the protocol advertising a route the server never registered
 * — and every unit test on either side would still pass (the reverse
 * direction, an extra registered route, is compile-time impossible thanks
 * to `Partial<Record<RouteId, CommandHandler>>`). This file drives every
 * advertised route through `Router.routeCommand`/`routeStream` — the exact
 * dispatch the RSocket layer uses — and fails if any comes back
 * "not implemented".
 *
 * Handlers are invoked with minimal payloads against stubbed collaborators
 * and an instantly-failing fetch, so a registered handler may reject with a
 * validation or network error — that still proves registration. Only
 * "Unknown route" / "not implemented" rejections fail this suite.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Handlers that touch the network must fail fast, never hang the suite.
const mockFetch = vi.hoisted(() => vi.fn());
const MockAgent = vi.hoisted(
  () =>
    class {
      constructor(public opts: unknown) {}
    },
);
vi.mock("undici", () => ({
  Agent: MockAgent,
  fetch: (...args: unknown[]) => mockFetch(...args),
}));

import {
  ROUTE_IDS,
  STREAM_KINDS,
  isRouteId,
  isStreamKind,
} from "../../../packages/shared/src/index.js";
import type {
  Session,
  RouterBuilderDeps,
} from "../../../packages/server/src/routing/types.js";
import { buildRouter } from "../../../packages/server/src/routing/routerBuilder.js";
import { Router } from "../../../packages/server/src/routing/router.js";
import { ConfigManager } from "../../../packages/server/src/config/index.js";
import { lockCipher } from "@atlasagents/shared";
import { OllamaClient } from "../../../packages/server/src/ollama/client.js";
import { ProviderRegistry } from "../../../packages/server/src/providers/providerRegistry.js";
import { McpToolsCacheStore } from "../../../packages/server/src/orchestration/mcp/mcpToolsCacheStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  lockCipher();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const SESSION: Session = { userId: "user_1", requesterId: "req_1" };

const makeRouter = async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "atlas-protocol-contract-"),
  );
  tempRoots.push(root);
  const config = new ConfigManager({ rootDir: root });
  await config.unlockOrSetupProvidersCipher(
    async () => "protocol-contract-pass",
  );
  const ollama = new OllamaClient();

  const deps: RouterBuilderDeps = {
    ollama,
    providerRegistry: new ProviderRegistry({ config, ollamaClient: ollama }),
    config,
    skills: { saveAll: async () => 0 },
    prefs: {
      getAll: async () => [],
      deleteByTopic: async () => 0,
      clear: async () => {},
    },
    session: {
      exists: async () => false,
      clear: async () => "",
      saveSnapshot: async () => {},
    },
    orchestrator: { runTask: async () => {} },
    brokerByRequester: new Map(),
    mcpToolsCacheStore: new McpToolsCacheStore({ rootDir: root }),
    createPerConnection: () => {
      throw new Error("no per-connection container in this suite");
    },
    preferenceRulesToMemoryEntries: () => [],
  };
  return buildRouter(deps);
};

/** Any rejection EXCEPT dispatch-level "unknown / not implemented" is fine. */
const expectRegistered = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  expect(message).not.toMatch(/unknown route/i);
  expect(message).not.toMatch(/not implemented/i);
};

// ---------------------------------------------------------------------------
// Commands — every advertised route is actually registered
// ---------------------------------------------------------------------------

describe("protocol contract — ROUTE_IDS ↔ buildRouter command registration", () => {
  it("ROUTE_IDS contains no duplicates", () => {
    expect(new Set(ROUTE_IDS).size).toBe(ROUTE_IDS.length);
  });

  it("every advertised route passes the shared type guard", () => {
    for (const route of ROUTE_IDS) {
      expect(isRouteId(route)).toBe(true);
    }
  });

  it.each([...ROUTE_IDS])("%s has a registered handler", async (route) => {
    const router = await makeRouter();
    mockFetch.mockRejectedValue(new Error("offline in contract suite"));

    await router
      .routeCommand(SESSION, route, {})
      .then(() => undefined)
      .catch(expectRegistered);
  });
});

// ---------------------------------------------------------------------------
// Streams — every advertised stream kind is actually registered
// ---------------------------------------------------------------------------

describe("protocol contract — STREAM_KINDS ↔ buildRouter stream registration", () => {
  it("every advertised stream kind passes the shared type guard", () => {
    for (const kind of STREAM_KINDS) {
      expect(isStreamKind(kind)).toBe(true);
    }
  });

  it.each([...STREAM_KINDS])("%s has a registered handler", async (kind) => {
    const router = await makeRouter();
    mockFetch.mockRejectedValue(new Error("offline in contract suite"));

    await router
      .routeStream(SESSION, kind, {}, () => {}, new AbortController().signal)
      .then(() => undefined)
      .catch(expectRegistered);
  });
});

// ---------------------------------------------------------------------------
// Negative direction — unknown names are rejected at dispatch
// ---------------------------------------------------------------------------

describe("protocol contract — unknown names stay rejected", () => {
  it("the type guards reject non-contract names", () => {
    // `memory.show` is the historical example (see router.ts header note):
    // the client protocol only has `memory.get`.
    expect(isRouteId("memory.show")).toBe(false);
    expect(isRouteId("totally.made.up")).toBe(false);
    expect(isStreamKind("models.push")).toBe(false);
    expect(isStreamKind("")).toBe(false);
  });

  it("Router rejects an unknown route and an unknown stream kind", async () => {
    const router = new Router({ commands: {}, streams: {} });

    await expect(router.routeCommand(SESSION, "nope.nope", {})).rejects.toThrow(
      /unknown route/i,
    );
    await expect(
      router.routeStream(
        SESSION,
        "nope",
        {},
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/unknown stream kind/i);
  });
});
