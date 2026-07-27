/**
 * The `finish` tool: the only way a subagent successfully completes a subtask.
 *
 * @remarks
 * Gates completion behind two checks so the agent can't declare victory
 * prematurely:
 * 1. If nothing was written, all planned setup commands must have run.
 * 2. If files were written, at least one of them must be verified — either
 *    read back after writing, or confirmed by a passing `purpose: "verify"`
 *    command.
 *
 * Either check failing returns corrective feedback instead of completing,
 * pushing the agent to close the gap rather than silently finishing with
 * unverified work.
 */

import type {
  ToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./types.js";
import { formatObservation } from "./toolHandler.js";
import { VERIFY_REQUIRED_MESSAGE, normalizeCommand } from "../commandClassifier.js";

/**
 * Tool handler for `finish`.
 *
 * @example
 * Agent calls `finish({ summary: "Added OAuth flow", keyFindings: ["uses PKCE"] })`
 * — completes only if setup commands ran (when nothing was written) or the
 * written files were verified (when something was written).
 */
export const finishTool: ToolHandler = {
  schema: {
    type: "function",
    function: {
      name: "finish",
      description:
        "Complete the subtask. Requires prior verification of any written files.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "What you accomplished",
          },
          keyFindings: {
            type: "array",
            items: { type: "string" },
            description:
              "Short bullet points a dependent subtask needs to know",
          },
        },
        required: ["summary"],
      },
    },
  },

  async execute(
    finishArgs: Record<string, unknown>,
    handlerContext: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    const summary = String(finishArgs.summary ?? "");
    const keyFindings = Array.isArray(finishArgs.keyFindings)
      ? finishArgs.keyFindings
          .map((finding) => String(finding).trim())
          .filter((finding) => finding.length > 0)
      : [];
    const trackers = handlerContext.trackers;

    // CHECK 1: If the subtask wrote nothing (e.g. a pure investigation or
    // setup task), it must still have run every planned setup command —
    // otherwise the agent may be finishing without having done the work
    // the command plan called for.
    if (trackers.filesWrittenThisTask.size === 0) {
      const missingSetup = handlerContext.commandPlan.setupCommands.filter(
        (command) =>
          !trackers.completedSetupCommands.has(normalizeCommand(command)),
      );
      if (missingSetup.length > 0) {
        return {
          done: false,
          summary: "",
          feedback: formatObservation(
            "finish",
            finishArgs,
            [
              "Run the setup commands from COMMAND PLAN before calling finish:",
              ...missingSetup.map((command) => `  ${command}`),
            ].join("\n"),
          ),
          escalationCount: handlerContext.escalationCount,
        };
      }
    }

    // CHECK 2: If files were written, at least one verification signal is
    // required — either a written file was read back (file verification) or
    // a `purpose: "verify"` command passed (command verification). Prevents
    // the agent from finishing with unverified changes.
    if (trackers.filesWrittenThisTask.size > 0) {
      const hasFileVerification = trackers.filesVerifiedThisTask.size > 0;
      const hasCommandVerification = trackers.verifyCommandPassed;
      if (!hasFileVerification && !hasCommandVerification) {
        return {
          done: false,
          summary: "",
          feedback: formatObservation(
            "finish",
            finishArgs,
            VERIFY_REQUIRED_MESSAGE(trackers.filesWrittenThisTask),
          ),
          escalationCount: handlerContext.escalationCount,
        };
      }
    }

    handlerContext.emitSubagentStatus("done", "✓", "Done");
    return {
      done: true,
      summary,
      keyFindings,
      feedback: "",
      escalationCount: handlerContext.escalationCount,
      ok: true,
    };
  },
};
