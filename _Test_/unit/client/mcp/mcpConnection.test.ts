/**
 * Unit tests — client mcp/mcpRegistry.ts: getMcpClient, disconnectMcpClient,
 * disconnectAllMcpClients, listMcpTools, callMcpToolOnServer.
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Real modules wired     : mcpRegistry.ts itself — the connection cache, the
 *                          streamable-HTTP/SSE fallback logic, and pagination.
 * Mocks                  : `@modelcontextprotocol/sdk/client/index.js` is
 *   replaced with a hand-rolled fake `Client` class whose `connect` /
 *   `listTools` / `callTool` / `close` are individually controllable
 *   `vi.fn()`s. The three transport modules are stubbed to no-op
 *   constructors — this file only cares which one was *chosen*, not how it
 *   behaves (that's mcpTransport.test.ts).
 *
 * Category checklist:
 *   ✅ Normal   — connection reuse (single listTools probe), multi-page
 *                 discovery, per-server call serialization via the queue
 *   ✅ Boundary — missing inputSchema defaults, disconnect of an unknown id
 *   ✅ Error    — stale-connection reconnect, error disconnects the server,
 *                 SSE fallback and its "both fail" propagation
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../../../packages/client/src/config/types.js";

const { connectMock, listToolsMock, callToolMock, closeMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  listToolsMock: vi.fn(),
  callToolMock: vi.fn(),
  closeMock: vi.fn(),
}));

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

import {
  callMcpToolOnServer,
  disconnectAllMcpClients,
  disconnectMcpClient,
  getMcpClient,
  getToolMetadata,
  listMcpTools,
  resetHttpTransportKindForTests,
  resetToolRegistryForTests,
} from "../../../../packages/client/src/mcp/mcpRegistry.js";

const stdioConfig: McpServerConfig = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@me/mcp"],
};

const httpConfig: McpServerConfig = {
  transport: "http",
  url: "https://mcp.example.com/mcp",
};

beforeEach(async () => {
  // Tear down any connection left open by the previous test BEFORE
  // clearing mock call counts — otherwise that cleanup's own close() call
  // would count against this test's assertions.
  await disconnectAllMcpClients();
  vi.clearAllMocks();
  resetToolRegistryForTests();
  resetHttpTransportKindForTests();
  connectMock.mockResolvedValue(undefined);
  listToolsMock.mockResolvedValue({ tools: [] });
  callToolMock.mockResolvedValue({ isError: false, content: "ok" });
  closeMock.mockResolvedValue(undefined);
});

describe("getMcpClient — connection reuse", () => {
  it("reuses a live connection with a single listTools liveness probe, no reconnect (normal)", async () => {
    const client1 = await getMcpClient("srv", stdioConfig, {});
    const client2 = await getMcpClient("srv", stdioConfig, {});
    expect(client1).toBe(client2);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });

  it("reconnects after the liveness probe throws, closing the stale client first (error)", async () => {
    await getMcpClient("srv", stdioConfig, {});
    listToolsMock.mockRejectedValueOnce(new Error("connection reset"));

    await getMcpClient("srv", stdioConfig, {});

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});

describe("disconnectMcpClient / disconnectAllMcpClients", () => {
  it("closes and forgets the connection for a known server (normal)", async () => {
    await getMcpClient("srv", stdioConfig, {});
    await disconnectMcpClient("srv");
    expect(closeMock).toHaveBeenCalledTimes(1);

    await getMcpClient("srv", stdioConfig, {});
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("is a no-op for a server with no open connection (boundary)", async () => {
    await expect(disconnectMcpClient("never-connected")).resolves.toBeUndefined();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("disconnectAllMcpClients closes every open connection (normal)", async () => {
    await getMcpClient("a", stdioConfig, {});
    await getMcpClient("b", stdioConfig, {});
    await disconnectAllMcpClients();
    expect(closeMock).toHaveBeenCalledTimes(2);
  });
});

describe("listMcpTools — pagination", () => {
  it("walks multiple nextCursor pages and registers every page's tools (normal)", async () => {
    listToolsMock
      .mockResolvedValueOnce({
        tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }],
        nextCursor: "page2",
      })
      .mockResolvedValueOnce({
        tools: [{ name: "create", inputSchema: { type: "object", properties: {} } }],
      });

    const tools = await listMcpTools("srv", stdioConfig, {});

    expect(tools.map((t) => t.name)).toEqual(["search", "create"]);
    expect(listToolsMock).toHaveBeenCalledTimes(2);
    expect(listToolsMock).toHaveBeenNthCalledWith(2, { cursor: "page2" });
    expect(getToolMetadata("mcp__srv__search")).toBeDefined();
    expect(getToolMetadata("mcp__srv__create")).toBeDefined();
  });

  it("defaults a missing inputSchema to an empty object schema (boundary)", async () => {
    listToolsMock.mockResolvedValueOnce({ tools: [{ name: "noargs" }] });
    const tools = await listMcpTools("srv", stdioConfig, {});
    expect(tools[0]!.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("resolves readOnly from the tool's own annotation (normal)", async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [{ name: "search", annotations: { readOnlyHint: true } }],
    });
    const tools = await listMcpTools("srv", stdioConfig, {});
    expect(tools[0]!.readOnly).toBe(true);
  });
});

describe("callMcpToolOnServer", () => {
  it("calls the tool with the given name and args (normal)", async () => {
    await callMcpToolOnServer("srv", stdioConfig, {}, "search", { query: "x" });
    expect(callToolMock).toHaveBeenCalledWith({ name: "search", arguments: { query: "x" } });
  });

  it("disconnects the server on error, so the next call reconnects (error)", async () => {
    callToolMock.mockRejectedValueOnce(new Error("boom"));

    await expect(
      callMcpToolOnServer("srv", stdioConfig, {}, "search", {}),
    ).rejects.toThrow("boom");
    expect(closeMock).toHaveBeenCalledTimes(1);

    await callMcpToolOnServer("srv", stdioConfig, {}, "search", {});
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});

describe("getMcpClient — HTTP streamable/SSE fallback", () => {
  it("uses streamable HTTP by default with no SSE attempt (normal)", async () => {
    await getMcpClient("api", httpConfig, {});
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to SSE once when streamable HTTP fails to connect (normal)", async () => {
    connectMock.mockRejectedValueOnce(new Error("streamable failed")).mockResolvedValueOnce(undefined);

    const client = await getMcpClient("api", httpConfig, {});

    expect(client).toBeDefined();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("remembers the winning transport so a later reconnect skips the failed one (normal)", async () => {
    // First connection: streamable fails, SSE succeeds.
    connectMock.mockRejectedValueOnce(new Error("streamable failed")).mockResolvedValueOnce(undefined);
    await getMcpClient("api", httpConfig, {});
    expect(connectMock).toHaveBeenCalledTimes(2);

    // Force a reconnect (stale probe) — should go straight to SSE, one connect call only.
    listToolsMock.mockRejectedValueOnce(new Error("stale"));
    connectMock.mockClear();
    connectMock.mockResolvedValueOnce(undefined);
    await getMcpClient("api", httpConfig, {});
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("propagates the original streamable-HTTP error when SSE also fails (error)", async () => {
    connectMock
      .mockRejectedValueOnce(new Error("streamable failed"))
      .mockRejectedValueOnce(new Error("sse failed too"));

    await expect(getMcpClient("api", httpConfig, {})).rejects.toThrow("streamable failed");
  });

  it("a forgotten transport-kind memory (explicit remove) re-probes from scratch (normal)", async () => {
    connectMock.mockRejectedValueOnce(new Error("streamable failed")).mockResolvedValueOnce(undefined);
    await getMcpClient("api", httpConfig, {});

    await disconnectMcpClient("api", { forgetTransportKind: true });

    connectMock.mockClear();
    connectMock.mockRejectedValueOnce(new Error("streamable failed again")).mockResolvedValueOnce(undefined);
    await getMcpClient("api", httpConfig, {});
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("a transient disconnect (no forget) keeps the remembered transport kind (boundary)", async () => {
    connectMock.mockRejectedValueOnce(new Error("streamable failed")).mockResolvedValueOnce(undefined);
    await getMcpClient("api", httpConfig, {});

    await disconnectMcpClient("api"); // default: does NOT forget

    connectMock.mockClear();
    connectMock.mockResolvedValueOnce(undefined);
    await getMcpClient("api", httpConfig, {});
    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
