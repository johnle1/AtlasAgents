/**
 * Integration tests — `/mcp add jira` end to end, through the real config
 * and discovery path, with only the `npx`/mcp-remote spawn stubbed.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : handleMcp (commands/mcpHandlers.ts), the Jira
 *                          preset table (mcp/mcpPresets.ts), the real
 *                          encrypted client config (temp HOME), and
 *                          mcpRegistry.ts's discovery/registry logic.
 * Mocks                  : `@modelcontextprotocol/sdk/client/*` (no real
 *   `npx`/`mcp-remote` spawn, no network, no browser OAuth), and
 *   `conn.sendCommand` (captures the outgoing sync payload).
 *
 * Category checklist:
 *   ✅ Normal   — writes exactly the preset config with the v2 endpoint;
 *                 discovered tools land in the registry as mcp__jira__*
 *   ✅ Boundary — prompts for no secrets (mcp-remote owns OAuth); the
 *                 API-token direct-URL alternative stores the token
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

describe("integration — /mcp add jira", () => {
  let tempHome: TempHome;

  let handleMcp: typeof import("../../../packages/client/src/commands/mcpHandlers.js").handleMcp;
  let loadConfig: typeof import("../../../packages/client/src/config/index.js").loadConfig;
  let unlockOrSetupConfigCipher: typeof import("../../../packages/client/src/config/index.js").unlockOrSetupConfigCipher;
  let lockCipher: typeof import("@atlasagents/shared").lockCipher;
  let getToolMetadata: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").getToolMetadata;
  let resetToolRegistryForTests: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").resetToolRegistryForTests;
  let disconnectAllMcpClients: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").disconnectAllMcpClients;

  beforeAll(async () => {
    tempHome = createTempHome("atlas-mcp-jira-preset-");

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
    fs.rmSync(path.join(tempHome.dir, ".atlasagents", "config.json"), { force: true });
    fs.rmSync(path.join(tempHome.dir, ".atlasagents", "mcpToolsCache"), {
      recursive: true,
      force: true,
    });
  });

  const fakeConn = { sendCommand: vi.fn(async () => ({})) } as never;
  const fakeFileProxy = { getWorkspaceRoot: () => tempHome!.dir } as never;
  const makePrompts = (answers: string[] = []) => {
    let i = 0;
    return {
      question: vi.fn(async () => answers[i++] ?? ""),
      choose: vi.fn(),
      pickTheme: vi.fn(),
      pickOption: vi.fn(),
    } as never;
  };

  it("writes exactly the preset config, with the v2 Atlassian endpoint (normal — regression guard)", async () => {
    await handleMcp("add", "jira", fakeConn, fakeFileProxy, makePrompts());

    const config = loadConfig();
    expect(config.mcpServers.jira).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v2/mcp"],
    });
  });

  it("prompts for no secrets — mcp-remote owns the OAuth handshake (boundary)", async () => {
    const prompts = makePrompts();
    await handleMcp("add", "jira", fakeConn, fakeFileProxy, prompts);
    expect((prompts as { question: ReturnType<typeof vi.fn> }).question).not.toHaveBeenCalled();
  });

  it("discovers jira's tools, namespaced mcp__jira__*, into the registry (normal)", async () => {
    await handleMcp("add", "jira", fakeConn, fakeFileProxy, makePrompts());

    expect(listToolsMock).toHaveBeenCalledTimes(1);
    expect(getToolMetadata("mcp__jira__search_issues")).toEqual({
      serverId: "jira",
      toolName: "search_issues",
      readOnly: true,
    });
  });

  it("the API-token direct-URL alternative produces an http server with the token in mcpSecrets (normal)", async () => {
    await handleMcp(
      "add",
      "jira --url https://mcp.atlassian.com/v2/mcp --token api-tok-123",
      fakeConn,
      fakeFileProxy,
      makePrompts(),
    );

    const config = loadConfig();
    expect(config.mcpServers.jira).toEqual({
      transport: "http",
      url: "https://mcp.atlassian.com/v2/mcp",
    });
    expect(config.mcpSecrets.jira).toEqual({ token: "api-tok-123" });
  });
});
