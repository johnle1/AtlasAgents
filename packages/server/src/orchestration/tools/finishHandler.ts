/**
 * <Summary>
 * What it does:
 *   Handler for finish tool execution.
 *
 * How it does it (step by step):
 *   1. Check if files were written during task.
 *   2. If files written, verify at least one was verified.
 *   3. If no verification, return error requiring verification.
 *   4. Otherwise, emit done status.
 *   5. Return success result with summary.
 *
 * Parameters:
 *   @param tool - Tool call with task summary.
 *   @param ctx - Execution context.
 *
 * Returns:
 *   @returns Result indicating task completion or verification required.
 * </Summary>
 */

import type { AgentToolCall } from "../toolProtocol.js";
import type {
  IToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./toolHandler.js";
import { ValidationError } from "../../errors/index.js";
import { VERIFY_REQUIRED_MESSAGE } from "../commandClassifier.js";

/**
 * <Summary>
 * What it does:
 *   Formats a tool observation string for agent feedback.
 *
 * How it does it (step by step):
 *   1. Combine tool name and JSON representation.
 *   2. Append content with newline separator.
 *
 * Parameters:
 *   @param tool - The tool call that was executed.
 *   @param content - The result or error message content.
 *
 * Returns:
 *   Formatted observation string.
 * </Summary>
 */
const formatObservation = (tool: AgentToolCall, content: string): string => {
  // Step 1-2: Combine tool name, JSON, and content
  return `[${tool.tool}] ${JSON.stringify(tool)}\n${content}`;
};

export class FinishHandler implements IToolHandler {
  /**
   * <Summary>
   * What it does:
   *   Executes the finish tool.
   *
   * How it does it (step by step):
   *   1. Validate tool type is finish.
   *   2. Get trackers from context.
   *   3. Check if files were written during task.
   *   4. If files written, check for verification (file or command).
   *   5. If no verification, return error requiring verification.
   *   6. Emit done status to client.
   *   7. Return success result with summary.
   *
   * Parameters:
   *   @param tool - Tool call with task summary.
   *   @param ctx - Execution context with dependencies.
   *
   * Returns:
   *   Result indicating task completion or verification required.
   * </Summary>
   */
  async execute(
    tool: AgentToolCall,
    ctx: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    // Step 1: Validate tool type is finish
    if (tool.tool !== "finish") {
      throw new ValidationError(
        `FinishHandler received wrong tool type: ${tool.tool}`,
      );
    }

    // Step 2: Get trackers from context
    const trackers = ctx.trackers;

    // Step 3-5: Check if files were written and verify verification
    if (trackers.filesWrittenThisTask.size > 0) {
      const hasFileVerification = trackers.filesVerifiedThisTask.size > 0;
      const hasCommandVerification = trackers.verifyCommandPassed;
      if (!hasFileVerification && !hasCommandVerification) {
        return {
          done: false,
          summary: "",
          feedback: formatObservation(
            tool,
            VERIFY_REQUIRED_MESSAGE(trackers.filesWrittenThisTask),
          ),
          escalationCount: ctx.escalationCount,
        };
      }
    }

    // Step 6: Emit done status to client
    ctx.emitAgentStatus("done", "✓", "Done");
    // Step 7: Return success result with summary
    return {
      done: true,
      summary: tool.summary,
      feedback: "",
      escalationCount: ctx.escalationCount,
    };
  }
}
