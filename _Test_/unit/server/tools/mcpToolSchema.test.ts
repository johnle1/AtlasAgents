/**
 * Unit tests — server orchestration/mcp/mcpToolSchema.ts
 */

import { describe, expect, it } from "vitest";
import { mcpToolToAtlasSchema } from "../../../../packages/server/src/orchestration/mcp/mcpToolSchema.js";

describe("mcpToolToAtlasSchema", () => {
  it("maps MCP tool shape to AtlasAgents ToolSchema", () => {
    const schema = mcpToolToAtlasSchema({
      name: "tokensave_search",
      description: "Search the codebase",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    });

    expect(schema.type).toBe("function");
    expect(schema.function.name).toBe("tokensave_search");
    expect(schema.function.description).toBe("Search the codebase");
    expect(schema.function.parameters.required).toEqual(["query"]);
    expect(schema.function.parameters.properties.query).toBeDefined();
  });

  it("defaults description to empty string when missing", () => {
    const schema = mcpToolToAtlasSchema({
      name: "tokensave_status",
      inputSchema: { type: "object" },
    });
    expect(schema.function.description).toBe("");
  });

  it("defaults properties to empty object when missing", () => {
    const schema = mcpToolToAtlasSchema({
      name: "tokensave_status",
      inputSchema: { type: "object" },
    });
    expect(schema.function.parameters.properties).toEqual({});
  });

  it("defaults required to empty array when missing", () => {
    const schema = mcpToolToAtlasSchema({
      name: "tokensave_status",
      inputSchema: { type: "object", properties: {} },
    });
    expect(schema.function.parameters.required).toEqual([]);
  });

  it("coerces required entries to strings", () => {
    const schema = mcpToolToAtlasSchema({
      name: "tokensave_search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: [1 as unknown as string],
      },
    });
    expect(schema.function.parameters.required).toEqual(["1"]);
  });

  it("handles empty inputSchema object", () => {
    const schema = mcpToolToAtlasSchema({
      name: "tokensave_search",
      description: "Search",
      inputSchema: {},
    });
    expect(schema.function.parameters.type).toBe("object");
    expect(schema.function.parameters.properties).toEqual({});
    expect(schema.function.parameters.required).toEqual([]);
  });

  it("handles non-object properties gracefully", () => {
    const schema = mcpToolToAtlasSchema({
      name: "tokensave_search",
      inputSchema: {
        type: "object",
        properties: "invalid" as unknown as Record<string, unknown>,
      },
    });
    expect(schema.function.parameters.properties).toEqual({});
  });
});
