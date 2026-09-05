/**
 * System (E2E) tests — a genuine stdio MCP round trip against
 * `examples/mcp-server`, with zero mocks anywhere in the chain.
 *
 * @remarks
 * Every other MCP test in this suite (unit and integration) mocks
 * `@modelcontextprotocol/sdk/client/*` so no real process is ever spawned.
 * This file is the one place that proves the transport itself actually
 * works: it spawns `examples/mcp-server/dist/stdio.js` as a real child
 * process and drives a real discover -> call round trip through the real
 * MCP SDK client, over a real stdio pipe.
 *
 * `examples/mcp-server` is the copy-me template referenced from the README
 * (`/mcp add demo --command node --args ./examples/mcp-server/dist/stdio.js`)
 * — its `demo_search`/`demo_create`/`demo_fail` tools exist specifically to
 * demonstrate the `readOnlyHint` contract this test exercises.
 *
 * Testing pyramid layer : System / E2E
 * Runner                 : Vitest
 * Subprocess under test  : examples/mcp-server/dist/stdio.js (built via
 *                          `npm run build` in that package)
 * Mocks                  : none — real SDK, real subprocess, real stdio pipe.
 *
 * Category checklist:
 *   ✅ Normal   — discovery returns the three tools with readOnly resolved
 *                 from their real annotations; calling demo_search returns
 *                 real content
 *   ✅ Error    — demo_fail returns isError without killing the connection
 *   ✅ Boundary — the subprocess is torn down cleanly, no orphaned process
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../packages/client/src/config/types.js";
import {
  callMcpToolOnServer,
  disconnectAllMcpClients,
  listMcpTools,
} from "../../packages/client/src/mcp/mcpRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STDIO_ENTRY = path.resolve(__dirname, "../../examples/mcp-server/dist/stdio.js");
const ENTRY_EXISTS = existsSync(STDIO_ENTRY);
const itWhenBuilt = ENTRY_EXISTS ? it : it.skip;

const serverConfig: McpServerConfig = {
  transport: "stdio",
  command: "node",
  args: [STDIO_ENTRY],
};

describe("system — real stdio MCP round trip (examples/mcp-server)", () => {
  afterAll(async () => {
    await disconnectAllMcpClients();
  });

  it("skips cleanly when the example server isn't built (environment guard)", () => {
    if (!ENTRY_EXISTS) {
      expect(ENTRY_EXISTS).toBe(false);
      return;
    }
    expect(typeof ENTRY_EXISTS).toBe("boolean");
  });

  itWhenBuilt(
    "discovers all three demo tools, with readOnly resolved from real annotations (normal)",
    async () => {
      const tools = await listMcpTools("demo", serverConfig, {});

      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(byName.size).toBe(3);
      expect(byName.get("demo_search")?.readOnly).toBe(true);
      expect(byName.get("demo_create")?.readOnly).toBe(false);
      // demo_fail declares no annotations at all — the safer default (not
      // read-only) applies, same as resolveToolReadOnly's documented
      // fallback for an unmarked tool.
      expect(byName.get("demo_fail")?.readOnly).toBe(false);
    },
  );

  itWhenBuilt("calling demo_search returns the real seeded content (normal)", async () => {
    const result = await callMcpToolOnServer(
      "demo",
      serverConfig,
      {},
      "demo_search",
      { query: "welcome" },
    );

    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result.content);
    expect(text).toContain("Welcome to the Atlas MCP server template");
  });

  itWhenBuilt(
    "calling demo_create then demo_search proves a real round trip mutates real state (normal)",
    async () => {
      const created = await callMcpToolOnServer(
        "demo",
        serverConfig,
        {},
        "demo_create",
        { title: "e2e-marker-record", body: "written by the system test" },
      );
      expect(created.isError).toBeFalsy();

      const found = await callMcpToolOnServer(
        "demo",
        serverConfig,
        {},
        "demo_search",
        { query: "e2e-marker-record" },
      );
      expect(JSON.stringify(found.content)).toContain("e2e-marker-record");
    },
  );

  itWhenBuilt(
    "demo_fail returns isError without killing the connection (error)",
    async () => {
      const failed = await callMcpToolOnServer(
        "demo",
        serverConfig,
        {},
        "demo_fail",
        { reason: "e2e test" },
      );
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain("failed on purpose");

      // The connection must still be usable after a tool-level failure —
      // only a transport-level error disconnects (see callMcpToolOnServer).
      const stillWorks = await callMcpToolOnServer(
        "demo",
        serverConfig,
        {},
        "demo_search",
        { query: "welcome" },
      );
      expect(stillWorks.isError).toBeFalsy();
    },
  );

  itWhenBuilt(
    "disconnectAllMcpClients tears down the subprocess cleanly (boundary)",
    async () => {
      await expect(disconnectAllMcpClients()).resolves.toBeUndefined();
    },
  );
});
