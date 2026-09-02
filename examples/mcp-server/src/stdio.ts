#!/usr/bin/env node
/**
 * stdio entry point for the Atlas MCP server template.
 *
 * @remarks
 * Two things this file exists to demonstrate:
 *
 * 1. **stdout is the protocol channel.** `StdioServerTransport` talks
 *    JSON-RPC over stdin/stdout — any stray `console.log` (yours or a
 *    dependency's) corrupts that stream and the client sees garbled or
 *    truncated messages with no useful error. Everything printed by this
 *    file, and everything your own tool code prints, must go to
 *    `process.stderr` instead. This is the single most common way a first
 *    MCP server breaks.
 * 2. **Credentials arrive as environment variables.** When Atlas spawns a
 *    stdio server, it merges that server's `mcpSecrets[serverId]` bundle
 *    into the child process's environment. `DEMO_API_TOKEN` below is a
 *    stand-in for whatever credential your real server needs — read it the
 *    same way.
 *
 * Connect this to Atlas with:
 * ```
 * /mcp add demo --command node --args ./examples/mcp-server/dist/stdio.js
 * ```
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./tools.js";

const demoToken = process.env.DEMO_API_TOKEN;
if (demoToken) {
  process.stderr.write(
    "[atlas-mcp-server-example] DEMO_API_TOKEN is set — a real server would use this to authenticate.\n",
  );
} else {
  process.stderr.write(
    "[atlas-mcp-server-example] No DEMO_API_TOKEN set — this template doesn't require one, but a real server usually would.\n",
  );
}

const server = createServer();

// connect() calls transport.start() itself — never call start() directly.
await server.connect(new StdioServerTransport());

process.stderr.write("[atlas-mcp-server-example] Connected over stdio.\n");

process.on("unhandledRejection", (error) => {
  process.stderr.write(`[atlas-mcp-server-example] Unhandled rejection: ${String(error)}\n`);
  process.exit(1);
});
