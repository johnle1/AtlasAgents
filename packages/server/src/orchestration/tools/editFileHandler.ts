/**
 * <Summary>
 * What it does:
 *   Handler for edit_file tool execution.
 *
 * How it does it (step by step):
 *   1. Check if file was read before editing (required).
 *   2. Emit writing status.
 *   3. Edit file content in workspace.
 *   4. Track file as written if accepted.
 *   5. Return observation with diff or decline message.
 *
 * Parameters:
 *   @param tool - Tool call with path, old, and new content.
 *   @param ctx - Execution context.
 *
 * Returns:
 *   @returns Result with edit observation.
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

export class EditFileHandler implements IToolHandler {
  /**
   * <Summary>
   * What it does:
   *   Executes the edit_file tool.
   *
   * How it does it (step by step):
   *   1. Validate tool type is edit_file.
   *   2. Check if file was read before editing (required).
   *   3. If not read, return error requiring read first.
   *   4. Create recorder context for logging.
   *   5. Emit writing status to client.
   *   6. Edit file in workspace with confirmation.
   *   7. Track file as written if accepted.
   *   8. Return observation with diff or decline message.
   *   9. Handle errors and return error observation.
   *
   * Parameters:
   *   @param tool - Tool call with path, old, and new content.
   *   @param ctx - Execution context with dependencies.
   *
   * Returns:
   *   Result with edit observation.
   * </Summary>
   */
  async execute(
    tool: AgentToolCall,
    ctx: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    // Step 1: Validate tool type is edit_file
    if (tool.tool !== "edit_file") {
      throw new ValidationError(
        `EditFileHandler received wrong tool type: ${tool.tool}`,
      );
    }

    const trackers = ctx.trackers;

    // Step 2-3: Check if file was read before editing (required)
    if (!trackers.filesReadThisTask.has(tool.path)) {
      return {
        done: false,
        summary: "",
        feedback: formatObservation(
          tool,
          `You must read_file("${tool.path}") before edit_file. Anchors must come from the file as it exists now.`,
        ),
        escalationCount: ctx.escalationCount,
      };
    }

    // Step 4: Create recorder context for logging
    const recorderContext = { recorder: ctx.recorder, taskId: ctx.taskId };

    try {
      // Step 5: Emit writing status to client
      ctx.emitAgentStatus("writing", "◌", `Writing ${tool.path}...`);
      // Step 6: Edit file in workspace with confirmation
      const diff = await ctx.workspace.editFile(
        tool.path,
        tool.old,
        tool.new,
        tool.replace_all === true,
        recorderContext,
      );
      const editAccepted = diff !== undefined;
      // Step 7: Track file as written if accepted
      if (editAccepted) {
        trackers.filesWrittenThisTask.add(tool.path);
      }
      // Step 8: Return observation with diff or decline message
      const resultBody = editAccepted
        ? `accepted. Diff:\n${diff ?? ""}`
        : "user declined";
      return {
        done: false,
        summary: "",
        feedback: formatObservation(tool, resultBody),
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
