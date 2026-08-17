/**
 * Converts MCP (Model Context Protocol) tool schemas to AtlasAgents's internal schema format.
 *
 * @remarks
 * MCP servers advertise their tools with a JSON-schema format that varies in structure
 * and rigor. This module adapts those schemas into the standardized `ToolSchema` shape
 * that the subagent tool registry expects, with defensive validation to handle malformed
 * or missing schema properties gracefully.
 *
 * The conversion is defensive: if an MCP tool omits `properties` or `required`, we
 * substitute sensible defaults (`{}` and `[]`) rather than crashing, so that a broken
 * or legacy MCP server doesn't cripple the entire orchestrator.
 *
 * @example
 * ```ts
 * const mcpTool = {
 *   name: "tokensave_search",
 *   description: "Search the codebase",
 *   inputSchema: {
 *     properties: { query: { type: "string" } },
 *     required: ["query"]
 *   }
 * };
 * const schema = mcpToolToAtlasSchema(mcpTool);
 * {
 *   type: "function",
 *   function: {
 *     name: "tokensave_search",
 *     description: "Search the codebase",
 *     parameters: {
 *       type: "object",
 *       properties: { query: { type: "string" } },
 *       required: ["query"]
 *     }
 *   }
 * }
 * ```
 */

import type { ToolSchema } from "../tools/types.js";

/**
 * Raw tool schema as advertised by an MCP server.
 *
 * @remarks
 * This represents the JSON-schema structure MCP servers return via the
 * `tools/list` message. It's intentionally loose (not all fields are
 * guaranteed) to accommodate servers with varying levels of schema rigor.
 *
 * `inputSchema` follows the JSON Schema Draft 7 convention, but MCP servers
 * may omit `properties` or `required` if the tool takes no arguments or
 * if the server is lenient about schema validation.
 */
export type McpToolSyncPayload = {
  /** Tool name passed verbatim to the model (e.g. `"tokensave_search"`). */
  name: string;

  /** Human-readable description of what the tool does. Optional. */
  description?: string;

  /** JSON-schema describing the tool's input arguments (may be incomplete or missing fields). */
  inputSchema: Record<string, unknown>;
};

/**
 * Converts an MCP tool schema to AtlasAgents's internal {@link ToolSchema} format.
 *
 * @remarks
 * Adapts the raw MCP schema (which may be incomplete or have structural
 * variations) into the standardized shape the subagent tool registry expects.
 * Performs defensive validation: missing `properties` or `required` fields
 * are replaced with safe defaults (`{}` and `[]`) so malformed schemas
 * don't cause the orchestrator to crash.
 *
 * @param mcpTool - The MCP tool schema from the server.
 * @returns A standardized `ToolSchema` ready to be added to the subagent tool registry.
 *
 * @example
 * ```ts
 * const schema = mcpToolToAtlasSchema({
 *   name: "code_search",
 *   description: "Find usages of a symbol",
 *   inputSchema: {
 *     properties: { symbol: { type: "string" } },
 *     required: ["symbol"]
 *   }
 * });
 * // Now schema can be passed directly to the model for tool calling
 * ```
 */
export const mcpToolToAtlasSchema = (
  mcpTool: McpToolSyncPayload,
): ToolSchema => ({
  type: "function",
  function: {
    name: mcpTool.name,
    description: mcpTool.description ?? "",
    parameters: {
      type: "object",
      // GUARD: Validate that `properties` exists and is a non-null object before
      // using it. MCP servers sometimes omit this field if the tool takes no
      // arguments. If missing or malformed, default to an empty object so the
      // model sees an argumentless tool rather than a schema with undefined fields.
      properties:
        typeof mcpTool.inputSchema.properties === "object" &&
        mcpTool.inputSchema.properties !== null
          ? (mcpTool.inputSchema.properties as Record<string, unknown>)
          : {},
      // GUARD: Ensure `required` is an array before using it. Some MCP servers
      // omit this field entirely. Convert each element to a string defensively
      // (in case a server sends numeric IDs), and default to an empty array for
      // tools that take no mandatory arguments.
      required: Array.isArray(mcpTool.inputSchema.required)
        ? mcpTool.inputSchema.required.map(String)
        : [],
    },
  },
});
