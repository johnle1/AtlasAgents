/**
 * Unit tests — server routing/routerBuilder.ts's unified sync handlers:
 * createMcpToolsSyncHandler / createSyncCheckHandler.
 *
 * @remarks
 * `sync.check` is the single unified startup reconciliation call: it lets a
 * reconnecting client skip re-discovering identical MCP tools by asking
 * whether the server's disk-persisted cache (`McpToolsCacheStore`) already
 * has current data for this (clientId, workspaceRoot, mcpMarker) — AND
 * reconciles the plaintext config overlap by newest-`configChangedAt`-wins,
 * in the same round trip. `mcp.tools.sync` is the existing full-sync route,
 * writing into that same MCP cache.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Session } from "../../../../packages/server/src/routing/types.js";
import type { PerConnection } from "../../../../packages/server/src/container/types.js";
import type { IConfigManager } from "../../../../packages/server/src/orchestration/interfaces/configInterfaces.js";
import type { ProviderRegistry } from "../../../../packages/server/src/providers/providerRegistry.js";

const { mockSyncAgentToolSupport, mockSyncSubagentToolSupport, mockSyncAgentThinkingSupport } =
  vi.hoisted(() => ({
    mockSyncAgentToolSupport: vi.fn(async () => true),
    mockSyncSubagentToolSupport: vi.fn(async () => true),
    mockSyncAgentThinkingSupport: vi.fn(async () => false),
  }));

vi.mock("../../../../packages/server/src/ollama/syncAgentToolSupport.js", () => ({
  syncAgentToolSupport: mockSyncAgentToolSupport,
  syncSubagentToolSupport: mockSyncSubagentToolSupport,
}));

vi.mock("../../../../packages/server/src/ollama/syncAgentThinkingSupport.js", () => ({
  syncAgentThinkingSupport: mockSyncAgentThinkingSupport,
}));

import {
  createMcpToolsSyncHandler,
  createSyncCheckHandler,
} from "../../../../packages/server/src/routing/routerBuilder.js";
import { McpToolsCacheStore } from "../../../../packages/server/src/orchestration/mcp/mcpToolsCacheStore.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const makeStore = async (): Promise<McpToolsCacheStore> => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "atlas-mcp-tools-handlers-"),
  );
  tempRoots.push(root);
  return new McpToolsCacheStore({ rootDir: root });
};

const makePerConn = (overrides: Partial<PerConnection> = {}): PerConnection =>
  ({
    mcpTools: undefined,
    workspace: {},
    terminal: {},
    planBroker: {},
    ...overrides,
  }) as unknown as PerConnection;

const SESSION: Session = { userId: "user_1", requesterId: "req_1" };

/** Invokes a handler and returns its result loosely typed for `.mcp`/`.config` access in tests. */
const call = async (
  handler: (session: Session, payload: unknown) => Promise<unknown>,
  payload: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => handler(SESSION, payload);

const rawTool = {
  name: "create_issue",
  description: "Create an issue",
  inputSchema: { type: "object", properties: {}, required: [] },
  readOnly: false,
};

const baseServerConfig = {
  agentModel: "llama3",
  subagentModel: "gemma3:4b",
  agentProvider: "ollama",
  subagentProvider: "ollama",
  agentTemp: 0.1,
  subagentTemp: 0.4,
  configChangedAt: 100,
};

const makeConfig = (overrides: Partial<typeof baseServerConfig> = {}) => {
  const state = { ...baseServerConfig, ...overrides };
  return {
    getAll: vi.fn(async () => state),
    applySyncedConfig: vi.fn(async () => {}),
  } as unknown as IConfigManager;
};

const makeProviderRegistry = (): ProviderRegistry =>
  ({ getAdmin: vi.fn(async () => ({})) }) as unknown as ProviderRegistry;

const clientValues = {
  agentModel: "llama3",
  subagentModel: "gemma3:4b",
  agentProvider: "ollama",
  subagentProvider: "ollama",
  agentTemp: 0.1,
  subagentTemp: 0.4,
};

describe("createSyncCheckHandler — MCP half", () => {
  it("reports not up to date when nothing is cached for this key (boundary — cold cache)", async () => {
    const store = await makeStore();
    const handler = createSyncCheckHandler(
      store,
      new Map(),
      () => makePerConn(),
      makeConfig(),
      makeProviderRegistry(),
    );

    const result = await call(handler, {
      workspaceRoot: "/workspace",
      clientId: "client-1",
      mcpMarker: "marker-a",
    });

    expect(result.mcp).toEqual({ upToDate: false });
  });

  it("reports not up to date when required fields are missing (boundary)", async () => {
    const store = await makeStore();
    const handler = createSyncCheckHandler(
      store,
      new Map(),
      () => makePerConn(),
      makeConfig(),
      makeProviderRegistry(),
    );
    const result = await call(handler, {});
    expect(result.mcp).toEqual({ upToDate: false });
  });

  it("reports up to date and populates this connection's perConnection.mcpTools from the cache (normal)", async () => {
    const store = await makeStore();
    await store.set("client-1", "/workspace", "marker-a", [rawTool]);
    const brokerByRequester = new Map<string, PerConnection>();
    const perConn = makePerConn();
    brokerByRequester.set("req_1", perConn);
    const handler = createSyncCheckHandler(
      store,
      brokerByRequester,
      () => {
        throw new Error("should reuse the existing PerConnection, not create one");
      },
      makeConfig(),
      makeProviderRegistry(),
    );

    const result = await call(handler, {
      workspaceRoot: "/workspace",
      clientId: "client-1",
      mcpMarker: "marker-a",
    });

    expect(result.mcp).toEqual({ upToDate: true, tools: [rawTool] });
    expect(perConn.mcpTools).toEqual([
      { schema: expect.objectContaining({ type: "function" }), readOnly: false },
    ]);
  });

  it("lazily creates a PerConnection when none exists yet on a cache hit (boundary)", async () => {
    const store = await makeStore();
    await store.set("client-1", "/workspace", "marker-a", [rawTool]);
    const brokerByRequester = new Map<string, PerConnection>();
    const created = makePerConn();
    const createPerConnection = vi.fn(() => created);
    const handler = createSyncCheckHandler(
      store,
      brokerByRequester,
      createPerConnection,
      makeConfig(),
      makeProviderRegistry(),
    );

    const result = await call(handler, {
      workspaceRoot: "/workspace",
      clientId: "client-1",
      mcpMarker: "marker-a",
    });

    expect(createPerConnection).toHaveBeenCalledWith("req_1", expect.any(Function));
    expect(brokerByRequester.get("req_1")).toBe(created);
    expect(result.mcp).toEqual({ upToDate: true, tools: [rawTool] });
  });

  it("reports not up to date when the cached marker differs from what the client sent (normal — stale)", async () => {
    const store = await makeStore();
    await store.set("client-1", "/workspace", "marker-a", [rawTool]);
    const handler = createSyncCheckHandler(
      store,
      new Map(),
      () => makePerConn(),
      makeConfig(),
      makeProviderRegistry(),
    );

    const result = await call(handler, {
      workspaceRoot: "/workspace",
      clientId: "client-1",
      mcpMarker: "marker-b",
    });

    expect(result.mcp).toEqual({ upToDate: false });
  });

  it("never serves one client's cached tools to a different client for the same workspace (normal — the multi-client fix)", async () => {
    const store = await makeStore();
    await store.set("client-1", "/workspace", "marker-a", [rawTool]);
    const handler = createSyncCheckHandler(
      store,
      new Map(),
      () => makePerConn(),
      makeConfig(),
      makeProviderRegistry(),
    );

    const result = await call(handler, {
      workspaceRoot: "/workspace",
      clientId: "client-2",
      mcpMarker: "marker-a",
    });

    expect(result.mcp).toEqual({ upToDate: false });
  });

  it("still returns a config answer when the MCP half's store throws (error isolation)", async () => {
    const throwingStore = {
      get: () => {
        throw new Error("disk error");
      },
    } as unknown as McpToolsCacheStore;
    const handler = createSyncCheckHandler(
      throwingStore,
      new Map(),
      () => makePerConn(),
      makeConfig({ configChangedAt: 50 }),
      makeProviderRegistry(),
    );

    const result = await call(handler, {
      workspaceRoot: "/workspace",
      clientId: "client-1",
      mcpMarker: "marker-a",
      config: { changedAt: 100, values: clientValues },
    });

    expect(result.mcp).toEqual({ upToDate: false });
    expect(result.config).toEqual({ winner: "client", changedAt: 100 });
  });
});

describe("createSyncCheckHandler — config half", () => {
  it("does nothing when the request has no config half (boundary)", async () => {
    const store = await makeStore();
    const config = makeConfig();
    const handler = createSyncCheckHandler(
      store,
      new Map(),
      () => makePerConn(),
      config,
      makeProviderRegistry(),
    );

    const result = await call(handler, {});

    expect(result.config).toBeUndefined();
    expect(config.applySyncedConfig).not.toHaveBeenCalled();
  });

  it("client wins when its changedAt is newer, and applies its values server-side (normal)", async () => {
    const store = await makeStore();
    const config = makeConfig({ configChangedAt: 50, agentModel: "old-model" });
    const handler = createSyncCheckHandler(
      store,
      new Map(),
      () => makePerConn(),
      config,
      makeProviderRegistry(),
    );

    const result = await call(handler, {
      config: { changedAt: 100, values: clientValues },
    });

    expect(result.config).toEqual({ winner: "client", changedAt: 100 });
    expect(config.applySyncedConfig).toHaveBeenCalledWith(clientValues, 100);
  });

  it("re-probes capability flags only for a role whose model actually changed (normal)", async () => {
    const store = await makeStore();
    const config = makeConfig({
      configChangedAt: 50,
      agentModel: "old-agent-model",
      subagentModel: clientValues.subagentModel, // unchanged
    });
    const handler = createSyncCheckHandler(
      store,
      new Map(),
      () => makePerConn(),
      config,
      makeProviderRegistry(),
    );

    await call(handler, {
      config: { changedAt: 100, values: clientValues },
    });

    expect(mockSyncAgentToolSupport).toHaveBeenCalledTimes(1);
    expect(mockSyncAgentThinkingSupport).toHaveBeenCalledTimes(1);
    expect(mockSyncSubagentToolSupport).not.toHaveBeenCalled();
  });

  it("server wins when its changedAt is newer, returning its values without applying anything (normal)", async () => {
    const store = await makeStore();
    const config = makeConfig({ configChangedAt: 200 });
    const handler = createSyncCheckHandler(
      store,
      new Map(),
      () => makePerConn(),
      config,
      makeProviderRegistry(),
    );

    const result = await call(handler, {
      config: { changedAt: 100, values: clientValues },
    });

    expect(result.config).toEqual({
      winner: "server",
      changedAt: 200,
      values: {
        agentModel: "llama3",
        subagentModel: "gemma3:4b",
        agentProvider: "ollama",
        subagentProvider: "ollama",
        agentTemp: 0.1,
        subagentTemp: 0.4,
      },
    });
    expect(config.applySyncedConfig).not.toHaveBeenCalled();
  });

  it("reports same when both sides' changedAt are equal (boundary)", async () => {
    const store = await makeStore();
    const config = makeConfig({ configChangedAt: 100 });
    const handler = createSyncCheckHandler(
      store,
      new Map(),
      () => makePerConn(),
      config,
      makeProviderRegistry(),
    );

    const result = await call(handler, {
      config: { changedAt: 100, values: clientValues },
    });

    expect(result.config).toEqual({ winner: "same", changedAt: 100 });
    expect(config.applySyncedConfig).not.toHaveBeenCalled();
  });

  it("still returns an MCP answer when the config half throws (error isolation)", async () => {
    const store = await makeStore();
    await store.set("client-1", "/workspace", "marker-a", [rawTool]);
    const config = {
      getAll: vi.fn(async () => {
        throw new Error("disk error");
      }),
      applySyncedConfig: vi.fn(async () => {}),
    } as unknown as IConfigManager;
    const handler = createSyncCheckHandler(
      store,
      new Map(),
      () => makePerConn(),
      config,
      makeProviderRegistry(),
    );

    const result = await call(handler, {
      workspaceRoot: "/workspace",
      clientId: "client-1",
      mcpMarker: "marker-a",
      config: { changedAt: 100, values: clientValues },
    });

    expect(result.config).toBeUndefined();
    expect(result.mcp).toEqual({ upToDate: true, tools: [rawTool] });
  });
});

describe("createMcpToolsSyncHandler", () => {
  it("syncs perConnection.mcpTools regardless of whether cache fields are present (normal)", async () => {
    const store = await makeStore();
    const brokerByRequester = new Map<string, PerConnection>();
    const perConn = makePerConn();
    brokerByRequester.set("req_1", perConn);
    const handler = createMcpToolsSyncHandler(store, brokerByRequester, () => {
      throw new Error("not used — connection already exists");
    });

    const result = await call(handler, { tools: [rawTool] });

    expect(result).toEqual({ synced: 1 });
    expect(perConn.mcpTools).toHaveLength(1);
  });

  it("writes the workspace cache when workspaceRoot/clientId/mcpMarker are present (normal)", async () => {
    const store = await makeStore();
    const brokerByRequester = new Map<string, PerConnection>();
    const handler = createMcpToolsSyncHandler(
      store,
      brokerByRequester,
      () => makePerConn(),
    );

    await call(handler, {
      tools: [rawTool],
      workspaceRoot: "/workspace",
      clientId: "client-1",
      mcpMarker: "marker-a",
    });

    expect(store.get("client-1", "/workspace")).toEqual({
      marker: "marker-a",
      tools: [rawTool],
    });
  });

  it("does not write or crash when cache fields are absent (boundary — the orphaned syncTokenSaveTools caller)", async () => {
    const store = await makeStore();
    const handler = createMcpToolsSyncHandler(store, new Map(), () => makePerConn());

    await expect(handler(SESSION, { tools: [rawTool] })).resolves.toEqual({
      synced: 1,
    });
    expect(store.get("client-1", "/workspace")).toBeUndefined();
  });

  it("lazily creates a PerConnection when none exists yet (boundary)", async () => {
    const store = await makeStore();
    const brokerByRequester = new Map<string, PerConnection>();
    const created = makePerConn();
    const createPerConnection = vi.fn(() => created);

    const handler = createMcpToolsSyncHandler(
      store,
      brokerByRequester,
      createPerConnection,
    );
    await call(handler, { tools: [] });

    expect(createPerConnection).toHaveBeenCalledWith("req_1", expect.any(Function));
    expect(brokerByRequester.get("req_1")).toBe(created);
  });
});
