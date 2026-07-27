/**
 * Retry and escalation logic for handling malformed agent turns.
 *
 * @remarks
 * This module evaluates agent output and decides whether to:
 * - Let the turn proceed (thinking + valid tool call)
 * - Retry with corrective feedback (malformed JSON, missing tool call, no thinking)
 * - Escalate to the lead agent (exhausted retry budget)
 *
 * The decision tree prioritizes getting back on track (simple retries) but escalates
 * when the agent appears stuck or budget is exhausted.
 */

import { THINKING_TAG_OPEN, THINKING_TAG_CLOSE } from "../toolProtocol.js";
import type { RetryResult } from "./types.js";

const NO_TOOL_MESSAGE =
  "You must call exactly one tool. No valid tool call was found in your response.";

const NO_THINKING_MESSAGE = `Rejected: think inside ${THINKING_TAG_OPEN}${THINKING_TAG_CLOSE} before calling a tool.`;

const FINISH_LEGACY_EXAMPLE =
  '<<TOOL>>{"tool":"finish","summary":"Dev dependencies already installed; no changes needed."}<<END>>';

const THOUGHT_NO_TOOL_MESSAGE =
  "You thought but did not call a tool. Writing action: finish (or any other tool) inside the think block is not enough — you must also emit the real tool call. If the subtask is already complete, call the finish tool with a summary. Legacy format example: " +
  FINISH_LEGACY_EXAMPLE +
  " — never use action: none.";

const ACTION_NONE_MESSAGE =
  "action: none is not valid. When setup or prior work already satisfies this subtask, call the finish tool with a one-line summary. Legacy format example: " +
  FINISH_LEGACY_EXAMPLE +
  " For native tool models, emit a finish function call with a summary argument.";

const MALFORMED_TOOL_JSON_MESSAGE =
  'Your tool call was not valid JSON. The whole tool call must be a single line of valid JSON. Never press Enter inside it — every real line break must be written as \\n, and every " inside a value must be written as \\". Do not wrap file content in markdown code fences (``` or ```tsx); put the raw file content only. Field values are plain JSON strings, never code: no backticks, template literals, ${...} interpolation, or function calls like readFile(...). Do not describe what should go in a field or use placeholders like [file content here]. If you need existing file content, read_file first and paste the literal text. Retry the same action with valid JSON.';

/**
 * Detects whether a think block contains `action: none` (signals task completion).
 *
 * @remarks
 * Used to distinguish between "I'm done, no tool needed" (valid) and "I forgot to
 * call a tool" (agent error). Regex is case-insensitive to catch variations.
 */
const thinksActionIsNone = (thinkText: string): boolean =>
  /^\s*action:\s*none\s*$/im.test(thinkText);

/**
 * Evaluates a single agent turn and decides whether to retry, escalate, or proceed.
 *
 * @remarks
 * Implements a three-path decision tree:
 * - **No tool calls**: Check for malformed JSON (retry or escalate), agent's intent
 *   (distinguish "action: none" from "forgot to call"), or just "forgot to call"
 * - **Tool called but no thinking**: Reject (thinking is mandatory for planning/safety)
 * - **Thinking + valid tool**: Proceed (no retry needed)
 *
 * Escalation only triggers when the retry budget (`maxEscalations`) is exhausted.
 * Simple retries (format corrections) do not consume the budget; they're format
 * errors, not reasoning confusion.
 *
 * @param assistantContent - The full text the model generated (thinking block +
 *   everything else). Used to append to history on retry.
 * @param thinkText - Extracted thinking block text, or null if none present.
 * @param toolCallsCount - Number of valid tool calls extracted from the response.
 * @param hadMalformedToolBlock - True if the response included a malformed tool
 *   call block (invalid JSON, missing markers, etc.).
 * @param thinkRetryCount - Current retry attempt count (incremented on each retry
 *   that consumes budget, not on format-error retries).
 * @param maxEscalations - Maximum retry attempts before escalating to the lead agent.
 * @returns Decision: retry, escalate, or proceed. If retrying without escalation,
 *   includes corrective messages to append to history.
 *
 * @example
 * ```ts
 * // Agent produced malformed JSON, thinking present, budget available
 * const result = handleAgentRetry(
 *   "I will write the file <<TOOL>>{invalid json...}",
 *   "I need to update the config file",
 *   0, // no valid tool calls parsed
 *   true, // malformed block detected
 *   0, // first retry
 *   3 // allow 3 escalations
 * );
 * // result.shouldRetry = true
 * // result.shouldEscalate = false
 * // result.updatedMessages contains JSON guidance
 * ```
 */
export const handleAgentRetry = (
  assistantContent: string,
  thinkText: string | null,
  toolCallsCount: number,
  hadMalformedToolBlock: boolean,
  thinkRetryCount: number,
  maxEscalations: number,
): RetryResult => {
  if (toolCallsCount === 0) {
    // PATH 1: No tool calls detected in the response.

    if (hadMalformedToolBlock) {
      // The agent tried to call a tool but the JSON was invalid. This consumes
      // the retry budget since it signals the agent is confused about tool format.
      if (thinkRetryCount >= maxEscalations) {
        // Budget exhausted — the agent has tried multiple times and still can't
        // produce valid JSON. Escalate to get human guidance on what to do next.
        return {
          shouldRetry: true,
          updatedMessages: [],
          updatedThinkRetryCount: thinkRetryCount + 1,
          shouldEscalate: true,
          escalationReason: "Produced malformed tool call JSON after retries",
        };
      }

      // Budget remains — retry with detailed JSON guidance.
      return {
        shouldRetry: true,
        updatedMessages: [
          { role: "assistant", content: assistantContent },
          { role: "user", content: MALFORMED_TOOL_JSON_MESSAGE },
        ],
        updatedThinkRetryCount: thinkRetryCount + 1,
      };
    }

    // Agent produced thinking but no tool call. Two distinct scenarios:
    // 1. "action: none" in think block = task already complete, valid completion
    // 2. "I forgot to call a tool" = agent error, needs correction
    // This distinction changes which guidance message we send.
    if (thinkText && thinkRetryCount >= maxEscalations) {
      // Budget exhausted after multiple "no tool call" attempts. Agent may be
      // stuck in a loop (thinking but not acting). Escalate.
      return {
        shouldRetry: true,
        updatedMessages: [],
        updatedThinkRetryCount: thinkRetryCount + 1,
        shouldEscalate: true,
        escalationReason: "Thought but did not call a tool after retries",
      };
    }

    if (thinkText) {
      // Budget available — retry with context-specific guidance based on what
      // the think block says. If it says "action: none", guide to use the finish
      // tool. Otherwise, guide to actually call a tool.
      return {
        shouldRetry: true,
        updatedMessages: [
          { role: "assistant", content: assistantContent },
          {
            role: "user",
            content: thinksActionIsNone(thinkText)
              ? ACTION_NONE_MESSAGE
              : THOUGHT_NO_TOOL_MESSAGE,
          },
        ],
        updatedThinkRetryCount: thinkRetryCount + 1,
      };
    }

    // No thinking block, no tool call → straightforward format error.
    // This is rare and usually means the agent completely skipped the think step.
    // Retry without consuming budget (format error, not reasoning confusion).
    return {
      shouldRetry: true,
      updatedMessages: [
        { role: "assistant", content: assistantContent },
        { role: "user", content: NO_TOOL_MESSAGE },
      ],
      updatedThinkRetryCount: thinkRetryCount,
    };
  }

  // PATH 2: Tool called but no thinking block.
  // Thinking is mandatory (required for planning, chain-of-thought, and safety).
  // Reject this output and ask for a retry with thinking included.
  // Do NOT consume the retry budget — this is a format violation, not a reasoning
  // failure. The agent knows how to think; it just forgot this time.
  if (!thinkText && toolCallsCount > 0) {
    return {
      shouldRetry: true,
      updatedMessages: [
        { role: "assistant", content: assistantContent },
        { role: "user", content: NO_THINKING_MESSAGE },
      ],
      updatedThinkRetryCount: thinkRetryCount,
    };
  }

  // PATH 3: Thinking present + valid tool call(s) → proceed.
  // This is the happy path. The agent has done everything correctly.
  return {
    shouldRetry: false,
    updatedMessages: [],
    updatedThinkRetryCount: thinkRetryCount,
  };
};
