/**
 * <Summary>
 * What it does:
 *   Handler for read_file tool execution.
 *
 * How it does it (step by step):
 *   1. Emit reading status.
 *   2. Read file content from workspace.
 *   3. Track file as read.
 *   4. Mark file as verified if it was previously written.
 *   5. Return observation with file content.
 *
 * Parameters:
 *   @param tool - Tool call with path to read.
 *   @param ctx - Execution context.
 *
 * Returns:
 *   @returns Result with file content observation.
 * </Summary>
 */

import type { AgentToolCall } from "../toolProtocol.js";
import type {
  IToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./toolHandler.js";
import type { WorkspaceManager } from "../../workspace/manager/workspaceManager.js";
import type { IExperienceRecorder } from "../interfaces.js";
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

/**
 * <Summary>
 * What it does:
 *   Handler for read_file tool execution.
 *
 * How it does it (step by step):
 *   1. Validate tool type is read_file.
 *   2. Create recorder context for logging.
 *   3. Get trackers from context.
 *   4. Emit reading status to client.
 *   5. Read file content from workspace.
 *   6. Track file as read.
 *   7. Mark file as verified if it was previously written.
 *   8. Return observation with file content.
 *   9. Handle errors and return error observation.
 *
 * Parameters:
 *   @param tool - Tool call with path to read.
 *   @param ctx - Execution context with dependencies.
 *
 * Returns:
 *   Result with file content observation.
 * </Summary>
 */
export class ReadFileHandler implements IToolHandler {
  /**
   * <Summary>
   * What it does:
   *   Executes the read_file tool.
   *
   * How it does it (step by step):
   *   1. Validate tool type is read_file.
   *   2. Create recorder context for logging.
   *   3. Get trackers from context.
   *   4. Emit reading status to client.
   *   5. Read file content from workspace.
   *   6. Track file as read.
   *   7. Mark file as verified if it was previously written.
   *   8. Return observation with file content.
   *   9. Handle errors and return error observation.
   *
   * Parameters:
   *   @param tool - Tool call with path to read.
   *   @param ctx - Execution context with dependencies.
   *
   * Returns:
   *   Result with file content observation.
   * </Summary>
   */
  async execute(
    tool: AgentToolCall,
    ctx: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    // Step 1: Validate tool type is read_file
    if (tool.tool !== "read_file") {
      throw new ValidationError(
        `ReadFileHandler received wrong tool type: ${tool.tool}`,
      );
    }

    // Step 2: Create recorder context for logging
    const recorderContext = { recorder: ctx.recorder, taskId: ctx.taskId };
    // Step 3: Get trackers from context
    const trackers = ctx.trackers;

    try {
      // Step 4: Emit reading status to client
      ctx.emitAgentStatus("reading", "◌", `Reading ${tool.path}...`);
      // Step 5: Read file content from workspace
      const fileContent = await ctx.workspace.readFile(
        tool.path,
        recorderContext,
      );
      // Step 6: Track file as read
      trackers.filesReadThisTask.add(tool.path);
      // Step 7: Mark file as verified if it was previously written
      if (trackers.filesWrittenThisTask.has(tool.path)) {
        trackers.filesVerifiedThisTask.add(tool.path);
      }
      // Step 8: Return observation with file content
      return {
        done: false,
        summary: "",
        feedback: formatObservation(tool, fileContent),
        escalationCount: ctx.escalationCount,
      };
    } catch (error) {
      // Step 9: Handle errors and return error observation
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
