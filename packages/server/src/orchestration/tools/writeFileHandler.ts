/**
 * <Summary>
 * What it does:
 *   Handler for write_file tool execution.
 *
 * How it does it (step by step):
 *   1. Emit writing status.
 *   2. Write file content to workspace.
 *   3. Track file as written if accepted.
 *   4. Return observation with diff or decline message.
 *
 * Parameters:
 *   @param tool - Tool call with path and content to write.
 *   @param ctx - Execution context.
 *
 * Returns:
 *   @returns Result with write observation.
 * </Summary>
 */

import type { AgentToolCall } from "../toolProtocol.js";
import type {
  IToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./toolHandler.js";
import type { WorkspaceManager } from "../../workspace/manager/workspaceManager.js";
import { ValidationError } from "../../errors/index.js";

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

export class WriteFileHandler implements IToolHandler {
  /**
   * <Summary>
   * What it does:
   *   Executes the write_file tool.
   *
   * How it does it (step by step):
   *   1. Validate tool type is write_file.
   *   2. Create recorder context for logging.
   *   3. Get trackers from context.
   *   4. Emit writing status to client.
   *   5. Write file content to workspace with confirmation.
   *   6. Track file as written if accepted.
   *   7. Return observation with diff or decline message.
   *   8. Handle errors and return error observation.
   *
   * Parameters:
   *   @param tool - Tool call with path and content to write.
   *   @param ctx - Execution context with dependencies.
   *
   * Returns:
   *   Result with write observation.
   * </Summary>
   */
  async execute(
    tool: AgentToolCall,
    ctx: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    // Step 1: Validate tool type is write_file
    if (tool.tool !== "write_file") {
      throw new ValidationError(
        `WriteFileHandler received wrong tool type: ${tool.tool}`,
      );
    }

    // Step 2: Create recorder context for logging
    const recorderContext = { recorder: ctx.recorder, taskId: ctx.taskId };
    // Step 3: Get trackers from context
    const trackers = ctx.trackers;

    try {
      // Step 4: Emit writing status to client
      ctx.emitAgentStatus("writing", "◌", `Writing ${tool.path}...`);
      // Step 5: Write file content to workspace with confirmation
      const diff = await ctx.workspace.writeFile(
        tool.path,
        tool.content,
        recorderContext,
      );
      const writeAccepted = diff !== undefined;
      // Step 6: Track file as written if accepted
      if (writeAccepted) {
        trackers.filesWrittenThisTask.add(tool.path);
      }
      // Step 7: Return observation with diff or decline message
      const resultBody = writeAccepted
        ? `accepted. Diff:\n${diff ?? ""}`
        : "user declined";
      return {
        done: false,
        summary: "",
        feedback: formatObservation(tool, resultBody),
        escalationCount: ctx.escalationCount,
      };
    } catch (error) {
      // Step 8: Handle errors and return error observation
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        done: false,
        summary: "",
        feedback: formatObservation(tool, errorMessage),
        escalationCount: ctx.escalationCount,
      };
    }
  }
}
