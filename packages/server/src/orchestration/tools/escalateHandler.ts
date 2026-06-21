/**
 * <Summary>
 * What it does:
 *   Handler for escalate tool execution.
 *
 * How it does it (step by step):
 *   1. Emit escalating status.
 *   2. Increment escalation count.
 *   3. Check if max escalations exceeded.
 *   4. If exceeded, return failure result.
 *   5. Otherwise, request advisor guidance.
 *   6. Log escalation to experience recorder.
 *   7. Return observation with guidance.
 *
 * Parameters:
 *   @param {AgentToolCall} tool - Tool call with escalation reason.
 *   @param {ToolHandlerContext} ctx - Execution context.
 *
 * Returns:
 *   @returns {ToolExecutionResult} - Result with guidance observation or failure.
 *
 * Dependencies:
 *   - Advisor - for providing guidance on escalation.
 *   - IExperienceRecorder - for logging escalations.
 *
 * Dependants:
 *   - Agent.executeTool - uses this handler for escalate tools.
 * </Summary>
 */

import type { AgentToolCall } from "../toolProtocol.js";
import type {
  IToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./toolHandler.js";
import { ValidationError } from "../../errors/index.js";
import type { Advisor } from "../advisor/advisor.js";

const formatObservation = (tool: AgentToolCall, content: string): string => {
  return `[${tool.tool}] ${JSON.stringify(tool)}\n${content}`;
};

export class EscalateHandler implements IToolHandler {
  constructor(private readonly advisor: Advisor) {}

  async execute(
    tool: AgentToolCall,
    ctx: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    if (tool.tool !== "escalate") {
      throw new ValidationError(
        `EscalateHandler received wrong tool type: ${tool.tool}`,
      );
    }

    ctx.emitAgentStatus("escalating", "⚠", "Escalating to advisor...");
    const nextCount = ctx.escalationCount + 1;
    ctx.escalationCount = nextCount;

    if (nextCount > ctx.maxEscalations) {
      return {
        done: true,
        summary: `[agent failed after ${ctx.maxEscalations} escalations: ${tool.reason}]`,
        feedback: "",
        escalationCount: nextCount,
      };
    }

    const guidance = await this.advisor.advise(
      ctx.subtask,
      tool.reason,
      ctx.messages,
      ctx.modelOverrides,
    );
    ctx.recorder.logEscalation(ctx.taskId, tool.reason, guidance);

    return {
      done: false,
      summary: "",
      feedback: formatObservation(tool, guidance),
      escalationCount: nextCount,
    };
  }
}
