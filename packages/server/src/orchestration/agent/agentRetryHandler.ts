/**
 * <Summary>
 * What it does:
 *   Handles agent retry logic for various error conditions during execution.
 *
 * How it fits in the system:
 *   The AI model may make mistakes like outputting markdown instead of tool calls,
 *   thinking without acting, or acting without thinking. This module detects these
 *   patterns and provides corrective feedback to guide the agent back on track.
 *   It also manages escalation when the agent is stuck and can't proceed.
 *
 * Dependencies:
 *   - toolProtocol.js — looksLikeMarkdownOrCodeDump, MARKDOWN_CORRECTION_MESSAGE, MAX_MARKDOWN_RETRIES.
 *   - types.ts — AgentToolCall, Message types.
 *
 * Dependants:
 *   - Agent.run — uses this to handle retry logic after each model response.
 * </Summary>
 */

import type { AgentToolCall } from "../toolProtocol.js";
import type { Message } from "../types.js";
import {
  looksLikeMarkdownOrCodeDump,
  MARKDOWN_CORRECTION_MESSAGE,
  MAX_MARKDOWN_RETRIES,
} from "../toolProtocol.js";

/**
 * <Summary>
 * What it does:
 *   Result type for retry handling operations.
 *
 * How it fits in the system:
 *   Returned by handleAgentRetry to indicate whether a retry is needed,
 * what messages should be added to the conversation, and updated retry counts.
 *   Can also indicate that an escalation should occur.
 *
 * Fields:
 *   shouldRetry — Whether the agent should retry with updated messages.
 *   updatedMessages — Messages to add to the conversation (assistant + user).
 *   updatedMarkdownRetryCount — Updated count of markdown correction retries.
 *   updatedThinkRetryCount — Updated count of "think without act" retries.
 *   shouldEscalate — Whether to escalate to advisor (optional).
 *   escalationReason — Reason for escalation when shouldEscalate is true (optional).
 *
 * Dependants:
 *   - Agent.run — uses result to decide whether to retry or continue.
 * </Summary>
 */
export type RetryResult = {
  /** Whether the agent should retry with updated messages. */
  shouldRetry: boolean;

  /** Messages to add to the conversation (assistant + user). */
  updatedMessages: Message[];

  /** Updated count of markdown correction retries. */
  updatedMarkdownRetryCount: number;

  /** Updated count of "think without act" retries. */
  updatedThinkRetryCount: number;

  /** Whether to escalate to advisor (optional). */
  shouldEscalate?: boolean;

  /** Reason for escalation when shouldEscalate is true (optional). */
  escalationReason?: string;
};

/**
 * <Summary>
 * What it does:
 *   Handles agent retry logic for various error conditions.
 *
 * How it does it (step by step):
 *   1. Check if agent output text without think block and no tool calls.
 *   2. If so, check if it's a markdown/code dump with retries available.
 *   3. If markdown dump, add correction message and increment markdown retry count.
 *   4. If not markdown dump, add generic "use tool calls" message.
 *   5. Check if agent thought but didn't call any tools.
 *   6. If so and retries exhausted, escalate to advisor.
 *   7. If so and retries available, prompt for tool call.
 *   8. Check if agent called tools without thinking.
 *   9. If so, prompt for thinking before action.
 *   10. If no issues found, return shouldRetry: false.
 *
 * Parameters:
 *   @param {string} assistantText — Agent's full response text including think block.
 *   @param {string | null} thinkText — Extracted think block text (null if not found).
 *   @param {number} toolCallsCount — Number of tool calls parsed from response.
 *   @param {number} markdownRetryCount — Current markdown correction retry count.
 *   @param {number} thinkRetryCount — Current "think without act" retry count.
 *   @param {number} maxEscalations — Maximum escalation attempts before failure.
 *
 * Returns:
 *   {RetryResult} — Result indicating if retry needed and updated counts/state.
 *
 * Dependencies:
 *   - looksLikeMarkdownOrCodeDump — detects markdown/code dump patterns.
 *   - MARKDOWN_CORRECTION_MESSAGE — correction prompt for markdown issues.
 *   - MAX_MARKDOWN_RETRIES — maximum markdown correction attempts.
 *
 * Dependants:
 *   - Agent.run — uses this to handle retry logic after each model response.
 * </Summary>
 */
export const handleAgentRetry = (
  assistantText: string,
  thinkText: string | null,
  toolCallsCount: number,
  markdownRetryCount: number,
  thinkRetryCount: number,
  maxEscalations: number,
): RetryResult => {
  // Step 1-2: Check if agent output text without think block and no tool calls
  if (!thinkText && toolCallsCount === 0) {
    // Step 2: Check if it's a markdown/code dump with retries available
    if (
      looksLikeMarkdownOrCodeDump(assistantText) &&
      markdownRetryCount < MAX_MARKDOWN_RETRIES
    ) {
      // Step 3: Add correction message and increment markdown retry count
      return {
        shouldRetry: true,
        updatedMessages: [
          { role: "assistant", content: assistantText },
          { role: "user", content: MARKDOWN_CORRECTION_MESSAGE },
        ],
        updatedMarkdownRetryCount: markdownRetryCount + 1,
        updatedThinkRetryCount: thinkRetryCount,
      };
    }

    // Step 4: If not markdown dump, add generic "use tool calls" message
    return {
      shouldRetry: true,
      updatedMessages: [
        { role: "assistant", content: assistantText },
        {
          role: "user",
          content:
            "You printed text instead of using tool calls. Write a ``` block then call a tool.",
        },
      ],
      updatedMarkdownRetryCount: markdownRetryCount,
      updatedThinkRetryCount: thinkRetryCount,
    };
  }

  // Step 5: Check if agent thought but didn't call any tools
  if (thinkText && toolCallsCount === 0) {
    // Step 6: If retries exhausted, escalate to advisor
    if (thinkRetryCount >= maxEscalations) {
      return {
        shouldRetry: true,
        updatedMessages: [],
        updatedMarkdownRetryCount: markdownRetryCount,
        updatedThinkRetryCount: thinkRetryCount + 1,
        shouldEscalate: true,
        escalationReason: "Thought but did not call a tool after retries",
      };
    }

    // Step 7: If retries available, prompt for tool call
    return {
      shouldRetry: true,
      updatedMessages: [
        { role: "assistant", content: assistantText },
        {
          role: "user",
          content:
            "You thought but did not call a tool. Call the tool you described in your action field, or call escalate if you are stuck.",
        },
      ],
      updatedMarkdownRetryCount: markdownRetryCount,
      updatedThinkRetryCount: thinkRetryCount + 1,
    };
  }

  // Step 8: Check if agent called tools without thinking
  if (!thinkText && toolCallsCount > 0) {
    // Step 9: Prompt for thinking before action
    return {
      shouldRetry: true,
      updatedMessages: [
        { role: "assistant", content: assistantText },
        {
          role: "user",
          content:
            "You called a tool without a ``` block. Always think before acting.",
        },
      ],
      updatedMarkdownRetryCount: markdownRetryCount,
      updatedThinkRetryCount: thinkRetryCount,
    };
  }

  // Step 10: If no issues found, return shouldRetry: false
  return {
    shouldRetry: false,
    updatedMessages: [],
    updatedMarkdownRetryCount: markdownRetryCount,
    updatedThinkRetryCount: thinkRetryCount,
  };
};
