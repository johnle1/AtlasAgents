/**
 * MCP tool calls routed through the local file proxy.
 *
 * @remarks
 * Two paths, dispatched by {@link parseNamespacedTool}:
 * - **TokenSave** (bare `tokensave_*` names) — unchanged from before generic
 *   MCP support existed: fail-closed allow-list, no approval prompt (its 6
 *   tools are all read-only searches/lookups).
 * - **Every other configured server** (namespaced `mcp__<server>__<tool>`
 *   names) — fails closed if the tool was never actually discovered from a
 *   connected server, then requires approval for any tool not resolved as
 *   read-only (see {@link resolveToolReadOnly}). Plan mode never reaches
 *   this at all for a mutating tool — the server-side registry already
 *   withholds it (see `agentTurn.ts`) — this is the client-side backstop for
 *   every other mode.
 */

import type { DispatchContext } from "../types.js";
import { callMcpTool, callTokenSaveTool } from "../../mcp/mcpBridge.js";
import { ALLOWED_TOKENSAVE_TOOLS } from "../../mcp/tokenSaveClient.js";
import { getToolMetadata, parseNamespacedTool } from "../../mcp/mcpRegistry.js";
import {
  tokenSaveHistoryLabel,
  tokenSaveHistoryTarget,
} from "../../mcp/tokenSaveLabels.js";
import {
  printTokenSaveOp,
  printTokenSaveResult,
} from "../../renderer/fileOperations.js";
import {
  printDeclineFeedback,
  requestApprovalWithFeedback,
} from "../../ui/approvalFlow.js";

const extractArgs = (rawArguments: unknown): Record<string, unknown> =>
  typeof rawArguments === "object" && rawArguments !== null
    ? (rawArguments as Record<string, unknown>)
    : {};

/** Truncates a JSON-stringified args blob for the approval prompt's command label. */
const truncateArgsPreview = (args: Record<string, unknown>): string => {
  const json = JSON.stringify(args);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
};

/**
 * Invokes an allow-listed TokenSave tool with the given arguments.
 *
 * @remarks
 * Unchanged behavior from before generic MCP support: fail-closed
 * allow-list, no approval prompt (every TokenSave tool is a read-only
 * search/lookup).
 */
const handleTokenSaveCall = async (
  context: DispatchContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  if (!ALLOWED_TOKENSAVE_TOOLS.has(tool)) {
    throw new Error(
      `Tool "${tool}" is not allowed. Allowed tools: ${Array.from(ALLOWED_TOKENSAVE_TOOLS).join(", ")}`,
    );
  }

  printTokenSaveOp(
    tokenSaveHistoryLabel(tool),
    tokenSaveHistoryTarget(tool, args),
  );

  const result = await callTokenSaveTool(context.workspaceRoot, tool, args);

  if (!result.isError && result.data !== undefined) {
    printTokenSaveResult(
      typeof result.data === "string" ? result.data : JSON.stringify(result.data),
    );
  }

  return result;
};

/**
 * Invokes a tool on a user-configured MCP server (anything added via
 * `/mcp add`), gating any non-read-only tool behind approval.
 *
 * @throws {@link Error} When the tool was never discovered from a connected
 *   server — fails closed rather than trusting a name the model supplied.
 */
const handleGenericMcpCall = async (
  serverId: string,
  toolName: string,
  namespacedTool: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const metadata = getToolMetadata(namespacedTool);
  if (!metadata) {
    throw new Error(
      `Tool "${namespacedTool}" is not allowed — it was not discovered from a connected MCP server. Run /mcp tools to see what's available.`,
    );
  }

  if (!metadata.readOnly) {
    const { approved, feedback } = await requestApprovalWithFeedback(
      {
        type: "runSkip",
        command: `mcp ${serverId}.${toolName} ${truncateArgsPreview(args)}`,
      },
      "What should change about this tool call?",
    );
    if (!approved) {
      printDeclineFeedback(feedback);
      return { isError: true, errorMessage: feedback ?? "Declined by user" };
    }
  }

  printTokenSaveOp(serverId, toolName);
  const result = await callMcpTool(serverId, toolName, args);

  if (!result.isError && result.data !== undefined) {
    printTokenSaveResult(
      typeof result.data === "string" ? result.data : JSON.stringify(result.data),
    );
  }

  return result;
};

/**
 * Invokes an MCP tool with the given arguments, dispatching between the
 * TokenSave and generic-server paths.
 *
 * @param context - Supplies `workspaceRoot` for the TokenSave path.
 * @param body - Expects `{ tool: string, arguments?: object }`.
 * @returns Opaque tool result from whichever path handled the call.
 * @throws {@link Error} When `tool` is missing or not a recognized MCP tool name.
 *
 * @example
 * ```ts
 * await handleMcpCall(context, {
 *   tool: "mcp__github__create_issue",
 *   arguments: { title: "Bug" },
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

  const args = extractArgs(body.arguments);

  const parsed = parseNamespacedTool(tool);
  if (!parsed) {
    throw new Error(`Tool "${tool}" is not a recognized MCP tool name.`);
  }

  if (parsed.serverId === "tokensave") {
    return handleTokenSaveCall(context, tool, args);
  }

  return handleGenericMcpCall(parsed.serverId, parsed.toolName, tool, args);
};
