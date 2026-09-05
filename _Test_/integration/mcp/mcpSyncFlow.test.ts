/**
 * Integration tests — syncAllMcpTools against a real server-side
 * McpToolsCacheStore (the `sync.check`/`mcp.tools.sync` routes are
 * reimplemented inline against the real store rather than spinning up the
 * full RSocket router — the config half of `sync.check`, and the router
 * plumbing itself, are already covered end-to-end in
 * `unit/server/routing/mcpToolsHandlers.test.ts`).
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : syncAllMcpTools (commands/tokenSaveHandlers.ts),
 *                          the real disk-backed encrypted client config, the
 *                          real local per-server tool cache
 *                          (mcp/mcpToolsCache.ts), mcpRegistry.ts, and a
 *                          real server-side `McpToolsCacheStore`.
 * Mocks                  : `@modelcontextprotocol/sdk/client/*` (fake
 *   servers, no real spawn/socket), and `conn.sendCommand` — its
 *   implementation forwards to the real `McpToolsCacheStore` instance so
 *   the MCP half of `sync.check`/`mcp.tools.sync` behaves like the real
 *   server route without running the router.
 *
 * Category checklist:
 *   ✅ Normal   — cold sync discovers and sends the full payload; warm local
 *                 cache reuses with zero listMcpTools calls; a sync.check
 *                 hit seeds the local cache with no discovery
 *   ✅ Boundary — rebuildToolRegistry makes cache-only tools callable again
 *                 after a simulated fresh process (empty in-memory registry);
 *                 disable retains the cache but withholds the tools;
 *                 re-enable clears the flag with no re-discovery
 *   ✅ Error    — one server failing to connect doesn't block the others
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTempHome, type TempHome } from "../../helpers/tempHome.js";

const {
  connectMock,
  listToolsMock,
  closeMock,
  StdioClientTransportMock,
  printErrorMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn().mockResolvedValue(undefined),
  listToolsMock: vi.fn().mockResolvedValue({ tools: [] }),
  closeMock: vi.fn().mockResolvedValue(undefined),
  StdioClientTransportMock: vi.fn((opts: unknown) => ({ __kind: "stdio", opts })),
  printErrorMock: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = connectMock;
    listTools = listToolsMock;
    callTool = vi.fn();
    close = closeMock;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: StdioClientTransportMock,
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock("../../../packages/client/src/renderer.js", () => ({
  printError: printErrorMock,
  printLine: vi.fn(),
  printSuccess: vi.fn(),
}));

describe("integration — syncAllMcpTools", () => {
  let tempHome: TempHome;
  let cacheStoreRoot: string;
  let workspaceRoot: string;

  let syncAllMcpTools: typeof import("../../../packages/client/src/commands/tokenSaveHandlers.js").syncAllMcpTools;
  let loadConfig: typeof import("../../../packages/client/src/config/index.js").loadConfig;
  let updateConfig: typeof import("../../../packages/client/src/config/index.js").updateConfig;
  let unlockOrSetupConfigCipher: typeof import("../../../packages/client/src/config/index.js").unlockOrSetupConfigCipher;
  let lockCipher: typeof import("@atlasagents/shared").lockCipher;
  let getToolMetadata: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").getToolMetadata;
  let resetToolRegistryForTests: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").resetToolRegistryForTests;
  let disconnectAllMcpClients: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").disconnectAllMcpClients;
  let McpToolsCacheStore: typeof import("../../../packages/server/src/orchestration/mcp/mcpToolsCacheStore.js").McpToolsCacheStore;

  let cacheStore: InstanceType<typeof McpToolsCacheStore>;

  beforeAll(async () => {
    tempHome = createTempHome("atlas-mcp-sync-flow-");
    workspaceRoot = tempHome.dir;

    const configMod = await import("../../../packages/client/src/config/index.js");
    loadConfig = configMod.loadConfig;
    updateConfig = configMod.updateConfig;
    unlockOrSetupConfigCipher = configMod.unlockOrSetupConfigCipher;

    const cipherMod = await import("@atlasagents/shared");
    lockCipher = cipherMod.lockCipher;

    const syncMod = await import("../../../packages/client/src/commands/tokenSaveHandlers.js");
    syncAllMcpTools = syncMod.syncAllMcpTools;

    const registryMod = await import("../../../packages/client/src/mcp/mcpRegistry.js");
    getToolMetadata = registryMod.getToolMetadata;
    resetToolRegistryForTests = registryMod.resetToolRegistryForTests;
    disconnectAllMcpClients = registryMod.disconnectAllMcpClients;

    const cacheStoreMod = await import(
      "../../../packages/server/src/orchestration/mcp/mcpToolsCacheStore.js"
    );
    McpToolsCacheStore = cacheStoreMod.McpToolsCacheStore;
  });

  afterAll(() => {
    tempHome.restore();
  });

  beforeEach(async () => {
    await unlockOrSetupConfigCipher(async () => "integration-test-pass");
    resetToolRegistryForTests();
    connectMock.mockClear().mockResolvedValue(undefined);
    StdioClientTransportMock.mockClear();
    listToolsMock.mockReset().mockResolvedValue({
      tools: [{ name: "create_issue", inputSchema: {}, annotations: { readOnlyHint: false } }],
    });
    closeMock.mockClear().mockResolvedValue(undefined);
    printErrorMock.mockClear();
    cacheStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mcp-servercache-"));
    cacheStore = new McpToolsCacheStore({ rootDir: cacheStoreRoot });
  });

  afterEach(async () => {
    await disconnectAllMcpClients();
    lockCipher();
    fs.rmSync(path.join(tempHome.dir, ".atlasagents", "config.json"), { force: true });
    fs.rmSync(path.join(tempHome.dir, ".atlasagents", "mcpToolsCache"), {
      recursive: true,
      force: true,
    });
    fs.rmSync(cacheStoreRoot, { recursive: true, force: true });
  });

  /**
   * Mirrors the MCP half of the real `sync.check`/`mcp.tools.sync` server
   * routes (see `routerBuilder.ts`) against the real `cacheStore` above —
   * the config half is out of scope for this file, see the header docblock.
   */
  const fakeSendCommand = vi.fn(
    async (route: string, payload: Record<string, unknown>) => {
      if (route === "sync.check") {
        const { workspaceRoot: wr, clientId, mcpMarker } = payload;
        if (
          typeof wr === "string" &&
          typeof clientId === "string" &&
          typeof mcpMarker === "string"
        ) {
          const entry = cacheStore.get(clientId, wr);
          if (entry && entry.marker === mcpMarker) {
            return { mcp: { upToDate: true, tools: entry.tools } };
          }
        }
        return { mcp: { upToDate: false } };
      }
      if (route === "mcp.tools.sync") {
        const { tools, workspaceRoot: wr, clientId, mcpMarker } = payload;
        if (
          typeof wr === "string" &&
          typeof clientId === "string" &&
          typeof mcpMarker === "string"
        ) {
          await cacheStore.set(clientId, wr, mcpMarker, (tools ?? []) as never);
        }
        return { synced: Array.isArray(tools) ? tools.length : 0 };
      }
      return {};
    },
  );
  const fakeConn = { sendCommand: fakeSendCommand } as never;

  const setServers = (mcpServers: Record<string, unknown>): void => {
    const config = loadConfig();
    updateConfig({ mcpServers: { ...config.mcpServers, ...mcpServers } as never });
  };

  it("cold sync discovers and sends the full namespaced payload via mcp.tools.sync (normal)", async () => {
    setServers({
      github: { transport: "http", url: "https://mcp.example.com", enabled: true },
    });

    const count = await syncAllMcpTools(fakeConn, workspaceRoot);

    expect(count).toBe(1);
    expect(listToolsMock).toHaveBeenCalled();
    expect(fakeSendCommand).toHaveBeenCalledWith(
      "mcp.tools.sync",
      expect.objectContaining({
        tools: [
          expect.objectContaining({ name: "mcp__github__create_issue", readOnly: false }),
        ],
      }),
    );
    expect(getToolMetadata("mcp__github__create_issue")).toBeDefined();
  });

  it("a warm local cache reuses with zero listMcpTools calls (normal)", async () => {
    setServers({
      github: { transport: "http", url: "https://mcp.example.com", enabled: true },
    });
    await syncAllMcpTools(fakeConn, workspaceRoot); // populates the local cache
    listToolsMock.mockClear();

    const count = await syncAllMcpTools(fakeConn, workspaceRoot);

    expect(count).toBe(1);
    expect(listToolsMock).not.toHaveBeenCalled();
  });

  it("rebuildToolRegistry repopulates the registry from a cache-only local file, with no discovery (normal — the warm-cache-bug fix)", async () => {
    setServers({
      github: { transport: "http", url: "https://mcp.example.com", enabled: true },
    });
    await syncAllMcpTools(fakeConn, workspaceRoot); // writes the local per-server cache file
    // Simulate a fresh process: the in-memory registry is empty, but the
    // on-disk local cache file from the line above still exists.
    resetToolRegistryForTests();
    expect(getToolMetadata("mcp__github__create_issue")).toBeUndefined();
    listToolsMock.mockClear();

    await syncAllMcpTools(fakeConn, workspaceRoot);

    expect(listToolsMock).not.toHaveBeenCalled();
    expect(getToolMetadata("mcp__github__create_issue")).toBeDefined();
  });

  it("a sync.check hit seeds the local cache with no discovery (normal)", async () => {
    setServers({
      github: { transport: "http", url: "https://mcp.example.com", enabled: true },
    });
    // First sync populates the SERVER-side cacheStore (via mcp.tools.sync).
    await syncAllMcpTools(fakeConn, workspaceRoot);
    // Wipe only the LOCAL cache, simulating a new client install that has
    // never talked to this workspace before but shares the same server.
    fs.rmSync(path.join(tempHome.dir, ".atlasagents", "mcpToolsCache"), {
      recursive: true,
      force: true,
    });
    resetToolRegistryForTests();
    listToolsMock.mockClear();

    const count = await syncAllMcpTools(fakeConn, workspaceRoot);

    expect(listToolsMock).not.toHaveBeenCalled(); // seeded from sync.check, not re-discovered
    expect(count).toBe(1);
    expect(getToolMetadata("mcp__github__create_issue")).toBeDefined();
    // And the local cache is now warm too, for the next mutation-triggered sync.
    const localCacheFiles = fs.readdirSync(
      path.join(tempHome.dir, ".atlasagents", "mcpToolsCache"),
    );
    expect(localCacheFiles.length).toBe(1);
  });

  it("disable retains the cache but withholds the tools; re-enable clears the flag with no re-discovery (boundary)", async () => {
    setServers({
      github: { transport: "http", url: "https://mcp.example.com", enabled: true },
    });
    await syncAllMcpTools(fakeConn, workspaceRoot, { op: "add", serverId: "github" });
    expect(getToolMetadata("mcp__github__create_issue")).toBeDefined();

    setServers({
      github: { transport: "http", url: "https://mcp.example.com", enabled: false },
    });
    const disabledCount = await syncAllMcpTools(fakeConn, workspaceRoot, {
      op: "toggle",
      serverId: "github",
    });
    expect(disabledCount).toBe(0);
    expect(getToolMetadata("mcp__github__create_issue")).toBeUndefined();

    listToolsMock.mockClear();
    setServers({
      github: { transport: "http", url: "https://mcp.example.com", enabled: true },
    });
    const reenabledCount = await syncAllMcpTools(fakeConn, workspaceRoot, {
      op: "toggle",
      serverId: "github",
    });

    expect(listToolsMock).not.toHaveBeenCalled(); // no spawn — reused the retained cache
    expect(reenabledCount).toBe(1);
    expect(getToolMetadata("mcp__github__create_issue")).toBeDefined();
  });

  it("one server failing to connect is skipped with a warning while the other still syncs (error)", async () => {
    setServers({
      good: { transport: "stdio", command: "good-server", enabled: true },
      bad: { transport: "stdio", command: "bad-server", enabled: true },
    });
    connectMock.mockImplementation(async (transport: { opts?: { command?: string } }) => {
      if (transport?.opts?.command === "bad-server") {
        throw new Error("spawn ENOENT");
      }
    });
    listToolsMock.mockResolvedValue({
      tools: [{ name: "search", inputSchema: {}, annotations: { readOnlyHint: true } }],
    });

    const count = await syncAllMcpTools(fakeConn, workspaceRoot);

    expect(count).toBe(1); // only "good"'s one tool
    expect(getToolMetadata("mcp__good__search")).toBeDefined();
    expect(getToolMetadata("mcp__bad__search")).toBeUndefined();
    expect(printErrorMock).toHaveBeenCalledWith(expect.stringContaining("bad"));
  });
});
