/**
 * The `finish` tool: the only way an agent (top-level turn, or one
 * concurrent step dispatched by `run_steps_parallel`) completes its work.
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
 * unverified work. Both checks are skipped when the caller passes
 * `ok: false` — a step reporting it could NOT be done has nothing to
 * verify, and gating that report behind a verification check would just
 * trap it in the loop. This is the only way a concurrent step can report
 * failure, since it has no `escalate` tool (see `createWorkerToolRegistry`).
 */

import type {
  ToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
} from "./types.js";
import { formatObservation } from "./toolHandler.js";
import { normalizeCommand } from "../commandClassifier.js";
import { unverifiedWriteGap } from "../agent/completionGate.js";

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
        "Complete the work. Requires prior verification of any written files. Pass ok: false instead if it could not be completed.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "What you accomplished (or, if ok: false, why it could not be done). Markdown welcome: **bold** key results, `backticks` for file paths and commands, fenced blocks for code.",
          },
          keyFindings: {
            type: "array",
            items: { type: "string" },
            description:
              "Short bullet points a dependent subtask needs to know",
          },
          ok: {
            type: "boolean",
            description:
              "Defaults to true. Set to false to report that this could not be completed — skips the verification checks below.",
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
    const ok = finishArgs.ok !== false;
    const trackers = handlerContext.trackers;

    if (!ok) {
      handlerContext.emitSubagentStatus("done", "⚠", "Done");
      return {
        done: true,
        summary,
        keyFindings,
        feedback: "",
        escalationCount: handlerContext.escalationCount,
        ok: false,
      };
    }

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
    // the agent from finishing with unverified changes. Shared with the
    // loop's implicit no-tool-call exit — see completionGate.ts.
    const writeGap = unverifiedWriteGap(trackers);
    if (writeGap) {
      return {
        done: false,
        summary: "",
        feedback: formatObservation("finish", finishArgs, writeGap),
        escalationCount: handlerContext.escalationCount,
      };
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
