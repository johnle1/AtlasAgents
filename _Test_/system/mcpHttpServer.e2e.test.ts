/**
 * System (E2E) tests — a genuine HTTP MCP round trip against
 * `examples/mcp-server`'s HTTP entry point, with zero mocks anywhere in
 * the chain.
 *
 * @remarks
 * `mcpStdioServer.e2e.test.ts` proves the stdio transport works over a
 * real pipe. This file is the HTTP/SSE counterpart: every HTTP test
 * elsewhere in the suite (unit and integration) replaces
 * `StreamableHTTPClientTransport`/`SSEClientTransport` with `vi.fn()`, so
 * nothing else proves that `buildHttpHeaders` (`mcpRegistry.ts`) actually
 * puts credentials on the wire, or that the streamable-HTTP-then-SSE
 * fallback (`getMcpClient`) really works against a socket that behaves the
 * way a genuinely SSE-only server does.
 *
 * `SSEClientTransport`/`SSEServerTransport` are both marked `@deprecated`
 * in the installed MCP SDK (favor `StreamableHTTPClientTransport`) — the
 * fallback this file exercises is a compatibility shim for servers that
 * haven't migrated yet, not the preferred path. `examples/mcp-server`'s
 * `--sse` mode exists specifically to be that kind of server for testing.
 *
 * Testing pyramid layer : System / E2E
 * Runner                 : Vitest
 * Subprocess under test  : examples/mcp-server/dist/http.js (built via
 *                          `npm run build` in that package), spawned twice
 *                          per relevant test — once in each mode — since a
 *                          real server never switches transports mid-life;
 *                          `--sse` mode exists purely as this file's fixture.
 * Mocks                  : none — real SDK, real subprocess, real sockets.
 *
 * Category checklist:
 *   ✅ Normal   — streamable-HTTP discovery + demo_search round trip;
 *                 a bearer token and a custom header both arrive as real
 *                 request headers; the SSE fallback itself succeeds
 *   ✅ Boundary — a remembered transport kind skips the streamable probe
 *                 on a later reconnect; an explicit forget re-probes
 *   ✅ Error    — a streamable failure that isn't a 404 (so SSE also
 *                 fails) surfaces the ORIGINAL streamable-HTTP error, not
 *                 the SSE fallback's
 */

import { createServer as createRawHttpServer } from "node:http";
import type { Server as RawHttpServer } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../packages/client/src/config/types.js";
import {
  callMcpToolOnServer,
  disconnectAllMcpClients,
  disconnectMcpClient,
  listMcpTools,
  pinHttpTransportKind,
  resetHttpTransportKindForTests,
  resetToolRegistryForTests,
} from "../../packages/client/src/mcp/mcpRegistry.js";
import { assertBuiltUnderCi } from "../helpers/ciExampleGuard.js";
import {
  HTTP_ENTRY,
  HTTP_ENTRY_EXISTS,
  startMcpHttpServer,
  stopMcpHttpServer,
  type McpHttpServerHandle,
} from "../helpers/mcpHttpServerProcess.js";

assertBuiltUnderCi("examples/mcp-server/dist/http.js", HTTP_ENTRY_EXISTS);
const itWhenBuilt = HTTP_ENTRY_EXISTS ? it : it.skip;

/**
 * Extracts the text content of a non-error tool result, for substring
 * assertions.
 *
 * @remarks
 * Typed against `callMcpToolOnServer`'s own return type rather than a
 * hand-written `{ content: unknown }` shape: the SDK's `callTool` return
 * type is a union that also covers a pre-2024-10-07 compatibility result
 * shaped `{ toolResult: unknown }` (no `content` at all), which none of
 * this file's calls ever actually produce, but which TypeScript still
 * checks assignability against — a narrower hand-written parameter type
 * fails that check even though a direct `result.content` PROPERTY ACCESS
 * (as the other MCP e2e file uses) does not, since every union member
 * carries an index signature that satisfies plain property access but not
 * whole-object assignment to an unrelated stricter shape.
 */
type ToolCallResult = Awaited<ReturnType<typeof callMcpToolOnServer>>;
const textOf = (result: ToolCallResult): string => JSON.stringify(result.content);

describe("system — real HTTP MCP round trip (examples/mcp-server)", () => {
  it("skips cleanly when the example server isn't built (environment guard)", () => {
    if (!HTTP_ENTRY_EXISTS) {
      expect(HTTP_ENTRY_EXISTS).toBe(false);
      return;
    }
    expect(HTTP_ENTRY).toContain("http.js");
  });

  describe("streamable HTTP (normal)", () => {
    let server: McpHttpServerHandle;
    const serverId = "demo-streamable";

    beforeEach(async () => {
      resetToolRegistryForTests();
      resetHttpTransportKindForTests();
      server = await startMcpHttpServer("streamable");
    });

    afterEach(async () => {
      await disconnectAllMcpClients();
      await stopMcpHttpServer(server);
    });

    itWhenBuilt("discovers all four demo tools and round-trips demo_search", async () => {
      const config: McpServerConfig = { transport: "http", url: server.url };
      const tools = await listMcpTools(serverId, config, {});
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(byName.size).toBe(4);
      expect(byName.get("demo_search")?.readOnly).toBe(true);
      expect(byName.get("demo_whoami")?.readOnly).toBe(true);

      const result = await callMcpToolOnServer(serverId, config, {}, "demo_search", {
        query: "welcome",
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("Welcome to the Atlas MCP server template");
    });

    itWhenBuilt(
      "a bearer token arrives as a real Authorization header, and state persists across two calls",
      async () => {
        const config: McpServerConfig = { transport: "http", url: server.url };
        const secrets = { token: "e2e-bearer-marker-token" };

        const whoami = await callMcpToolOnServer(serverId, config, secrets, "demo_whoami", {});
        expect(textOf(whoami)).toContain("authorization");
        expect(textOf(whoami)).not.toContain("e2e-bearer-marker-token"); // never echoed

        const created = await callMcpToolOnServer(serverId, config, secrets, "demo_create", {
          title: "e2e-http-marker-record",
          body: "written by the http system test",
        });
        expect(created.isError).toBeFalsy();

        const found = await callMcpToolOnServer(serverId, config, secrets, "demo_search", {
          query: "e2e-http-marker-record",
        });
        expect(textOf(found)).toContain("e2e-http-marker-record");
      },
    );

    itWhenBuilt(
      "a header:X-Api-Key secret arrives as a literal X-Api-Key header, alongside a bearer token",
      async () => {
        const config: McpServerConfig = { transport: "http", url: server.url };
        const secrets = {
          token: "combo-bearer-marker",
          "header:X-Api-Key": "combo-header-marker",
        };

        const whoami = await callMcpToolOnServer(serverId, config, secrets, "demo_whoami", {});
        const text = textOf(whoami);
        expect(text).toContain("authorization");
        expect(text).toContain("x-api-key");
        expect(text).not.toContain("combo-bearer-marker");
        expect(text).not.toContain("combo-header-marker");
      },
    );

    itWhenBuilt("no credentials means no auth-shaped headers at all", async () => {
      const config: McpServerConfig = { transport: "http", url: server.url };
      const whoami = await callMcpToolOnServer(serverId, config, {}, "demo_whoami", {});
      expect(textOf(whoami)).toContain("No auth-shaped headers");
    });
  });

  describe("streamable-HTTP-then-SSE fallback (normal + boundary)", () => {
    let server: McpHttpServerHandle;
    const serverId = "demo-sse-fallback";

    beforeEach(async () => {
      resetToolRegistryForTests();
      resetHttpTransportKindForTests();
      server = await startMcpHttpServer("sse");
    });

    afterEach(async () => {
      await disconnectAllMcpClients();
      await stopMcpHttpServer(server);
    });

    itWhenBuilt(
      "falls back to SSE against an sse-only server, headers included, and discovers real tools (normal)",
      async () => {
        const config: McpServerConfig = { transport: "http", url: server.url };
        const secrets = { token: "sse-fallback-marker-token" };

        const tools = await listMcpTools(serverId, config, secrets);
        expect(new Set(tools.map((t) => t.name))).toEqual(
          new Set(["demo_search", "demo_create", "demo_fail", "demo_whoami"]),
        );

        const whoami = await callMcpToolOnServer(serverId, config, secrets, "demo_whoami", {});
        expect(textOf(whoami)).toContain("authorization");
        expect(textOf(whoami)).not.toContain("sse-fallback-marker-token");
      },
    );

    itWhenBuilt(
      "remembers the winning transport: a later reconnect skips the streamable probe entirely (boundary)",
      async () => {
        const config: McpServerConfig = { transport: "http", url: server.url };

        await listMcpTools(serverId, config, {}); // first connect: streamable fails, SSE wins
        const probesAfterFirstConnect = (
          server.stderr.text.match(/streamable probe/g) ?? []
        ).length;
        expect(probesAfterFirstConnect).toBeGreaterThan(0);

        // A transient disconnect (no forget) — the remembered "sse" choice survives it.
        await disconnectMcpClient(serverId);
        await listMcpTools(serverId, config, {});

        const probesAfterSecondConnect = (
          server.stderr.text.match(/streamable probe/g) ?? []
        ).length;
        expect(probesAfterSecondConnect).toBe(probesAfterFirstConnect);
      },
    );

    itWhenBuilt(
      "an explicit forget (as /mcp remove does) makes the next connect re-probe streamable first (boundary)",
      async () => {
        const config: McpServerConfig = { transport: "http", url: server.url };

        await listMcpTools(serverId, config, {});
        const probesAfterFirstConnect = (
          server.stderr.text.match(/streamable probe/g) ?? []
        ).length;

        await disconnectMcpClient(serverId, { forgetTransportKind: true });
        await listMcpTools(serverId, config, {});

        const probesAfterForgetAndReconnect = (
          server.stderr.text.match(/streamable probe/g) ?? []
        ).length;
        expect(probesAfterForgetAndReconnect).toBeGreaterThan(probesAfterFirstConnect);
      },
    );

    itWhenBuilt(
      "an explicitly pinned SSE transport kind skips the streamable probe on the very first connect (boundary)",
      async () => {
        const config: McpServerConfig = { transport: "http", url: server.url };
        pinHttpTransportKind(serverId, "sse");

        await listMcpTools(serverId, config, {});
        const probes = (server.stderr.text.match(/streamable probe/g) ?? []).length;
        expect(probes).toBe(0);
      },
    );
  });

  describe("both transports fail (error)", () => {
    // A hand-rolled fixture, not examples/mcp-server: this test needs GET
    // and POST at the same path to fail with DIFFERENTLY recognizable
    // errors, so the assertion can prove which one Atlas propagates rather
    // than just observing "some error was thrown" (both attempts failing
    // with an identical low-level error, e.g. two ECONNREFUSEDs, wouldn't
    // distinguish "propagates the original" from "propagates whichever
    // failed last").
    let rawServer: RawHttpServer;
    let url: string;

    beforeEach(async () => {
      resetToolRegistryForTests();
      resetHttpTransportKindForTests();
      rawServer = createRawHttpServer((req, res) => {
        const marker = req.method === "POST" ? "STREAMABLE-MARKER" : "SSE-MARKER";
        res.writeHead(500, { "Content-Type": "text/plain" }).end(marker);
      });
      await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
      const address = rawServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      url = `http://127.0.0.1:${port}/mcp`;
    });

    afterEach(async () => {
      await disconnectAllMcpClients();
      await new Promise<void>((resolve) => rawServer.close(() => resolve()));
    });

    itWhenBuilt(
      "propagates the streamable-HTTP error, not the SSE fallback's, when both fail",
      async () => {
        const config: McpServerConfig = { transport: "http", url };
        await expect(listMcpTools("demo-both-fail", config, {})).rejects.toThrow(
          /STREAMABLE-MARKER/,
        );
      },
    );
  });
});

afterAll(async () => {
  await disconnectAllMcpClients();
});
