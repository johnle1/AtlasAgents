/**
 * The `escalate` tool: lets a stuck subagent ask the lead agent for guidance.
 *
 * @remarks
 * Escalation is also triggered automatically by the retry handler when a
 * subagent exhausts its format-retry budget (see `subagentRetryHandler.ts`),
 * not just by the model explicitly calling this tool. Either way, this is
 * where the actual escalation happens: it asks the lead {@link Agent} for
 * advice, records the exchange, and enforces the escalation budget —
 * exceeding `maxEscalations` ends the subtask as failed rather than looping
 * forever.
 */

import type { Agent } from "../agent/agent.js";
import type {
  ToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./types.js";
import { formatObservation } from "./toolHandler.js";

/**
 * Builds the `escalate` tool handler, bound to a specific lead agent.
 *
 * @remarks
 * A factory rather than a plain constant (unlike the file-based tools)
 * because it needs to close over `agent` to call `agent.advise(...)` — the
 * lead agent that provides guidance is only known once a subagent run
 * starts, not at module load time.
 *
 * @param agent - The lead agent to consult for guidance when a subagent is stuck.
 * @returns A `ToolHandler` for the `escalate` tool.
 *
 * @example
 * ```ts
 * const escalateTool = createEscalateTool(leadAgent);
 * Agent calls escalate({ reason: "tests keep failing on the same assertion" })
 * → leadAgent.advise(...) returns guidance, fed back as tool feedback.
 * ```
 */
export const createEscalateTool = (agent: Agent): ToolHandler => ({
  schema: {
    type: "function",
    function: {
      name: "escalate",
      description:
        "Ask the agent for help when blocked. Provide a clear reason.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why you are stuck and need guidance",
          },
        },
        required: ["reason"],
      },
    },
  },

  async execute(
    escalateArgs: Record<string, unknown>,
    handlerContext: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    const reason = String(escalateArgs.reason ?? "");

    const nextCount = handlerContext.escalationCount + 1;

    // Budget exhausted: this escalation would exceed maxEscalations, so the
    // subtask is reported as failed rather than escalating again. Prevents
    // an unrecoverable subtask from looping through infinite escalations.
    if (nextCount > handlerContext.maxEscalations) {
      return {
        done: true,
        summary: `[agent failed after ${handlerContext.maxEscalations} escalations: ${reason}]`,
        feedback: "",
        escalationCount: nextCount,
        ok: false,
      };
    }

    // Ask the lead agent for guidance, passing the full conversation history
    // so it has context on what's already been tried.
    const guidance = await agent.advise(
      handlerContext.subtask,
      reason,
      handlerContext.messages,
      handlerContext.modelOverrides,
    );
    handlerContext.recorder.logEscalation(handlerContext.taskId, reason, guidance);

    return {
      done: false,
      summary: "",
      feedback: formatObservation("escalate", escalateArgs, guidance),
      escalationCount: nextCount,
    };
  },
});
