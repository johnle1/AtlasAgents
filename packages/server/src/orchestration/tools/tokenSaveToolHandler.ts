/**
 * Wraps TokenSave (MCP) tool schemas into {@link ToolHandler}s the agent loop can execute.
 *
 * @remarks
 * Unlike the built-in file/command tools, TokenSave tools (code search,
 * symbol context, caller/callee/impact analysis) are discovered dynamically
 * from an MCP server at connection time — their schemas arrive as data, not
 * as compile-time exports. This module provides one generic handler
 * implementation that works for any of them: forward the call to the
 * workspace's MCP bridge, format the result (or error) as agent feedback.
 * `createToolRegistry` in `./registry.js` calls this to turn the discovered
 * schemas into runnable handlers for a given run.
 */

import type { ToolHandler, ToolSchema } from "./types.js";
import { formatObservation } from "./toolHandler.js";
import { tokenSaveActivityMessage } from "./tokenSaveLabels.js";

/**
 * Per-tool timeout overrides for TokenSave calls that are known to be slower
 * than the default (deep call-graph analysis).
 */
const TOKENSAVE_TIMEOUT_MS: Record<string, number> = {
  tokensave_impact: 120_000,
  tokensave_callers: 120_000,
};

/** Timeout applied to any TokenSave tool not listed in {@link TOKENSAVE_TIMEOUT_MS}. */
const DEFAULT_TOKENSAVE_TIMEOUT_MS = 60_000;

/**
 * Formats an MCP tool result payload as text suitable for agent feedback.
 *
 * @param data - The raw result data from the MCP call (any JSON-serializable value).
 * @returns The string unchanged if it's already a string; otherwise pretty-printed JSON.
 */
export const formatMcpData = (data: unknown): string => {
  if (typeof data === "string") {
    return data;
  }
  return JSON.stringify(data, null, 2);
};

/**
 * Builds one {@link ToolHandler} per TokenSave schema, all sharing the same execution logic.
 *
 * @remarks
 * Each handler emits a "searching" status update (with a tool-specific
 * activity message), calls the tool through `ctx.workspace.callMcpTool`, and
 * converts the result into feedback — an error message on failure, or the
 * formatted payload on success. The per-tool timeout is looked up from
 * {@link TOKENSAVE_TIMEOUT_MS}.
 *
 * @param schemas - TokenSave tool schemas discovered from the MCP server.
 * @returns One handler per schema, ready to merge into the tool registry.
 *
 * @example
 * ```ts
 * const handlers = createTokenSaveToolHandlers(discoveredSchemas);
 * // Agent calls tokensave_search({ query: "auth middleware" })
 * // → forwarded to ctx.workspace.callMcpTool, result formatted as feedback.
 * ```
 */
export const createTokenSaveToolHandlers = (
  schemas: ToolSchema[],
): ToolHandler[] =>
  schemas.map((schema) => {
    const toolName = schema.function.name;
    return {
      schema,
      async execute(tokenSaveArgs, handlerContext) {
        const timeoutMs =
          TOKENSAVE_TIMEOUT_MS[toolName] ?? DEFAULT_TOKENSAVE_TIMEOUT_MS;
        handlerContext.emitSubagentStatus(
          "searching",
          "◌",
          tokenSaveActivityMessage(toolName, tokenSaveArgs),
        );
        const result = await handlerContext.workspace.callMcpTool(toolName, tokenSaveArgs, timeoutMs);

        if (result.isError) {
          return {
            done: false,
            summary: "",
            feedback: formatObservation(
              toolName,
              tokenSaveArgs,
              `[tokensave error]: ${result.errorMessage ?? "unknown error"}`,
            ),
            escalationCount: handlerContext.escalationCount,
          };
        }

        return {
          done: false,
          summary: "",
          feedback: formatObservation(
            toolName,
            tokenSaveArgs,
            formatMcpData(result.data),
          ),
          escalationCount: handlerContext.escalationCount,
        };
      },
    };
  });
