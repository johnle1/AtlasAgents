#!/usr/bin/env node
/**
 * HTTP entry point for the Atlas MCP server template.
 *
 * @remarks
 * Companion to `stdio.ts` — same `createServer()` from `tools.ts`, plugged
 * into whichever HTTP transport this process was started with instead of
 * `StdioServerTransport`. Demonstrates the two things `stdio.ts` can't: how
 * Atlas's `/mcp add --url` credentials (`--token`, `--header`) arrive as
 * real request headers (see `demo_whoami` in `tools.ts`), and how the
 * legacy SSE transport looks from the server side, for Atlas's
 * streamable-HTTP-then-SSE fallback (`mcpRegistry.ts`'s `getMcpClient`).
 *
 * The session-per-connection bookkeeping below (a `Map` from session ID to
 * transport, `onsessioninitialized`/`onclose` wiring) follows the MCP
 * SDK's own reference pattern for a stateful `StreamableHTTPServerTransport`
 * — see the SDK's `examples/server/simpleStreamableHttp.ts` and
 * `sseAndStreamableHttpCompatibleServer.ts` — just built on plain
 * `node:http` instead of Express, per this package's README ("no framework
 * required"). A single transport instance CANNOT be reused across requests
 * in *stateless* mode (`sessionIdGenerator: undefined`) — the SDK throws
 * "Stateless transport cannot be reused across requests" the second time
 * you try — so stateful, session-scoped transports are the only way to
 * support more than one tool call over one connection with the Node
 * wrapper, which is why this template uses them rather than the simpler-
 * looking stateless mode.
 *
 * Two ways to start it:
 * ```
 * node dist/http.js                        # streamable HTTP (default, recommended)
 * node dist/http.js --sse                  # legacy SSE fallback path
 * DEMO_MCP_TRANSPORT=sse node dist/http.js # same, via env var
 * ```
 *
 * Both modes serve at the SAME path, `/mcp` — deliberately, so one
 * `/mcp add demo --url http://127.0.0.1:<port>/mcp` config works
 * regardless of which mode is running; only the method-level behavior
 * differs (see `handleStreamable`/`handleSse` below). A real server would
 * only ever run one mode, not switch between them — this template
 * switches so one file can serve as the fixture for both of Atlas's HTTP
 * code paths.
 *
 * Binds port 0 (an OS-assigned free port) rather than a fixed one, since a
 * fixed port would collide across a parallel test matrix, and prints the
 * resolved URL to stderr in a fixed, parseable format (stdout stays free
 * for whichever transport is active — see the stdout/stderr note in
 * `stdio.ts`).
 *
 * Connect it to Atlas with:
 * ```
 * /mcp add demo --url http://127.0.0.1:<port>/mcp --token <anything>
 * ```
 *
 * @see {@link ../README.md} — "If you're building an HTTP server instead"
 *   for the credential/header contract Atlas expects from any HTTP server,
 *   not just this template.
 */

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "./tools.js";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

const USE_SSE = process.argv.includes("--sse") || process.env.DEMO_MCP_TRANSPORT === "sse";
const MCP_PATH = "/mcp";
const SSE_MESSAGES_PATH = "/messages";

const log = (line: string): void => {
  process.stderr.write(`[atlas-mcp-server-example] ${line}\n`);
};

const jsonRpcError = (res: ServerResponse, status: number, message: string): void => {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
};

const notFound = (res: ServerResponse): void => {
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found.");
};

/**
 * Streamable-HTTP mode: one session per `Mcp-Session-Id`, each with its own
 * `McpServer` (and so its own in-memory record store — tool state doesn't
 * leak between two different clients' sessions, only within one client's
 * own connection). The very first POST against `MCP_PATH` with no session
 * header creates the session; the SDK's own `handleRequest` then validates
 * that it's actually an `initialize` call and rejects with a clear 400
 * itself if it isn't — see the "no session, no initialize" errors thrown
 * from `validateSession()`/`validateProtocolVersion()` inside the SDK.
 */
const handleStreamable = async (): Promise<RequestHandler> => {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== MCP_PATH) {
      notFound(res);
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    if (sessionId) {
      jsonRpcError(res, 404, "Session not found.");
      return;
    }
    if (req.method !== "POST") {
      jsonRpcError(res, 400, "No valid session ID provided.");
      return;
    }

    // No session yet — this must be the initialize request. Build a fresh
    // McpServer + transport pair for it (mirrors the SDK's own
    // sseAndStreamableHttpCompatibleServer.ts example).
    const mcpServer = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await mcpServer.connect(transport); // connect() calls start() itself.
    await transport.handleRequest(req, res);
  };

  return (req, res) => {
    route(req, res).catch((error) => {
      log(`streamable request failed: ${String(error)}`);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error.");
    });
  };
};

/**
 * Legacy-SSE mode: `GET MCP_PATH` opens the SSE stream (the request
 * Atlas's `SSEClientTransport` fallback makes against the exact URL it was
 * configured with); the server then tells the client where to POST replies
 * via the `endpoint` SSE event, which this template points at
 * `SSE_MESSAGES_PATH?sessionId=...`. Deliberately includes `POST MCP_PATH`
 * in the 404 catch-all below — a streamable-HTTP client's first move is
 * exactly that request, and it must fail here so Atlas's `getMcpClient`
 * falls back to SSE rather than hanging.
 *
 * A fresh `McpServer` is built per connection (mirrors the MCP SDK's own
 * `sseAndStreamableHttpCompatibleServer.ts` reference example) rather than
 * one shared across every GET — reusing a single `McpServer` across
 * sequential `connect()` calls is not a supported pattern and surfaced as
 * a real, load-dependent bug here: a second SSE reconnect against the
 * same subprocess intermittently got a 500 instead of the stream opening,
 * only reproducing under a full, CPU-contended test-suite run — an
 * isolated run of just this file passed every time, which is exactly the
 * kind of failure a shared-instance bug produces.
 */
const handleSse = async (): Promise<RequestHandler> => {
  const sessions = new Map<string, SSEServerTransport>();

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && pathname === MCP_PATH) {
      const mcpServer = createServer();
      const transport = new SSEServerTransport(SSE_MESSAGES_PATH, res);
      sessions.set(transport.sessionId, transport);
      transport.onclose = () => sessions.delete(transport.sessionId);
      await mcpServer.connect(transport); // connect() calls start() itself.
      return;
    }

    if (req.method === "POST" && pathname === SSE_MESSAGES_PATH) {
      const transport = sessions.get(searchParams.get("sessionId") ?? "");
      if (!transport) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Unknown or expired session.");
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    if (pathname === MCP_PATH) {
      // A streamable-HTTP client's first move is exactly this request
      // (POST MCP_PATH, before it's ever seen an SSE stream) — logged so
      // tests can confirm a remembered transport-kind choice actually
      // skips this probe on a later reconnect, rather than just happening
      // to still work.
      log(`sse-mode: rejecting ${req.method} ${pathname} (streamable probe)`);
    }
    notFound(res);
  };

  return (req, res) => {
    route(req, res).catch((error) => {
      log(`sse request failed: ${String(error)}`);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error.");
    });
  };
};

const requestHandler = USE_SSE ? await handleSse() : await handleStreamable();

const httpServer = createHttpServer(requestHandler);

httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const mode = USE_SSE ? "sse" : "streamable-http";
  log(`listening (${mode}) on http://127.0.0.1:${port}${MCP_PATH}`);
});

process.on("unhandledRejection", (error) => {
  log(`Unhandled rejection: ${String(error)}`);
  process.exit(1);
});
