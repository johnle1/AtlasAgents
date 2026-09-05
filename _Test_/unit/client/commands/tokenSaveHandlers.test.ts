/**
 * Unit tests — client commands/tokenSaveHandlers.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnqueue,
  mockGetClient,
  mockHasIndex,
  mockIsOnPath,
  mockListTools,
  mockCallTool,
  mockPrintLine,
  mockPrintError,
  mockPrintSuccess,
  mockRequestApprovalWithFeedback,
  mockRefreshInkBanner,
  mockSendCommand,
  mockExecFile,
  mockLoadConfig,
  mockUpdateConfig,
  mockListMcpTools,
  mockDisconnectMcpClient,
  mockLoadMcpToolsCache,
  mockWriteCacheEntry,
  mockDeleteCacheEntry,
  mockGetClientId,
} = vi.hoisted(() => ({
  mockEnqueue: vi.fn(),
  mockGetClient: vi.fn(),
  mockHasIndex: vi.fn(),
  mockIsOnPath: vi.fn(),
  mockListTools: vi.fn(),
  mockCallTool: vi.fn(),
  mockPrintLine: vi.fn(),
  mockPrintError: vi.fn(),
  mockPrintSuccess: vi.fn(),
  mockRequestApprovalWithFeedback: vi.fn(),
  mockRefreshInkBanner: vi.fn(),
  mockSendCommand: vi.fn(),
  mockExecFile: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockUpdateConfig: vi.fn(),
  mockListMcpTools: vi.fn(),
  mockDisconnectMcpClient: vi.fn(),
  mockLoadMcpToolsCache: vi.fn(),
  mockWriteCacheEntry: vi.fn(),
  mockDeleteCacheEntry: vi.fn(),
  mockGetClientId: vi.fn(),
}));

vi.mock("../../../../packages/client/src/mcp/tokenSaveClient.js", () => ({
  enqueueTokenSaveOperation: mockEnqueue,
  getTokenSaveClient: mockGetClient,
  hasTokenSaveIndex: mockHasIndex,
  isTokenSaveOnPath: mockIsOnPath,
  listCuratedTools: mockListTools,
}));

vi.mock("../../../../packages/client/src/mcp/mcpBridge.js", () => ({
  callTokenSaveTool: mockCallTool,
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: mockLoadConfig,
  updateConfig: mockUpdateConfig,
}));

vi.mock("../../../../packages/client/src/config/clientId.js", () => ({
  getClientId: mockGetClientId,
}));

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
  refreshInkBanner: mockRefreshInkBanner,
}));

// mcpRegistry.js: keep everything real EXCEPT the two calls that need a live
// connection (listMcpTools spawns/handshakes, disconnectMcpClient closes a
// transport). rebuildToolRegistry, namespaceToolName, and parseNamespacedTool
// stay real — that exercises the actual registry-rehydration fix, not a mock
// standing in for it.
vi.mock("../../../../packages/client/src/mcp/mcpRegistry.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../packages/client/src/mcp/mcpRegistry.js")
  >("../../../../packages/client/src/mcp/mcpRegistry.js");
  return {
    ...actual,
    listMcpTools: mockListMcpTools,
    disconnectMcpClient: mockDisconnectMcpClient,
  };
});

// mcpToolsCache.js: mock the disk boundary only. mcpServerMarkers.js and
// mcpSyncPlan.js are pure and left real, so these tests exercise the actual
// planning/hashing logic rather than a mocked stand-in for it.
vi.mock("../../../../packages/client/src/mcp/mcpToolsCache.js", () => ({
  loadMcpToolsCache: mockLoadMcpToolsCache,
  writeCacheEntry: mockWriteCacheEntry,
  deleteCacheEntry: mockDeleteCacheEntry,
}));

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printLine: mockPrintLine,
  printError: mockPrintError,
  printSuccess: mockPrintSuccess,
}));

vi.mock("../../../../packages/client/src/ui/approvalFlow.js", () => ({
  requestApprovalWithFeedback: mockRequestApprovalWithFeedback,
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import {
  handleTokenSave,
  printTokenSaveInitTip,
  syncAllMcpTools,
  syncTokenSaveTools,
} from "../../../../packages/client/src/commands/tokenSaveHandlers.js";
import { resetToolRegistryForTests } from "../../../../packages/client/src/mcp/mcpRegistry.js";
import { computeRootMarker, computeServerMarker } from "../../../../packages/client/src/mcp/mcpServerMarkers.js";

const conn = { sendCommand: mockSendCommand } as never;
const fileProxy = { getWorkspaceRoot: () => "/workspace" } as never;

/** `sync.check` defaults to "MCP not up to date, no config opinion" so
 * discovery tests keep exercising the same path as before this optimization
 * existed; `mcp.tools.sync` has no meaningful response. */
const defaultSendCommand = async (route: string): Promise<unknown> =>
  route === "sync.check" ? { mcp: { upToDate: false } } : undefined;

const baseConfig = () => ({
  mcpServers: {},
  mcpSecrets: {},
  configChangedAt: 555,
  agentModel: "lead-model",
  subagentModel: "worker-model",
  agentProvider: "ollama",
  subagentProvider: "ollama",
  agentTemp: 0.1,
  subagentTemp: 0.4,
});

/** The root marker the module will compute for a given `mcpServers` config, tokensave both true. */
const rootMarkerFor = (mcpServers: Record<string, unknown> = {}): string => {
  const leaves: Record<string, string> = { tokensave: "true::true" };
  for (const [id, cfg] of Object.entries(mcpServers)) {
    if ((cfg as { enabled?: boolean }).enabled !== false) {
      leaves[id] = computeServerMarker(id, cfg as never, {});
    }
  }
  return computeRootMarker(leaves);
};

beforeEach(() => {
  vi.clearAllMocks();
  resetToolRegistryForTests();
  mockEnqueue.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mockIsOnPath.mockResolvedValue(true);
  mockHasIndex.mockResolvedValue(true);
  mockGetClient.mockResolvedValue({});
  mockListTools.mockResolvedValue([
    { name: "tokensave_search", description: "search" },
  ]);
  mockSendCommand.mockImplementation(defaultSendCommand);
  mockRequestApprovalWithFeedback.mockResolvedValue({ approved: true });
  mockLoadConfig.mockReturnValue(baseConfig());
  mockUpdateConfig.mockImplementation((patch: Record<string, unknown>) => ({
    ...mockLoadConfig(),
    ...patch,
  }));
  mockListMcpTools.mockResolvedValue([]);
  mockLoadMcpToolsCache.mockReturnValue({});
  mockGetClientId.mockReturnValue("test-client-id");
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null) => void,
    ) => {
      cb(null);
    },
  );
});

describe("syncTokenSaveTools", () => {
  it("returns 0 when tokensave is not on PATH", async () => {
    mockIsOnPath.mockResolvedValue(false);
    expect(await syncTokenSaveTools(conn, "/workspace")).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("returns 0 when workspace has no index", async () => {
    mockHasIndex.mockResolvedValue(false);
    expect(await syncTokenSaveTools(conn, "/workspace")).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("returns 0 when curated tools list is empty", async () => {
    mockListTools.mockResolvedValue([]);
    expect(await syncTokenSaveTools(conn, "/workspace")).toBe(0);
    expect(mockSendCommand).not.toHaveBeenCalled();
  });

  it("syncs tools and returns count on happy path", async () => {
    const tools = [{ name: "tokensave_search" }];
    mockListTools.mockResolvedValue(tools);
    const count = await syncTokenSaveTools(conn, "/workspace");
    expect(count).toBe(1);
    expect(mockSendCommand).toHaveBeenCalledWith("mcp.tools.sync", { tools });
    expect(mockEnqueue).toHaveBeenCalled();
  });
});

describe("syncAllMcpTools — no-op local plan (fastest, no network round trip for a hit)", () => {
  it("skips sync.check and resends the cached tools when nothing local has changed (normal)", async () => {
    mockLoadMcpToolsCache.mockReturnValue({
      tokensave: {
        serverId: "tokensave",
        marker: "true::true",
        tools: [{ name: "tokensave_search", description: "search", inputSchema: {}, readOnly: true }],
        discoveredAt: Date.now(),
        pinned: false,
      },
    });

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(1);
    expect(mockSendCommand).toHaveBeenCalledWith("mcp.tools.sync", {
      tools: [{ name: "tokensave_search", description: "search", inputSchema: {}, readOnly: true }],
      workspaceRoot: "/workspace",
      clientId: "test-client-id",
      mcpMarker: rootMarkerFor(),
    });
    expect(mockListMcpTools).not.toHaveBeenCalled();
    expect(mockWriteCacheEntry).not.toHaveBeenCalled();
    // No need to even ask the server — the local per-server plan already answered.
    expect(mockSendCommand).not.toHaveBeenCalledWith("sync.check", expect.anything());
  });

  it("returns 0 without sending when nothing is configured at all (boundary — the zero-network case)", async () => {
    mockIsOnPath.mockResolvedValue(false);
    mockLoadMcpToolsCache.mockReturnValue({});

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(0);
    expect(mockSendCommand).not.toHaveBeenCalled();
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });
});

describe("syncAllMcpTools — server round-trip layer (something local can't resolve)", () => {
  it("skips discovery when the server reports the MCP half is already up to date (normal)", async () => {
    const serverTools = [
      { name: "mcp__github__create_issue", description: "Create an issue", inputSchema: {}, readOnly: false },
    ];
    mockSendCommand.mockImplementation(async (route: string) =>
      route === "sync.check"
        ? { mcp: { upToDate: true, tools: serverTools } }
        : undefined,
    );
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: { github: { transport: "http", url: "https://example.invalid/mcp/" } },
    });

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(1);
    const [, payload] = mockSendCommand.mock.calls.find(
      ([route]) => route === "sync.check",
    )!;
    expect(payload).toMatchObject({
      workspaceRoot: "/workspace",
      clientId: "test-client-id",
      config: {
        changedAt: 555,
        values: {
          agentModel: "lead-model",
          subagentModel: "worker-model",
          agentProvider: "ollama",
          subagentProvider: "ollama",
          agentTemp: 0.1,
          subagentTemp: 0.4,
        },
      },
    });
    expect(mockListMcpTools).not.toHaveBeenCalled();
    // Seeds the local per-server cache so future syncs skip even sync.check.
    expect(mockWriteCacheEntry).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "github", tools: [expect.objectContaining({ name: "create_issue" })] }),
    );
    // No redundant mcp.tools.sync — the server already has this data.
    expect(mockSendCommand).not.toHaveBeenCalledWith("mcp.tools.sync", expect.anything());
  });

  it("falls through to discovery when the check call fails (error — old server or network issue)", async () => {
    mockSendCommand.mockImplementation(async (route: string) => {
      if (route === "sync.check") {
        throw new Error("Unknown route: sync.check");
      }
      return undefined;
    });
    mockLoadMcpToolsCache.mockReturnValue({});

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(1);
    expect(mockSendCommand).toHaveBeenCalledWith(
      "mcp.tools.sync",
      expect.objectContaining({ tools: expect.any(Array) }),
    );
  });

  it("adopts the server's config values when the server reports it wins (normal)", async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: { github: { transport: "http", url: "https://x" } },
    });
    mockSendCommand.mockImplementation(async (route: string) =>
      route === "sync.check"
        ? {
            mcp: { upToDate: false },
            config: {
              winner: "server",
              changedAt: 999,
              values: {
                agentModel: "server-lead-model",
                subagentModel: "server-worker-model",
                agentProvider: "ollama",
                subagentProvider: "ollama",
                agentTemp: 0.2,
                subagentTemp: 0.5,
              },
            },
          }
        : undefined,
    );
    mockListMcpTools.mockResolvedValue([]);

    await syncAllMcpTools(conn, "/workspace");

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      agentModel: "server-lead-model",
      subagentModel: "server-worker-model",
      agentProvider: "ollama",
      subagentProvider: "ollama",
      agentTemp: 0.2,
      subagentTemp: 0.5,
      configChangedAt: 999,
    });
    expect(mockRefreshInkBanner).toHaveBeenCalled();
  });

  it("does not touch local config when the client wins or both sides agree (normal)", async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: { github: { transport: "http", url: "https://x" } },
    });
    mockSendCommand.mockImplementation(async (route: string) =>
      route === "sync.check"
        ? { mcp: { upToDate: false }, config: { winner: "client", changedAt: 555 } }
        : undefined,
    );
    mockListMcpTools.mockResolvedValue([]);

    await syncAllMcpTools(conn, "/workspace");

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});

describe("syncAllMcpTools — discovery (nothing cached yet)", () => {
  it("sends TokenSave tools marked read-only when no other servers are configured (normal)", async () => {
    mockListTools.mockResolvedValue([
      { name: "tokensave_search", description: "search" },
    ]);
    const count = await syncAllMcpTools(conn, "/workspace");
    expect(count).toBe(1);
    expect(mockSendCommand).toHaveBeenCalledWith("mcp.tools.sync", {
      tools: [
        {
          name: "tokensave_search",
          description: "search",
          inputSchema: undefined,
          readOnly: true,
        },
      ],
      workspaceRoot: "/workspace",
      clientId: "test-client-id",
      mcpMarker: rootMarkerFor(),
    });
  });

  it("skips TokenSave discovery when it's unavailable (boundary)", async () => {
    mockIsOnPath.mockResolvedValue(false);

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("writes the discovered tools to the per-server cache (normal)", async () => {
    mockListTools.mockResolvedValue([
      { name: "tokensave_search", description: "search" },
    ]);
    await syncAllMcpTools(conn, "/workspace");
    expect(mockWriteCacheEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "tokensave",
        tools: [
          {
            name: "tokensave_search",
            description: "search",
            inputSchema: undefined,
            readOnly: true,
          },
        ],
      }),
    );
  });

  it("combines TokenSave tools with every configured server's tools, namespaced (normal)", async () => {
    mockListTools.mockResolvedValue([{ name: "tokensave_search" }]);
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: {
        github: { transport: "http", url: "https://example.invalid/mcp/" },
      },
      mcpSecrets: { github: { token: "ghp_x" } },
    });
    mockListMcpTools.mockResolvedValue([
      { name: "create_issue", description: "Create an issue", inputSchema: {}, readOnly: false },
    ]);

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(2);
    expect(mockListMcpTools).toHaveBeenCalledWith(
      "github",
      { transport: "http", url: "https://example.invalid/mcp/" },
      { token: "ghp_x" },
    );
    const syncCall = mockSendCommand.mock.calls.find(
      ([route]) => route === "mcp.tools.sync",
    );
    const names = (
      syncCall?.[1] as { tools: { name: string }[] }
    ).tools.map((t) => t.name);
    expect(names).toEqual(["tokensave_search", "mcp__github__create_issue"]);
  });

  it("skips a disabled server without connecting to it (boundary)", async () => {
    mockListTools.mockResolvedValue([{ name: "tokensave_search" }]);
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: {
        github: {
          transport: "http",
          url: "https://example.invalid/mcp/",
          enabled: false,
        },
      },
    });

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(1); // TokenSave only — the disabled server contributes nothing.
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("skips a server that fails to connect without blocking the others (error isolation)", async () => {
    mockListTools.mockResolvedValue([{ name: "tokensave_search" }]);
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: { broken: { transport: "http", url: "https://broken.invalid/mcp/" } },
    });
    mockListMcpTools.mockRejectedValue(new Error("connection refused"));

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(1); // TokenSave's tool still made it through.
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("broken"),
    );
    // A failed discovery must not overwrite/erase any prior cache entry.
    expect(mockWriteCacheEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "broken" }),
    );
  });

  it("returns 0 and sends nothing when there is nothing to sync (boundary)", async () => {
    mockIsOnPath.mockResolvedValue(false);
    const count = await syncAllMcpTools(conn, "/workspace");
    expect(count).toBe(0);
    expect(mockSendCommand).not.toHaveBeenCalledWith(
      "mcp.tools.sync",
      expect.anything(),
    );
  });

  it("still syncs TokenSave's tools when reading mcpServers config fails (error)", async () => {
    mockListTools.mockResolvedValue([{ name: "tokensave_search" }]);
    mockLoadConfig.mockImplementation(() => {
      throw new Error("cipher locked");
    });

    const count = await syncAllMcpTools(conn, "/workspace");

    expect(count).toBe(1);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("cipher locked"),
    );
  });
});

describe("syncAllMcpTools — mutation fast path (/mcp add|remove|enable|disable)", () => {
  it("remove: drops only the named server's cache entry, no discovery, no sync.check (normal — the O(1) remove)", async () => {
    mockIsOnPath.mockResolvedValue(false);
    mockLoadMcpToolsCache.mockReturnValue({
      github: {
        serverId: "github",
        marker: "m",
        tools: [{ name: "create_issue", inputSchema: {}, readOnly: false }],
        discoveredAt: Date.now(),
        pinned: false,
      },
    });

    const count = await syncAllMcpTools(conn, "/workspace", {
      op: "remove",
      serverId: "github",
    });

    expect(count).toBe(0);
    expect(mockDeleteCacheEntry).toHaveBeenCalledWith("github");
    expect(mockDisconnectMcpClient).toHaveBeenCalledWith("github", {
      forgetTransportKind: true,
    });
    expect(mockListMcpTools).not.toHaveBeenCalled();
    expect(mockSendCommand).not.toHaveBeenCalledWith("sync.check", expect.anything());
  });

  it("remove: does not touch any other configured server's cache or connection (normal — isolation)", async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: {
        github: { transport: "http", url: "https://x" },
        jira: { transport: "http", url: "https://y" },
      },
    });
    mockLoadMcpToolsCache.mockReturnValue({
      github: { serverId: "github", marker: computeServerMarker("github", { transport: "http", url: "https://x" }, {}), tools: [], discoveredAt: Date.now(), pinned: false },
      jira: { serverId: "jira", marker: computeServerMarker("jira", { transport: "http", url: "https://y" }, {}), tools: [{ name: "search", inputSchema: {}, readOnly: true }], discoveredAt: Date.now(), pinned: false },
    });

    await syncAllMcpTools(conn, "/workspace", { op: "remove", serverId: "github" });

    // Exactly one disconnect call, for github only — proves jira's
    // connection/cache is untouched regardless of call-argument shape.
    expect(mockDisconnectMcpClient).toHaveBeenCalledTimes(1);
    expect(mockDisconnectMcpClient).toHaveBeenCalledWith("github", {
      forgetTransportKind: true,
    });
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("add: discovers only the new server (normal)", async () => {
    mockIsOnPath.mockResolvedValue(false);
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: { github: { transport: "http", url: "https://x" } },
    });
    mockListMcpTools.mockResolvedValue([
      { name: "create_issue", inputSchema: {}, readOnly: false },
    ]);

    const count = await syncAllMcpTools(conn, "/workspace", { op: "add", serverId: "github" });

    expect(count).toBe(1);
    expect(mockListMcpTools).toHaveBeenCalledTimes(1);
    expect(mockSendCommand).not.toHaveBeenCalledWith("sync.check", expect.anything());
  });

  it("disable: retains the cache entry (marked inactive) and disconnects, no discovery (normal — spawn-free re-enable later)", async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: { github: { transport: "http", url: "https://x", enabled: false } },
    });
    mockIsOnPath.mockResolvedValue(false);
    mockLoadMcpToolsCache.mockReturnValue({
      github: {
        serverId: "github",
        marker: "m",
        tools: [{ name: "create_issue", inputSchema: {}, readOnly: false }],
        discoveredAt: Date.now(),
        pinned: false,
      },
    });

    const count = await syncAllMcpTools(conn, "/workspace", { op: "toggle", serverId: "github" });

    expect(count).toBe(0); // Inactive — excluded from the outgoing payload.
    expect(mockDisconnectMcpClient).toHaveBeenCalledWith("github");
    expect(mockWriteCacheEntry).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "github", inactive: true }),
    );
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("enable: reuses a fresh, matching cache entry — no spawn (normal)", async () => {
    const serverConfig = { transport: "http" as const, url: "https://x" };
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: { github: serverConfig },
    });
    mockIsOnPath.mockResolvedValue(false);
    mockLoadMcpToolsCache.mockReturnValue({
      github: {
        serverId: "github",
        marker: computeServerMarker("github", serverConfig, {}),
        tools: [{ name: "create_issue", inputSchema: {}, readOnly: false }],
        discoveredAt: Date.now(),
        pinned: false,
        inactive: true,
      },
    });

    const count = await syncAllMcpTools(conn, "/workspace", { op: "toggle", serverId: "github" });

    expect(count).toBe(1);
    expect(mockListMcpTools).not.toHaveBeenCalled();
    // Flips the flag back so it's no longer excluded from future syncs.
    expect(mockWriteCacheEntry).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "github", inactive: false }),
    );
  });
});

describe("syncAllMcpTools — refresh (/mcp refresh)", () => {
  it("forces re-discovery of a named server even with a fresh, matching cache (normal — overrides the TTL/pin exemption)", async () => {
    const serverConfig = { transport: "http" as const, url: "https://x" };
    mockLoadConfig.mockReturnValue({ ...baseConfig(), mcpServers: { github: serverConfig } });
    mockIsOnPath.mockResolvedValue(false);
    mockLoadMcpToolsCache.mockReturnValue({
      github: {
        serverId: "github",
        marker: computeServerMarker("github", serverConfig, {}),
        tools: [{ name: "create_issue", inputSchema: {}, readOnly: false }],
        discoveredAt: Date.now(),
        pinned: true, // even pinned — refresh overrides it
      },
    });
    mockListMcpTools.mockResolvedValue([{ name: "create_issue", inputSchema: {}, readOnly: false }]);

    await syncAllMcpTools(conn, "/workspace", { op: "refresh", serverId: "github" });

    expect(mockListMcpTools).toHaveBeenCalledTimes(1);
  });

  it("with no name, refreshes every active server (normal)", async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig(),
      mcpServers: {
        github: { transport: "http", url: "https://x" },
        jira: { transport: "http", url: "https://y" },
      },
    });
    mockListMcpTools.mockResolvedValue([]);
    mockListTools.mockResolvedValue([]);

    await syncAllMcpTools(conn, "/workspace", { op: "refresh" });

    expect(mockListMcpTools).toHaveBeenCalledTimes(2);
  });
});

describe("printTokenSaveInitTip", () => {
  it("does nothing when tokensave is not installed", async () => {
    mockIsOnPath.mockResolvedValue(false);
    await printTokenSaveInitTip("/workspace");
    expect(mockPrintLine).not.toHaveBeenCalled();
  });

  it("does nothing when index already exists", async () => {
    await printTokenSaveInitTip("/workspace");
    expect(mockPrintLine).not.toHaveBeenCalled();
  });

  it("prints tip when tokensave is installed but not initialized", async () => {
    mockHasIndex.mockResolvedValue(false);
    await printTokenSaveInitTip("/workspace");
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("/tokensave init"),
    );
  });
});

describe("handleTokenSave init", () => {
  it("prints error when tokensave is not installed", async () => {
    mockIsOnPath.mockResolvedValue(false);
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("not installed"),
    );
  });

  it("prints success when already initialized", async () => {
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockPrintSuccess).toHaveBeenCalledWith(
      expect.stringContaining("already initialized"),
    );
  });

  it("cancels when approval is rejected", async () => {
    mockHasIndex.mockResolvedValue(false);
    mockRequestApprovalWithFeedback.mockResolvedValue({ approved: false });
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("cancels (does not run init) when the user picks Revise instead of approving", async () => {
    mockHasIndex.mockResolvedValue(false);
    mockRequestApprovalWithFeedback.mockResolvedValue({
      approved: false,
      feedback: "don't create that folder yet",
    });
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("runs tokensave init and syncs on success", async () => {
    mockHasIndex.mockResolvedValueOnce(false).mockResolvedValue(true);
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockExecFile).toHaveBeenCalledWith(
      "tokensave",
      ["init"],
      expect.objectContaining({ cwd: "/workspace" }),
      expect.any(Function),
    );
    expect(mockPrintSuccess).toHaveBeenCalledWith(
      expect.stringContaining("initialized"),
    );
    expect(mockSendCommand).toHaveBeenCalledWith(
      "mcp.tools.sync",
      expect.anything(),
    );
  });

  it("prints error when tokensave init fails", async () => {
    mockHasIndex.mockResolvedValue(false);
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error("init failed"));
      },
    );
    await handleTokenSave("init", "", conn, fileProxy);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("init failed"),
    );
  });
});

describe("handleTokenSave status", () => {
  it("prints formatted status on success", async () => {
    mockCallTool.mockResolvedValue({
      isError: false,
      data: { ready: true },
    });
    await handleTokenSave("status", "", conn, fileProxy);
    expect(mockPrintLine).toHaveBeenCalledWith(
      expect.stringContaining('"ready": true'),
    );
  });

  it("prints error when status call fails", async () => {
    mockCallTool.mockResolvedValue({
      isError: true,
      errorMessage: "status boom",
    });
    await handleTokenSave("status", "", conn, fileProxy);
    expect(mockPrintError).toHaveBeenCalledWith("status boom");
  });

  it("prints error when status throws", async () => {
    mockCallTool.mockRejectedValue(new Error("network"));
    await handleTokenSave("status", "", conn, fileProxy);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("network"),
    );
  });
});

describe("handleTokenSave unknown subcommand", () => {
  it("prints usage error", async () => {
    await handleTokenSave("bogus", "", conn, fileProxy);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /tokensave"),
    );
  });
});
