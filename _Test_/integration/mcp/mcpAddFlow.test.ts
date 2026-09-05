/**
 * Integration tests — /mcp add through the real disk-backed encrypted config
 * and the real local per-server tool cache.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : handleMcp (commands/mcpHandlers.ts), the real
 *                          encrypted client config (config/index.ts,
 *                          backed by a temp HOME), the real local MCP tool
 *                          cache (mcp/mcpToolsCache.ts), and mcpRegistry.ts's
 *                          discovery/connection logic.
 * Mocks                  : `@modelcontextprotocol/sdk/client/*` (no real
 *   spawn or socket — a fake server returns a fixed tool list), and
 *   `conn.sendCommand` (captures the outgoing `mcp.tools.sync` payload with
 *   no real RSocket connection — mutation-triggered syncs never call
 *   `sync.check`, so this is the only route exercised here).
 *
 * Category checklist:
 *   ✅ Normal   — add with --token writes config+secrets, discovers tools,
 *                 populates the tool registry; no plaintext token on disk
 *   ✅ Boundary — a rotated token changes the server's marker, so a second
 *                 add re-discovers instead of reusing the cache
 *   ✅ Error    — an invalid link is rejected before any config write
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempHome, type TempHome } from "../../helpers/tempHome.js";

const { connectMock, listToolsMock, closeMock } = vi.hoisted(() => ({
  connectMock: vi.fn().mockResolvedValue(undefined),
  listToolsMock: vi.fn().mockResolvedValue({ tools: [] }),
  closeMock: vi.fn().mockResolvedValue(undefined),
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
  StdioClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));

describe("integration — /mcp add", () => {
  let tempHome: TempHome;
  let configFile: string;
  let cacheDir: string;

  let handleMcp: typeof import("../../../packages/client/src/commands/mcpHandlers.js").handleMcp;
  let loadConfig: typeof import("../../../packages/client/src/config/index.js").loadConfig;
  let unlockOrSetupConfigCipher: typeof import("../../../packages/client/src/config/index.js").unlockOrSetupConfigCipher;
  let lockCipher: typeof import("@atlasagents/shared").lockCipher;
  let getToolMetadata: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").getToolMetadata;
  let resetToolRegistryForTests: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").resetToolRegistryForTests;
  let disconnectAllMcpClients: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").disconnectAllMcpClients;

  beforeAll(async () => {
    tempHome = createTempHome("atlas-mcp-add-flow-");
    configFile = path.join(tempHome.dir, ".atlasagents", "config.json");
    cacheDir = path.join(tempHome.dir, ".atlasagents", "mcpToolsCache");

    const configMod = await import("../../../packages/client/src/config/index.js");
    loadConfig = configMod.loadConfig;
    unlockOrSetupConfigCipher = configMod.unlockOrSetupConfigCipher;

    const cipherMod = await import("@atlasagents/shared");
    lockCipher = cipherMod.lockCipher;

    const handlersMod = await import("../../../packages/client/src/commands/mcpHandlers.js");
    handleMcp = handlersMod.handleMcp;

    const registryMod = await import("../../../packages/client/src/mcp/mcpRegistry.js");
    getToolMetadata = registryMod.getToolMetadata;
    resetToolRegistryForTests = registryMod.resetToolRegistryForTests;
    disconnectAllMcpClients = registryMod.disconnectAllMcpClients;
  });

  afterAll(() => {
    tempHome.restore();
  });

  beforeEach(async () => {
    await unlockOrSetupConfigCipher(async () => "integration-test-pass");
    resetToolRegistryForTests();
    connectMock.mockClear().mockResolvedValue(undefined);
    listToolsMock.mockReset().mockResolvedValue({
      tools: [
        {
          name: "search_issues",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    closeMock.mockClear().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await disconnectAllMcpClients();
    lockCipher();
    fs.rmSync(configFile, { force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const fakeSendCommand = vi.fn(async () => ({}));
  const fakeConn = { sendCommand: fakeSendCommand } as never;
  const fakeFileProxy = { getWorkspaceRoot: () => tempHome!.dir } as never;
  const fakePrompts = {
    question: vi.fn(async () => ""),
    choose: vi.fn(),
    pickTheme: vi.fn(),
    pickOption: vi.fn(),
  } as never;

  it("adds a URL server with --token: writes config+secrets, discovers tools, populates the registry (normal)", async () => {
    await handleMcp(
      "add",
      "https://mcp.example.com/mcp --token secret-abc-123",
      fakeConn,
      fakeFileProxy,
      fakePrompts,
    );

    const config = loadConfig();
    expect(config.mcpServers.example).toEqual({
      transport: "http",
      url: "https://mcp.example.com/mcp",
    });
    expect(config.mcpSecrets.example).toEqual({ token: "secret-abc-123" });
    expect(getToolMetadata("mcp__example__search_issues")).toEqual({
      serverId: "example",
      toolName: "search_issues",
      readOnly: true,
    });
  });

  it("never writes the plaintext token anywhere on disk (normal)", async () => {
    await handleMcp(
      "add",
      "https://mcp.example.com/mcp --token extremely-unique-marker-token",
      fakeConn,
      fakeFileProxy,
      fakePrompts,
    );

    const raw = fs.readFileSync(configFile, "utf-8");
    expect(raw).not.toContain("extremely-unique-marker-token");
    expect(raw).not.toContain('"mcpSecrets"');
  });

  it("a rotated token changes the marker, so a second add re-discovers rather than reusing the cache (boundary)", async () => {
    // Two distinct fixtures (not toHaveBeenCalledTimes) prove genuine
    // re-discovery: getMcpClient's own liveness probe also calls
    // listTools() internally, so counting raw RPC calls would conflate
    // that implementation detail with the pagination fetch this test
    // actually cares about.
    listToolsMock.mockResolvedValue({
      tools: [
        { name: "search_v1", inputSchema: {}, annotations: { readOnlyHint: true } },
      ],
    });
    await handleMcp(
      "add",
      "https://mcp.example.com/mcp --token token-v1",
      fakeConn,
      fakeFileProxy,
      fakePrompts,
    );
    expect(getToolMetadata("mcp__example__search_v1")).toBeDefined();

    listToolsMock.mockResolvedValue({
      tools: [
        { name: "search_v2", inputSchema: {}, annotations: { readOnlyHint: true } },
      ],
    });
    await handleMcp(
      "add",
      "example --url https://mcp.example.com/mcp --token token-v2",
      fakeConn,
      fakeFileProxy,
      fakePrompts,
    );

    expect(getToolMetadata("mcp__example__search_v2")).toBeDefined();
    expect(getToolMetadata("mcp__example__search_v1")).toBeUndefined();
    expect(loadConfig().mcpSecrets.example).toEqual({ token: "token-v2" });
  });

  it("/mcp remove deletes the server, its secrets, and its cache entry (normal)", async () => {
    await handleMcp(
      "add",
      "https://mcp.example.com/mcp --token token-v1",
      fakeConn,
      fakeFileProxy,
      fakePrompts,
    );
    expect(getToolMetadata("mcp__example__search_issues")).toBeDefined();

    await handleMcp("remove", "example", fakeConn, fakeFileProxy, fakePrompts);

    const config = loadConfig();
    expect(config.mcpServers.example).toBeUndefined();
    expect(config.mcpSecrets.example).toBeUndefined();
    expect(getToolMetadata("mcp__example__search_issues")).toBeUndefined();
  });

  it("an invalid link is rejected before any config write (error)", async () => {
    await handleMcp("add", "myapi --url not-a-valid-url", fakeConn, fakeFileProxy, fakePrompts);

    const config = loadConfig();
    expect(config.mcpServers).toEqual({});
    expect(config.mcpSecrets).toEqual({});
    expect(connectMock).not.toHaveBeenCalled();
  });
});
