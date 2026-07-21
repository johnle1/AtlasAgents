/**
 * Shell command classify / run handlers for the local file proxy.
 *
 * @remarks
 * `command.classify` is a cheap metadata probe. `command.run` performs
 * approval (when needed), optional detached background spawn, foreground
 * execution via {@link DispatchContext.runShell}, and CWD persistence using
 * {@link wrapCommandForCwdTracking}.
 */

import { spawn } from "node:child_process";
import { beginBlockOutput } from "../../agentStatus.js";
import { getTheme } from "../../theme/themeManager.js";
import {
  extractCwdFromOutput,
  isWindowsShell,
  trackedCwdsEqual,
  wrapCommandForCwdTracking,
} from "../cwdTracking.js";
import {
  printBash,
  printBashApproved,
  printBashRan,
  printBashResult,
  type BashClass,
} from "../../renderer.js";
import {
  printDeclineFeedback,
  requestApprovalWithFeedback,
} from "../../ui/approvalFlow.js";
import type { DispatchContext, ShellResult } from "../types.js";
import { logger } from "../../utils/logger.js";

/** {@link ShellResult} plus the optional revise reason a decline can carry. */
type CommandRunResult = ShellResult & { feedback?: string };

/**
 * Classifies a command without executing it.
 *
 * @param context - Provides `classifyCommand`.
 * @param requestBody - Expects `{ command?: string }`.
 * @returns Promise of `{ classification }` (`safe` | `dangerous` | `cautious`).
 *
 * @example
 * ```ts
 * await handleCommandClassify(context, { command: "git status" });
 * → { classification: "safe" }
 * ```
 */
export const handleCommandClassify = (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> =>
  Promise.resolve({
    classification: context.classifyCommand(String(requestBody.command ?? "")),
  });

/** Shared run/skip approval prompt used by both the background and foreground gates. */
const confirmRunOrSkip = (
  command: string,
): Promise<{ approved: boolean; feedback?: string }> =>
  requestApprovalWithFeedback(
    { type: "runSkip", command },
    "What should change about this command?",
  );

/** Result shape for a command the user declined to run (skip or revise). */
const declinedCommandResult = (feedback?: string): CommandRunResult => ({
  stdout: "",
  stderr: "skipped by user — command was not executed",
  exitCode: -1,
  feedback,
});

/**
 * Approves and detaches a `background: true` command, or reports the decline/spawn failure.
 *
 * @remarks
 * Detached + `stdio: "ignore"` + `unref()`: the process outlives this request
 * and its output is not proxied back to the agent.
 *
 * @param context - Provides `currentDir` for the spawned process's cwd.
 * @param command - Raw command line to run.
 */
const runBackgroundCommand = async (
  context: DispatchContext,
  command: string,
): Promise<CommandRunResult> => {
  const { approved, feedback } = await confirmRunOrSkip(command);
  if (!approved) {
    printDeclineFeedback(feedback);
    return declinedCommandResult(feedback);
  }

  printBashApproved();

  const commandParts = command.trim().split(/\s+/);
  if (commandParts.length === 0 || !commandParts[0]) {
    return { stdout: "", stderr: "empty command", exitCode: 1 };
  }

  let spawnedProcess;
  try {
    spawnedProcess = spawn(commandParts[0], commandParts.slice(1), {
      detached: true,
      stdio: "ignore",
      cwd: context.currentDir,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: `Failed to spawn command: ${errorMessage}`,
      exitCode: 1,
    };
  }

  spawnedProcess.unref();

  const statusMessage = `Started in background (PID ${spawnedProcess.pid}). Check your terminal for output.`;
  printBashRan(0, statusMessage, "");
  return { stdout: statusMessage, stderr: "", exitCode: 0 };
};

/**
 * Gates a non-`"safe"` foreground command behind run/skip approval.
 *
 * @remarks
 * `"dangerous"` commands also print a warning banner before prompting.
 *
 * @returns The decline result when the user skips/revises, or `null` to proceed.
 */
const confirmForegroundCommand = async (
  command: string,
  commandClassification: BashClass,
): Promise<CommandRunResult | null> => {
  if (commandClassification === "dangerous") {
    beginBlockOutput();
    logger.blank();
    {
      const theme = getTheme();
      logger.info(`  ${theme.warning}⚠${theme.reset}  Dangerous command.`);
    }
    logger.blank();
  }

  const { approved, feedback } = await confirmRunOrSkip(command);
  if (!approved) {
    printDeclineFeedback(feedback);
    return declinedCommandResult(feedback);
  }

  printBashApproved();
  return null;
};

/**
 * Runs an approved command in the foreground, tracking CWD changes and printing output.
 *
 * @remarks
 * Wraps the command so `cd`/`pushd` inside it can report a new CWD, strips
 * that tracking marker from stdout, and moves `context.currentDir` when the
 * new path stays inside the workspace (escapes like `cd /` are ignored).
 */
const executeForegroundCommand = async (
  context: DispatchContext,
  command: string,
  commandClassification: BashClass,
): Promise<ShellResult> => {
  const startTime = Date.now();

  const trackedCommand = wrapCommandForCwdTracking(command, isWindowsShell());
  const executionResult = await context.runShell(trackedCommand);

  const { cleanedStdout, newCwd } = extractCwdFromOutput(
    executionResult.stdout,
  );
  const resultWithCleanStdout = { ...executionResult, stdout: cleanedStdout };

  if (newCwd && !trackedCwdsEqual(newCwd, context.currentDir)) {
    try {
      context.setCurrentDir(newCwd);
    } catch {
      // cd outside workspace (e.g. /) must not move the sandbox cursor.
    }
  }

  // Safe commands get a compact timing line; others echo full captured output.
  if (commandClassification === "safe") {
    printBashResult(resultWithCleanStdout.exitCode, Date.now() - startTime);
  } else {
    printBashRan(
      resultWithCleanStdout.exitCode,
      resultWithCleanStdout.stdout,
      resultWithCleanStdout.stderr,
    );
  }

  return resultWithCleanStdout;
};

/**
 * Runs a shell command with classification-based approval and CWD tracking.
 *
 * @remarks
 * Flow:
 * 1. If `background: true`, force `"background"` class and (on approval) detach
 *    a process with `stdio: "ignore"` — does not capture output.
 * 2. Non-`"safe"` foreground commands prompt run/skip; `"dangerous"` also
 *    prints a warning banner.
 * 3. Foreground runs wrap the command for CWD tracking, strip the marker from
 *    stdout, and call `setCurrentDir` when the new path is inside the workspace
 *    (escapes like `cd /` are ignored).
 *
 * Skipped commands return `exitCode: -1` and a stderr note — they do not throw.
 *
 * @param context - Shell + classification + cwd helpers.
 * @param requestBody - `{ command: string, background?: boolean }`.
 * @returns {@link ShellResult}-shaped object (or skip / background status).
 *
 * @example
 * ```ts
 * await handleCommandRun(context, { command: "ls" });
 * await handleCommandRun(context, { command: "npm run dev", background: true });
 * ```
 */
export const handleCommandRun = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  const command = String(requestBody.command ?? "");
  const forceBackgroundExecution = requestBody.background === true;

  // background flag wins over heuristics so long-running servers skip CWD wrap.
  const commandClassification: BashClass = forceBackgroundExecution
    ? "background"
    : context.classifyCommand(command);

  printBash(command, commandClassification);

  if (commandClassification === "background") {
    return runBackgroundCommand(context, command);
  }

  if (commandClassification !== "safe") {
    const declineResult = await confirmForegroundCommand(
      command,
      commandClassification,
    );
    if (declineResult) {
      return declineResult;
    }
  }

  return executeForegroundCommand(context, command, commandClassification);
};
