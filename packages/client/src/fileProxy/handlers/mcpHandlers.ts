/**
 * MCP / TokenSave tool calls routed through the local file proxy.
 *
 * @remarks
 * Only tools listed in {@link ALLOWED_TOKENSAVE_TOOLS} may run. The handler
 * prints a history label then delegates to {@link callTokenSaveTool} with the
 * workspace root for credential/context scoping.
 */

import type { DispatchContext } from "../types.js";
import { callTokenSaveTool } from "../../mcp/mcpBridge.js";
import { ALLOWED_TOKENSAVE_TOOLS } from "../../mcp/tokenSaveClient.js";
import {
  tokenSaveHistoryLabel,
  tokenSaveHistoryTarget,
} from "../../mcp/tokenSaveLabels.js";
import {
  printTokenSaveOp,
  printTokenSaveResult,
} from "../../renderer/fileOperations.js";

/**
 * Invokes an allow-listed TokenSave / MCP tool with the given arguments.
 *
 * @param context - Supplies `workspaceRoot` for the MCP bridge.
 * @param body - Expects `{ tool: string, arguments?: object }`.
 * @returns Opaque tool result from the MCP bridge.
 * @throws {@link Error} When `tool` is missing or not in the allow-list.
 *
 * @example
 * ```ts
 * await handleMcpCall(context, {
 *   tool: "tokensave.search",
 *   arguments: { query: "auth flow" },
 * });
 * ```
 */
export const handleMcpCall = async (
  context: DispatchContext,
  body: Record<string, unknown>,
): Promise<unknown> => {
  const tool = String(body.tool ?? "");

  if (tool.length === 0) {
    throw new Error("mcp.call requires a tool name");
  }

  // Fail closed: even a connected MCP server cannot run arbitrary tool ids.
  if (!ALLOWED_TOKENSAVE_TOOLS.has(tool)) {
    throw new Error(
      `Tool "${tool}" is not allowed. Allowed tools: ${Array.from(ALLOWED_TOKENSAVE_TOOLS).join(", ")}`,
    );
  }

  const rawArguments = body.arguments;
  const args: Record<string, unknown> =
    typeof rawArguments === "object" && rawArguments !== null
      ? (rawArguments as Record<string, unknown>)
      : {};

  printTokenSaveOp(
    tokenSaveHistoryLabel(tool),
    tokenSaveHistoryTarget(tool, args),
  );

  const result = await callTokenSaveTool(context.workspaceRoot, tool, args);

  // Echo whatever the tool actually found (file paths, symbol locations, …) —
  // mirrors printBashRan showing stdout after a command runs.
  if (!result.isError && result.data !== undefined) {
    const resultText =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data);
    printTokenSaveResult(resultText);
  }

  return result;
};
