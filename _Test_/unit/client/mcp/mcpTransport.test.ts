/**
 * Unit tests — client mcp/mcpRegistry.ts: buildTransport, HEADER_SECRET_PREFIX.
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Real modules wired     : buildTransport itself (the pure factory).
 * Mocks                  : `@modelcontextprotocol/sdk/client/{stdio,streamableHttp,sse}.js`
 *   are replaced with `vi.fn()` constructors so we can inspect exactly what
 *   each transport was constructed with, with no real spawn/socket.
 *
 * Category checklist:
 *   ✅ Normal   — stdio passes command/args/env; bearer token becomes Authorization
 *   ✅ Boundary — missing args defaults to []; no token means no Authorization header;
 *                 a header value containing "=" survives intact
 *   ✅ Error    — a malformed URL throws, naming the server and the bad URL
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../../../packages/client/src/config/types.js";

const { StdioClientTransportMock, StreamableHTTPClientTransportMock, SSEClientTransportMock } =
  vi.hoisted(() => ({
    StdioClientTransportMock: vi.fn(),
    StreamableHTTPClientTransportMock: vi.fn(),
    SSEClientTransportMock: vi.fn(),
  }));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: StdioClientTransportMock,
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: StreamableHTTPClientTransportMock,
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: SSEClientTransportMock,
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn();
    listTools = vi.fn();
    close = vi.fn();
  },
}));

import {
  HEADER_SECRET_PREFIX,
  buildTransport,
} from "../../../../packages/client/src/mcp/mcpRegistry.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildTransport — stdio", () => {
  const stdioConfig: McpServerConfig = {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@me/mcp"],
  };

  it("passes command, args, and secrets as env (normal)", () => {
    buildTransport("mytool", stdioConfig, { API_KEY: "abc" });
    expect(StdioClientTransportMock).toHaveBeenCalledWith({
      command: "npx",
      args: ["-y", "@me/mcp"],
      env: { API_KEY: "abc" },
    });
  });

  it("defaults missing args to an empty array (boundary)", () => {
    buildTransport("mytool", { transport: "stdio", command: "tokensave" }, {});
    expect(StdioClientTransportMock).toHaveBeenCalledWith({
      command: "tokensave",
      args: [],
      env: {},
    });
  });
});

describe("buildTransport — http (streamable, default)", () => {
  const httpConfig: McpServerConfig = {
    transport: "http",
    url: "https://mcp.example.com/mcp",
  };

  it("builds a streamable-HTTP transport by default (normal)", () => {
    buildTransport("myapi", httpConfig, {});
    expect(StreamableHTTPClientTransportMock).toHaveBeenCalledTimes(1);
    expect(SSEClientTransportMock).not.toHaveBeenCalled();
  });

  it("maps secrets.token to an Authorization: Bearer header (normal)", () => {
    buildTransport("myapi", httpConfig, { token: "secret-tok" });
    const [, options] = StreamableHTTPClientTransportMock.mock.calls[0]!;
    expect((options as { requestInit: { headers: Record<string, string> } }).requestInit.headers).toEqual(
      { Authorization: "Bearer secret-tok" },
    );
  });

  it("sends no Authorization header when no token is configured (boundary)", () => {
    buildTransport("myapi", httpConfig, {});
    const [, options] = StreamableHTTPClientTransportMock.mock.calls[0]!;
    expect(
      (options as { requestInit: { headers: Record<string, string> } }).requestInit.headers,
    ).toEqual({});
  });

  it(`maps a "${HEADER_SECRET_PREFIX}X-Api-Key" secret to a real X-Api-Key header (normal)`, () => {
    buildTransport("myapi", httpConfig, { [`${HEADER_SECRET_PREFIX}X-Api-Key`]: "key-123" });
    const [, options] = StreamableHTTPClientTransportMock.mock.calls[0]!;
    expect(
      (options as { requestInit: { headers: Record<string, string> } }).requestInit.headers,
    ).toEqual({ "X-Api-Key": "key-123" });
  });

  it("combines a bearer token and a custom header (normal)", () => {
    buildTransport("myapi", httpConfig, {
      token: "tok",
      [`${HEADER_SECRET_PREFIX}X-Team-Id`]: "team-9",
    });
    const [, options] = StreamableHTTPClientTransportMock.mock.calls[0]!;
    expect(
      (options as { requestInit: { headers: Record<string, string> } }).requestInit.headers,
    ).toEqual({ Authorization: "Bearer tok", "X-Team-Id": "team-9" });
  });

  it("preserves a header value containing '=' intact (boundary)", () => {
    buildTransport("myapi", httpConfig, {
      [`${HEADER_SECRET_PREFIX}X-Signed`]: "abc=def=ghi",
    });
    const [, options] = StreamableHTTPClientTransportMock.mock.calls[0]!;
    expect(
      (options as { requestInit: { headers: Record<string, string> } }).requestInit.headers,
    ).toEqual({ "X-Signed": "abc=def=ghi" });
  });

  it("passes the parsed URL as a URL instance (normal)", () => {
    buildTransport("myapi", httpConfig, {});
    const [endpoint] = StreamableHTTPClientTransportMock.mock.calls[0]!;
    expect(endpoint).toBeInstanceOf(URL);
    expect((endpoint as URL).href).toBe("https://mcp.example.com/mcp");
  });

  it("throws, naming the server and the bad URL, for a malformed URL (error)", () => {
    expect(() =>
      buildTransport("myapi", { transport: "http", url: "not a url" }, {}),
    ).toThrowError(/myapi.*not a url|not a url.*myapi/);
    expect(StreamableHTTPClientTransportMock).not.toHaveBeenCalled();
  });
});

describe("buildTransport — http (sse)", () => {
  const httpConfig: McpServerConfig = {
    transport: "http",
    url: "https://mcp.example.com/sse",
  };

  it("builds an SSE transport when httpKind is 'sse' (normal)", () => {
    buildTransport("myapi", httpConfig, {}, "sse");
    expect(SSEClientTransportMock).toHaveBeenCalledTimes(1);
    expect(StreamableHTTPClientTransportMock).not.toHaveBeenCalled();
  });

  it("applies the same header logic to the SSE transport (normal)", () => {
    buildTransport("myapi", httpConfig, { token: "tok" }, "sse");
    const [, options] = SSEClientTransportMock.mock.calls[0]!;
    expect(
      (options as { requestInit: { headers: Record<string, string> } }).requestInit.headers,
    ).toEqual({ Authorization: "Bearer tok" });
  });
});
