/**
 * Translates AtlasAgents's Ollama-native message/tool shapes to and from the
 * OpenAI-compatible `/v1/chat/completions` wire format used by LM Studio,
 * llama.cpp's server, and any other OpenAI-compatible backend.
 *
 * @remarks
 * Ollama represents tool calls as `{ function: { name, arguments: object } }`
 * with no call id, and correlates tool results by `tool_name`. OpenAI requires
 * every tool call to carry an `id`, tool-call `arguments` to be a JSON string,
 * and tool-result messages to reference that id via `tool_call_id`. This module
 * is the one place that bridges those two shapes.
 */

import type { Message } from "../orchestration/types.js";
import type { ToolSchema } from "../orchestration/tools/types.js";
import { logger } from "../utils/logger.js";

/** Prefix used for synthesized tool call IDs when translating from Ollama format. */
const TOOL_CALL_ID_PREFIX = "call_";

/** Fallback tool name when a tool result references an unknown tool call. */
const UNKNOWN_TOOL_NAME = "unknown";

/** One message in an OpenAI-compatible `/v1/chat/completions` request body. */
export type OpenAiChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

/** One function-tool definition in an OpenAI-compatible request body. */
export type OpenAiToolDefinition = {
  type: "function";
  function: ToolSchema["function"];
};

/**
 * Converts an Ollama-native message array into the OpenAI-compatible shape.
 *
 * @remarks
 * Assistant `tool_calls` get deterministic synthesized ids (`call_1`, `call_2`,
 * ...); the most recent id per tool name is tracked so that the following
 * `role: "tool"` message (correlated by Ollama's `tool_name` field) can be
 * rewritten to reference that id via `tool_call_id`. This assumes each tool
 * name appears at most once between an assistant turn and its result, which
 * matches how {@link Subagent} drives its one-tool-per-turn ReAct loop.
 *
 * @param messages - Conversation turns in AtlasAgents's internal Message shape.
 * @returns Equivalent turns in OpenAI's `/v1/chat/completions` message shape.
 */
export const toOpenAiMessages = (messages: Message[]): OpenAiChatMessage[] => {
  // Track the most recent tool call ID for each tool name. When a tool result
  // message arrives, we look up the tool name here to find its corresponding call ID.
  const lastCallIdByToolName = new Map<string, string>();
  let callCounter = 0;

  return messages.map((message): OpenAiChatMessage => {
    // Transform assistant messages: synthesize deterministic tool call IDs and
    // stringify function arguments to match OpenAI's wire format.
    if (
      message.role === "assistant" &&
      message.tool_calls &&
      message.tool_calls.length > 0
    ) {
      const toolCalls = message.tool_calls.map((call) => {
        callCounter += 1;
        // Generate a deterministic call ID (call_1, call_2, etc.) and track it
        // by tool name so the following tool result message can reference it.
        const id = `${TOOL_CALL_ID_PREFIX}${callCounter}`;
        lastCallIdByToolName.set(call.function.name, id);
        return {
          id,
          type: "function" as const,
          function: {
            name: call.function.name,
            // OpenAI requires arguments as a JSON string, not an object.
            arguments: JSON.stringify(call.function.arguments ?? {}),
          },
        };
      });
      return {
        role: "assistant",
        // OpenAI requires content to be null if empty, not an empty string.
        content: message.content.length > 0 ? message.content : null,
        tool_calls: toolCalls,
      };
    }

    // Transform tool result messages: look up the tool call ID using the tool name.
    if (message.role === "tool") {
      const toolName = message.tool_name ?? "";
      // Try to find the call ID from the most recent tool call with this name.
      const toolCallId = lastCallIdByToolName.get(toolName);

      // If no matching tool call was found, log a warning (could indicate a bug in
      // message sequencing) and generate a synthetic fallback ID.
      if (!toolCallId) {
        const displayToolName = toolName || UNKNOWN_TOOL_NAME;
        logger.warn(
          { toolName: displayToolName },
          "Tool result references tool call that was never made"
        );
      }

      const fallbackId = `${TOOL_CALL_ID_PREFIX}${toolName || UNKNOWN_TOOL_NAME}`;
      return {
        role: "tool",
        content: message.content,
        tool_call_id: toolCallId ?? fallbackId,
      };
    }

    // Pass through system, user, and other message types unchanged.
    return { role: message.role, content: message.content };
  });
};

/**
 * Wraps AtlasAgents tool schemas in the OpenAI function-tool envelope.
 *
 * @remarks
 * {@link ToolSchema} already matches OpenAI's `{ type: "function", function }`
 * shape, so this is effectively a typed pass-through — kept as a named
 * function so the provider adapter has one clear seam if the shapes ever
 * diverge.
 */
export const toOpenAiTools = (tools: ToolSchema[]): OpenAiToolDefinition[] =>
  tools.map((tool) => ({ type: "function", function: tool.function }));
