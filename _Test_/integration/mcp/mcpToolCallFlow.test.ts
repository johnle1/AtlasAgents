/**
 * Integration tests — MCP tool calls through the real approval-gate chain:
 * handleMcpCall -> mcpBridge.callMcpTool -> mcpRegistry -> an in-process
 * fake MCP server.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : handleMcpCall (fileProxy/handlers/mcpHandlers.ts),
 *                          mcpBridge.callMcpTool, mcpRegistry.ts's discovery/
 *                          connection/approval-metadata logic, and the real
 *                          disk-backed encrypted config (temp HOME).
 * Mocks                  : `@modelcontextprotocol/sdk/client/*` (fake
 *   server, no real spawn/socket), `ui/approvalFlow.js` (the actual Ink
 *   prompt UI is out of scope here — only whether it's *invoked* matters),
 *   and `renderer/fileOperations.js` (its `appendBlock`/`getTheme` chain
 *   needs a live Ink tree this test doesn't have).
 *
 * Category checklist:
 *   ✅ Normal   — a readOnlyHint:true tool runs with no approval prompt
 *   ✅ Normal   — a readOnlyHint:false tool prompts, and args pass through verbatim
 *   ✅ Boundary — a server-wide readOnly override is beaten by the tool's own
 *                 readOnlyHint:false annotation
 *   ✅ Error    — declining never reaches the server; an undiscovered tool
 *                 name fails closed
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempHome, type TempHome } from "../../helpers/tempHome.js";

const { connectMock, listToolsMock, callToolMock, closeMock, requestApprovalMock } = vi.hoisted(
  () => ({
    connectMock: vi.fn().mockResolvedValue(undefined),
    listToolsMock: vi.fn().mockResolvedValue({ tools: [] }),
    callToolMock: vi.fn().mockResolvedValue({ isError: false, content: "ok" }),
    closeMock: vi.fn().mockResolvedValue(undefined),
    requestApprovalMock: vi.fn(async () => ({ approved: true })),
  }),
);

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = connectMock;
    listTools = listToolsMock;
    callTool = callToolMock;
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

vi.mock("../../../packages/client/src/ui/approvalFlow.js", () => ({
  requestApprovalWithFeedback: requestApprovalMock,
  printDeclineFeedback: vi.fn(),
}));

vi.mock("../../../packages/client/src/renderer/fileOperations.js", () => ({
  printTokenSaveOp: vi.fn(),
  printTokenSaveResult: vi.fn(),
}));

describe("integration — MCP tool call approval gate", () => {
  let tempHome: TempHome;

  let handleMcpCall: typeof import("../../../packages/client/src/fileProxy/handlers/mcpHandlers.js").handleMcpCall;
  let loadConfig: typeof import("../../../packages/client/src/config/index.js").loadConfig;
  let updateConfig: typeof import("../../../packages/client/src/config/index.js").updateConfig;
  let unlockOrSetupConfigCipher: typeof import("../../../packages/client/src/config/index.js").unlockOrSetupConfigCipher;
  let lockCipher: typeof import("@atlasagents/shared").lockCipher;
  let listMcpTools: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").listMcpTools;
  let resetToolRegistryForTests: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").resetToolRegistryForTests;
  let disconnectAllMcpClients: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").disconnectAllMcpClients;

  beforeAll(async () => {
    tempHome = createTempHome("atlas-mcp-call-flow-");

    const configMod = await import("../../../packages/client/src/config/index.js");
    loadConfig = configMod.loadConfig;
    updateConfig = configMod.updateConfig;
    unlockOrSetupConfigCipher = configMod.unlockOrSetupConfigCipher;

    const cipherMod = await import("@atlasagents/shared");
    lockCipher = cipherMod.lockCipher;

    const callHandlerMod = await import(
      "../../../packages/client/src/fileProxy/handlers/mcpHandlers.js"
    );
    handleMcpCall = callHandlerMod.handleMcpCall;

    const registryMod = await import("../../../packages/client/src/mcp/mcpRegistry.js");
    listMcpTools = registryMod.listMcpTools;
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
    listToolsMock.mockReset().mockResolvedValue({ tools: [] });
    callToolMock.mockReset().mockResolvedValue({ isError: false, content: "ok" });
    closeMock.mockClear().mockResolvedValue(undefined);
    requestApprovalMock.mockReset().mockResolvedValue({ approved: true });
  });

  afterEach(async () => {
    await disconnectAllMcpClients();
    lockCipher();
    fs.rmSync(path.join(tempHome.dir, ".atlasagents", "config.json"), { force: true });
  });

  const context = { workspaceRoot: "/workspace" } as never;

  /** Configures + discovers a server so its tools are both callable (config) and approval-gate-known (registry). */
  const setUpServer = async (
    serverId: string,
    serverReadOnly: boolean | undefined,
    tools: Array<{ name: string; readOnlyHint?: boolean }>,
  ): Promise<void> => {
    const serverConfig = {
      transport: "stdio" as const,
      command: "fake-server",
      ...(serverReadOnly !== undefined ? { readOnly: serverReadOnly } : {}),
    };
    const config = loadConfig();
    updateConfig({
      mcpServers: { ...config.mcpServers, [serverId]: serverConfig },
    });
    listToolsMock.mockResolvedValueOnce({
      tools: tools.map((t) => ({
        name: t.name,
        inputSchema: { type: "object", properties: {} },
        ...(t.readOnlyHint !== undefined ? { annotations: { readOnlyHint: t.readOnlyHint } } : {}),
      })),
    });
    await listMcpTools(serverId, serverConfig, {});
  };

  it("a readOnlyHint:true tool runs with no approval prompt (normal)", async () => {
    await setUpServer("readsrv", undefined, [{ name: "search", readOnlyHint: true }]);

    const result = (await handleMcpCall(context, {
      tool: "mcp__readsrv__search",
      arguments: { q: "x" },
    })) as { isError: boolean };

    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(callToolMock).toHaveBeenCalledWith({ name: "search", arguments: { q: "x" } });
    expect(result.isError).toBe(false);
  });

  it("a readOnlyHint:false tool prompts, and running it forwards args verbatim (normal)", async () => {
    await setUpServer("writesrv", undefined, [{ name: "create", readOnlyHint: false }]);

    await handleMcpCall(context, {
      tool: "mcp__writesrv__create",
      arguments: { title: "New issue" },
    });

    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledWith({
      name: "create",
      arguments: { title: "New issue" },
    });
  });

  it("declining returns feedback and never reaches the server (error)", async () => {
    requestApprovalMock.mockResolvedValueOnce({ approved: false, feedback: "not now" });
    await setUpServer("writesrv", undefined, [{ name: "create", readOnlyHint: false }]);

    const result = (await handleMcpCall(context, {
      tool: "mcp__writesrv__create",
      arguments: {},
    })) as { isError: boolean; errorMessage?: string };

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe("not now");
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it("an undiscovered tool name fails closed (error)", async () => {
    await expect(
      handleMcpCall(context, { tool: "mcp__ghost__delete_everything", arguments: {} }),
    ).rejects.toThrow(/not discovered from a connected MCP server/);
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it("a server-wide readOnly override is beaten by the tool's own readOnlyHint:false (boundary)", async () => {
    await setUpServer("mixedsrv", true, [
      { name: "unannotated" }, // no own annotation -> inherits server override (read-only)
      { name: "explicit_write", readOnlyHint: false }, // own annotation wins over server override
    ]);

    await handleMcpCall(context, { tool: "mcp__mixedsrv__unannotated", arguments: {} });
    expect(requestApprovalMock).not.toHaveBeenCalled();

    await handleMcpCall(context, { tool: "mcp__mixedsrv__explicit_write", arguments: {} });
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
  });
});
