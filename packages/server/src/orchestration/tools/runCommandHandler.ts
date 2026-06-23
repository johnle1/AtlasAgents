/**
 * <Summary>
 * What it does:
 *   Handler for run_command tool execution.
 *
 * How it does it (step by step):
 *   1. Infer command purpose if not provided.
 *   2. Check if run-project command (must be background).
 *   3. Emit running status.
 *   4. Run command with confirmation.
 *   5. Track verify command success.
 *   6. Return observation with command output.
 *
 * Parameters:
 *   @param tool - Tool call with command to run.
 *   @param ctx - Execution context.
 *
 * Returns:
 *   @returns Result with command output observation.
 * </Summary>
 */

import type { AgentToolCall, CommandPurpose } from "../toolProtocol.js";
import type {
  IToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./toolHandler.js";
import type { TerminalExecutor } from "../../workspace/execution/terminalExecutor.js";
import {
  inferPurpose,
  RUN_PROJECT_BLOCK_MESSAGE,
} from "../commandClassifier.js";
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

export class RunCommandHandler implements IToolHandler {
  /**
   * <Summary>
   * What it does:
   *   Executes the run_command tool.
   *
   * How it does it (step by step):
   *   1. Validate tool type is run_command.
   *   2. Infer command purpose if not provided.
   *   3. Check if run-project command (must be background).
   *   4. If run-project without background, return error.
   *   5. Create recorder context for logging.
   *   6. Get trackers from context.
   *   7. Emit running status to client.
   *   8. Run command with confirmation.
   *   9. Track verify command success if applicable.
   *   10. Determine status (skipped, no output, or exit code).
   *   11. Return observation with command output.
   *   12. Handle errors and return error observation.
   *
   * Parameters:
   *   @param tool - Tool call with command to run.
   *   @param ctx - Execution context with dependencies.
   *
   * Returns:
   *   Result with command output observation.
   * </Summary>
   */
  async execute(
    tool: AgentToolCall,
    ctx: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    // Step 1: Validate tool type is run_command
    if (tool.tool !== "run_command") {
      throw new ValidationError(
        `RunCommandHandler received wrong tool type: ${tool.tool}`,
      );
    }

    // Step 2: Infer command purpose if not provided
    const commandPurpose: CommandPurpose =
      tool.purpose ?? inferPurpose(tool.command, ctx.commandPlan);

    // Step 3-4: Check if run-project command (must be background)
    if (commandPurpose === "run-project" && tool.background !== true) {
      return {
        done: false,
        summary: "",
        feedback: formatObservation(
          tool,
          RUN_PROJECT_BLOCK_MESSAGE(tool.command),
        ),
        escalationCount: ctx.escalationCount,
      };
    }

    // Step 5: Create recorder context for logging
    const recorderContext = { recorder: ctx.recorder, taskId: ctx.taskId };
    // Step 6: Get trackers from context
    const trackers = ctx.trackers;

    try {
      // Step 7: Emit running status to client
      ctx.emitAgentStatus(
        "running",
        "◌",
        `Running: ${tool.command.slice(0, 38)}${tool.command.length > 38 ? "..." : ""}`,
      );
      // Step 8: Run command with confirmation
      const commandResult = await ctx.terminal.runWithConfirmation(
        tool.command,
        recorderContext,
        {
          background: tool.background === true,
        },
      );
      // Step 9: Track verify command success if applicable
      if (commandPurpose === "verify" && commandResult.exitCode === 0) {
        const startedInBackground =
          commandResult.stdout.includes("Started in background") ||
          commandResult.stdout.includes("PID");
        if (!startedInBackground) {
          trackers.verifyCommandPassed = true;
        }
      }
      // Step 10: Determine status (skipped, no output, or exit code)
      const wasSkipped =
        commandResult.exitCode === -1 &&
        commandResult.stderr.toLowerCase().includes("skipped");
      const hasNoOutput =
        !wasSkipped &&
        commandResult.exitCode === 0 &&
        !commandResult.stdout.trim() &&
        !commandResult.stderr.trim();
      const statusMessage = wasSkipped
        ? "user skipped — command was NOT executed"
        : hasNoOutput
          ? "completed successfully (exit 0, no captured output)"
          : `exit ${commandResult.exitCode}`;
      // Step 11: Return observation with command output
      const resultBody = `${statusMessage}\nstdout:\n${commandResult.stdout}\nstderr:\n${commandResult.stderr}`;
      return {
        done: false,
        summary: "",
        feedback: formatObservation(tool, resultBody),
        escalationCount: ctx.escalationCount,
      };
    } catch (error) {
      // Step 12: Handle errors and return error observation
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
