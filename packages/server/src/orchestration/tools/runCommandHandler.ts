/**
 * The `run_command` tool: executes a shell command in the workspace.
 *
 * @remarks
 * The most complex tool handler in this module — beyond running the command,
 * it classifies the command's purpose (setup/verify/run-project), blocks
 * long-running project servers from running in the foreground, deduplicates
 * setup commands that already succeeded, tracks consecutive failures to
 * nudge the agent toward escalating instead of retrying blindly, and updates
 * `trackers.verifyCommandPassed` when a verify command succeeds (feeding
 * into the `finish` tool's verification check).
 */

import type { CommandPurpose } from "../toolProtocol.js";
import type { CommandResult } from "../../workspace/execution/terminalExecutor.js";
import type {
  ToolHandler,
  ToolHandlerContext,
  ToolExecutionResult,
  CommandExecutionSummary,
} from "./types.js";
import {
  formatObservation,
  toolExecutionErrorResult,
  userReviseMessage,
} from "./toolHandler.js";
import {
  inferPurpose,
  normalizeCommand,
  RUN_PROJECT_BLOCK_MESSAGE,
} from "../commandClassifier.js";

/** Feedback shown when a setup command is skipped because it already succeeded this task. */
const ALREADY_COMPLETED_SETUP_MESSAGE = (command: string): string =>
  [
    `Already ran this exact setup command successfully earlier in this task (exit 0):`,
    `  ${command}`,
    "",
    "Not re-running it. Move on to the next step — do not repeat setup commands.",
  ].join("\n");

/** Feedback appended when the same command has failed twice in a row, nudging the agent to escalate. */
const REPEATED_FAILURE_ESCALATION_MESSAGE = (command: string): string =>
  [
    `This exact command has failed twice in a row in this subtask:`,
    `  ${command}`,
    "",
    "Do not run it again. Try a different approach, check whether prerequisites are missing,",
    "or call escalate with a clear reason describing the failure.",
  ].join("\n");

/** Consecutive failures of the same command before adding an escalation nudge to feedback. */
const MAX_CONSECUTIVE_COMMAND_FAILURES = 2;

/**
 * Increments and returns the consecutive-failure count for a command.
 *
 * @param trackers - The run's tracker state (mutated in place).
 * @param normalizedCommand - Command string normalized via {@link normalizeCommand},
 *   so trivial whitespace/formatting differences don't count as different commands.
 * @returns The updated failure count for this command.
 */
const recordCommandFailure = (
  trackers: ToolHandlerContext["trackers"],
  normalizedCommand: string,
): number => {
  const attempts = (trackers.failedCommandAttempts.get(normalizedCommand) ?? 0) + 1;
  trackers.failedCommandAttempts.set(normalizedCommand, attempts);
  return attempts;
};

/**
 * Resets the consecutive-failure count for a command after it succeeds.
 *
 * @param trackers - The run's tracker state (mutated in place).
 * @param normalizedCommand - Command string normalized via {@link normalizeCommand}.
 */
const clearCommandFailure = (
  trackers: ToolHandlerContext["trackers"],
  normalizedCommand: string,
): void => {
  trackers.failedCommandAttempts.delete(normalizedCommand);
};

/**
 * Classifies a command result into the mutually-exclusive outcomes the agent
 * feedback message distinguishes: revised, skipped, silently succeeded, or ran.
 */
const summarizeCommandExecution = (
  commandResult: CommandResult,
): CommandExecutionSummary => {
  const wasRevised = Boolean(commandResult.feedback);
  const wasSkipped =
    !wasRevised &&
    commandResult.exitCode === -1 &&
    commandResult.stderr.toLowerCase().includes("skipped");
  const wasNotExecuted = wasRevised || wasSkipped;
  const commandFailed = !wasNotExecuted && commandResult.exitCode !== 0;
  const hasNoOutput =
    !wasNotExecuted &&
    commandResult.exitCode === 0 &&
    !commandResult.stdout.trim() &&
    !commandResult.stderr.trim();

  let statusMessage: string;
  if (wasRevised) {
    statusMessage = "user requested changes — command was NOT executed";
  } else if (wasSkipped) {
    statusMessage = "user skipped — command was NOT executed";
  } else if (hasNoOutput) {
    statusMessage = "completed successfully (exit 0, no captured output)";
  } else {
    statusMessage = `exit ${commandResult.exitCode}`;
  }

  return { wasRevised, wasSkipped, wasNotExecuted, commandFailed, statusMessage };
};

/**
 * Tool handler for `run_command`.
 *
 * @example
 * Agent calls `run_command({ command: "npm test", purpose: "verify" })` —
 * on exit 0, `trackers.verifyCommandPassed` is set, satisfying the `finish`
 * tool's verification requirement for any files written this task.
 */
export const runCommandTool: ToolHandler = {
  schema: {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command. Long-running project servers must set background: true.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          purpose: {
            type: "string",
            enum: ["setup", "verify", "run-project"],
            description: "Why the command is being run",
          },
          background: {
            type: "boolean",
            description: "Run in background (required for run-project)",
          },
        },
        required: ["command"],
      },
    },
  },

  async execute(
    runCommandArgs: Record<string, unknown>,
    handlerContext: ToolHandlerContext,
  ): Promise<ToolExecutionResult> {
    const command = String(runCommandArgs.command ?? "");
    const purposeArg = runCommandArgs.purpose;
    // Trust an explicit purpose from the model; otherwise infer one from the
    // command text and the task's command plan (e.g. "npm install" → setup).
    const commandPurpose: CommandPurpose =
      purposeArg === "setup" ||
      purposeArg === "verify" ||
      purposeArg === "run-project"
        ? purposeArg
        : inferPurpose(command, handlerContext.commandPlan);
    const background = runCommandArgs.background === true;

    // GUARD: A long-running project server (dev server, watch mode, etc.)
    // run in the foreground would block the agent loop indefinitely. Require
    // background: true for anything classified as run-project.
    if (commandPurpose === "run-project" && !background) {
      return {
        done: false,
        summary: "",
        feedback: formatObservation(
          "run_command",
          runCommandArgs,
          RUN_PROJECT_BLOCK_MESSAGE(command),
        ),
        escalationCount: handlerContext.escalationCount,
      };
    }

    const recorderContext = { recorder: handlerContext.recorder, taskId: handlerContext.taskId };
    const trackers = handlerContext.trackers;
    const normalizedCommand = normalizeCommand(command);

    // DEDUPLICATION: Skip re-running a setup command that already succeeded
    // this task (e.g. "npm install" doesn't need to run twice).
    if (
      commandPurpose === "setup" &&
      trackers.completedSetupCommands.has(normalizedCommand)
    ) {
      return {
        done: false,
        summary: "",
        feedback: formatObservation(
          "run_command",
          runCommandArgs,
          ALREADY_COMPLETED_SETUP_MESSAGE(command),
        ),
        escalationCount: handlerContext.escalationCount,
      };
    }

    try {
      const commandResult = await handlerContext.terminal.runWithConfirmation(
        command,
        recorderContext,
        { background },
      );

      // A verify command that exits 0 (and isn't secretly a background
      // process) satisfies the finish tool's verification requirement.
      if (commandPurpose === "verify" && commandResult.exitCode === 0) {
        const startedInBackground =
          commandResult.stdout.includes("Started in background") ||
          commandResult.stdout.includes("PID");
        if (!startedInBackground) {
          trackers.verifyCommandPassed = true;
        }
      }

      if (commandPurpose === "setup" && commandResult.exitCode === 0) {
        trackers.completedSetupCommands.add(normalizedCommand);
        clearCommandFailure(trackers, normalizedCommand);
      }

      const { wasRevised, wasNotExecuted, commandFailed, statusMessage } =
        summarizeCommandExecution(commandResult);

      // Track consecutive failures of the exact same command; after
      // MAX_CONSECUTIVE_COMMAND_FAILURES, nudge the agent to stop retrying
      // blindly and either change approach or escalate.
      let repeatedFailureNote = "";
      if (commandFailed) {
        const failureCount = recordCommandFailure(trackers, normalizedCommand);
        if (failureCount >= MAX_CONSECUTIVE_COMMAND_FAILURES) {
          repeatedFailureNote = `\n\n${REPEATED_FAILURE_ESCALATION_MESSAGE(command)}`;
        }
      } else if (!wasNotExecuted && commandResult.exitCode === 0) {
        clearCommandFailure(trackers, normalizedCommand);
      }

      const reviseNote = wasRevised
        ? `\n\n${userReviseMessage(
            "running this command",
            "Do not run the same command again",
            commandResult.feedback!,
          )}`
        : "";
      const resultBody = `${statusMessage}\nstdout:\n${commandResult.stdout}\nstderr:\n${commandResult.stderr}${repeatedFailureNote}${reviseNote}`;
      return {
        done: false,
        summary: "",
        feedback: formatObservation("run_command", runCommandArgs, resultBody),
        escalationCount: handlerContext.escalationCount,
      };
    } catch (error) {
      return toolExecutionErrorResult("run_command", runCommandArgs, error, handlerContext.escalationCount);
    }
  },
};
