/**
 * Protocol-level tests for the Atlas MCP server template.
 *
 * @remarks
 * Uses `InMemoryTransport.createLinkedPair()` to wire a real SDK `Client`
 * to the real `McpServer` in-process — no subprocess, no port. This
 * exercises the actual JSON-RPC protocol (schema validation, annotation
 * serialization, content-block shapes) rather than calling the tool
 * callbacks directly, so it verifies exactly what Atlas sees over the wire.
 */

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/tools.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let server: McpServer;
let client: Client;

beforeEach(async () => {
  server = createServer();
  client = new Client({ name: "test-client", version: "0.0.0" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

describe("tools/list", () => {
  it("advertises all four tools with non-empty descriptions", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["demo_create", "demo_fail", "demo_search", "demo_whoami"]);

    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("marks demo_search read-only — the annotation Atlas's approval gate depends on", async () => {
    const { tools } = await client.listTools();
    const demoSearch = tools.find((tool) => tool.name === "demo_search");
    expect(demoSearch?.annotations?.readOnlyHint).toBe(true);
  });

  it("does not mark demo_create read-only — it mutates the record store", async () => {
    const { tools } = await client.listTools();
    const demoCreate = tools.find((tool) => tool.name === "demo_create");
    expect(demoCreate?.annotations?.readOnlyHint).not.toBe(true);
  });

  it("exposes the expected input schema for demo_search", async () => {
    const { tools } = await client.listTools();
    const demoSearch = tools.find((tool) => tool.name === "demo_search");
    expect(demoSearch?.inputSchema.properties).toHaveProperty("query");
    expect(demoSearch?.inputSchema.properties).toHaveProperty("limit");
    expect(demoSearch?.inputSchema.required).toEqual(["query"]);
  });

  it("exposes the expected input schema for demo_create", async () => {
    const { tools } = await client.listTools();
    const demoCreate = tools.find((tool) => tool.name === "demo_create");
    expect(demoCreate?.inputSchema.properties).toHaveProperty("title");
    expect(demoCreate?.inputSchema.properties).toHaveProperty("body");
    expect(demoCreate?.inputSchema.required).toEqual(["title"]);
  });
});

describe("demo_search", () => {
  it("finds the seeded record and returns it as text content", async () => {
    const result = await client.callTool({
      name: "demo_search",
      arguments: { query: "template" },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("template");
  });

  it("returns a no-match message rather than an error for an unmatched query", async () => {
    const result = await client.callTool({
      name: "demo_search",
      arguments: { query: "definitely-not-in-the-seed-data" },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("No records match");
  });

  it("respects the limit argument", async () => {
    const result = await client.callTool({
      name: "demo_search",
      arguments: { query: "", limit: 1 },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const lineCount = content[0]?.text?.split("\n").length ?? 0;
    expect(lineCount).toBe(1);
  });
});

describe("demo_create", () => {
  it("creates a record and returns confirmation text", async () => {
    const result = await client.callTool({
      name: "demo_create",
      arguments: { title: "New record", body: "Some body text" },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("New record");
  });

  it("makes the created record findable via demo_search", async () => {
    await client.callTool({
      name: "demo_create",
      arguments: { title: "Findable via search", body: "" },
    });
    const result = await client.callTool({
      name: "demo_search",
      arguments: { query: "Findable via search" },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("Findable via search");
  });

  it("reports a missing required field as an isError result, not a rejection", async () => {
    // The SDK client surfaces a schema-validation failure (JSON-RPC -32602)
    // as an ordinary isError result rather than a rejected promise — the
    // same shape as a tool-level failure like demo_fail's, which is worth
    // knowing: you can't tell "the model sent bad arguments" apart from
    // "the tool failed" just by whether callTool() throws.
    const result = await client.callTool({ name: "demo_create", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("title");
  });
});

describe("demo_fail", () => {
  it("resolves with isError: true rather than rejecting", async () => {
    const result = await client.callTool({
      name: "demo_fail",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it("echoes the given reason in the error content", async () => {
    const result = await client.callTool({
      name: "demo_fail",
      arguments: { reason: "on purpose" },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("on purpose");
  });
});

describe("demo_whoami", () => {
  // InMemoryTransport carries no HTTP request, so extra.requestInfo is
  // undefined here — the real header-reporting behavior only exercises
  // over a genuine HTTP/SSE connection (see
  // _Test_/system/mcpHttpServer.e2e.test.ts). This just proves the tool
  // degrades safely rather than throwing when there's no request to report on.
  it("reports no auth-shaped headers when there is no underlying HTTP request", async () => {
    const result = await client.callTool({ name: "demo_whoami", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("No auth-shaped headers");
  });
});
