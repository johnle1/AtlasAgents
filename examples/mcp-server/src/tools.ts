/**
 * Reference tool definitions for the Atlas MCP server template.
 *
 * @remarks
 * These three tools are placeholders, not features — none talks to a real
 * service. They all read/write one hardcoded in-memory array (nothing is
 * persisted; restart and it resets) so the template runs immediately with
 * no setup. Delete their bodies and keep the surrounding shape
 * (registration, annotations, zod schemas, error handling) when building
 * your own server.
 *
 * `demo_search` and `demo_create` are a deliberate matched pair: the
 * fastest way to see Atlas's `readOnlyHint` contract in action is to watch
 * the approval prompt fire for one and not the other with everything else
 * held constant.
 *
 * - `demo_search` — the **read-only archetype** (GitHub's `search_issues`,
 *   Jira's search). Marked `readOnlyHint: true`, so in Atlas it runs with
 *   no approval prompt and stays available in plan mode.
 * - `demo_create` — the **mutating archetype** (GitHub's `create_issue`,
 *   Slack's `send_message`). Marked `readOnlyHint: false`, so Atlas prompts
 *   for approval before running it and withholds it in plan mode.
 * - `demo_fail` — always fails, to show the *correct* way to report a tool
 *   failure: return `{ isError: true, content: [...] }` rather than
 *   throwing. A thrown error becomes a JSON-RPC protocol error the model
 *   never sees; an `isError` result is a readable failure it can recover
 *   from — this distinction is easy to get wrong and expensive to debug.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** One fake record `demo_search`/`demo_create` operate on. */
export type DemoRecord = {
  id: string;
  title: string;
  body: string;
};

/**
 * Seed data so `demo_search` has something to find without first calling
 * `demo_create` — makes the template usable the moment it connects.
 */
const seedRecords = (): DemoRecord[] => [
  {
    id: randomUUID(),
    title: "Welcome to the Atlas MCP server template",
    body: "This record exists so demo_search returns something on first use.",
  },
  {
    id: randomUUID(),
    title: "Replace these tools with your own",
    body: "demo_search, demo_create, and demo_fail are placeholders — see tools.ts.",
  },
];

const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Builds a fresh {@link McpServer} with the three demo tools registered.
 *
 * @remarks
 * Kept separate from transport wiring (`stdio.ts`) for two reasons: tests
 * construct a server without touching stdio at all, and a server built
 * this way isn't tied to any one transport — the same instance could be
 * connected to a `StdioServerTransport` or an HTTP transport interchangeably.
 *
 * Each call gets its own in-memory record store — call this once per
 * process (see `stdio.ts`), not once per request.
 */
export const createServer = (): McpServer => {
  const records: DemoRecord[] = seedRecords();

  const server = new McpServer({
    name: "atlas-mcp-server-example",
    version: "0.1.0",
  });

  server.registerTool(
    "demo_search",
    {
      title: "Search demo records",
      description:
        "Searches the demo record store by substring match against title and body. " +
        "Read-only — never modifies anything.",
      inputSchema: {
        query: z.string().describe("Substring to search for, case-insensitive"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Max results to return (default ${DEFAULT_SEARCH_LIMIT})`),
      },
      annotations: {
        title: "Search demo records",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const needle = query.toLowerCase();
      const matches = records
        .filter(
          (record) =>
            record.title.toLowerCase().includes(needle) ||
            record.body.toLowerCase().includes(needle),
        )
        .slice(0, limit ?? DEFAULT_SEARCH_LIMIT);

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No records match "${query}".` }] };
      }

      const lines = matches.map(
        (record) => `- [${record.id}] ${record.title}: ${record.body}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "demo_create",
    {
      title: "Create a demo record",
      description:
        "Creates a new demo record and adds it to the in-memory store. " +
        "Mutates state — this is the tool that should prompt for approval.",
      inputSchema: {
        title: z.string().min(1).describe("Title for the new record"),
        body: z.string().optional().describe("Body text (defaults to empty)"),
      },
      annotations: {
        title: "Create a demo record",
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async ({ title, body }) => {
      const record: DemoRecord = { id: randomUUID(), title, body: body ?? "" };
      records.push(record);
      return {
        content: [
          {
            type: "text",
            text: `Created record [${record.id}] "${record.title}".`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "demo_fail",
    {
      title: "Always fails (demo)",
      description:
        "Always fails, to demonstrate the correct failure shape for a tool call: " +
        "an isError result, not a thrown exception.",
      inputSchema: {
        reason: z
          .string()
          .optional()
          .describe("Optional reason to echo back in the error message"),
      },
    },
    async ({ reason }) => ({
      content: [
        {
          type: "text",
          text: `demo_fail failed on purpose${reason ? `: ${reason}` : "."}`,
        },
      ],
      isError: true,
    }),
  );

  return server;
};
