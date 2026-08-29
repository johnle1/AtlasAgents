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
import { beginBlockOutput } from "../../state/agentStatus.js";
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
import { getApprovalMode } from "../../ui/bridge/allowlist.js";
import { getDefaultConfig, loadConfig } from "../../config/index.js";
import { scrubEnv } from "../envScrub.js";
import {
  buildSandboxPolicy,
  detectSandboxDenial,
  resolveConfiguredSandbox,
} from "../sandbox/index.js";
import type { SandboxMode } from "../sandbox/index.js";
import type { NetworkPolicy, SandboxPolicy, SandboxProvider } from "../sandbox/types.js";
import type { ApprovalMode } from "../../config/approvalMode.js";

/**
 * Network confinement for a sandboxed command, keyed off approval mode.
 *
 * @remarks
 * `auto` is the one mode with no human reviewing each command before it
 * runs, so it's the one place a network-exfiltration path (read a secret,
 * POST it somewhere) matters most — deny by default there. Every other mode
 * has a human looking at the command first, so network stays allowed;
 * denying it there would just break ordinary `npm install`/`git fetch` work
 * behind a prompt that already provides the real check.
 */
const networkPolicyForMode = (mode: ApprovalMode): NetworkPolicy =>
  mode === "auto" ? "deny" : "allow";

/**
 * Reads `sandbox` config, falling back to the default on any read failure.
 *
 * @remarks
 * By the time a command can run, bootstrap has already called `loadConfig`
 * successfully at least once (unlocking the config cipher if needed), so
 * this should never actually throw in production. Falls back rather than
 * propagating regardless, since a config read failure for a non-secret
 * setting shouldn't take down command execution — sandboxing degrades to
 * its default rather than the run failing outright.
 */
const loadSandboxConfig = (): { mode: SandboxMode; containerImage: string } => {
  try {
    return loadConfig().sandbox;
  } catch {
    return getDefaultConfig().sandbox;
  }
};

/**
 * Tracks whether {@link warnSandboxUnavailable} has already fired this
 * process — printed once, not on every command, so it stays visible without
 * flooding scrollback on a machine that's simply missing a backend.
 */
let sandboxUnavailableWarned = false;

/**
 * Warns once per process when `sandbox.mode` is not `"off"` but no backend
 * could be resolved on this machine — otherwise the command still runs, just
 * silently unconfined (see {@link resolveSandboxForCommand}), with no signal
 * that the configured boundary isn't actually in effect.
 */
const warnSandboxUnavailable = (): void => {
  if (sandboxUnavailableWarned) {
    return;
  }
  sandboxUnavailableWarned = true;
  beginBlockOutput();
  logger.blank();
  const theme = getTheme();
  logger.info(
    `  ${theme.warning}⚠${theme.reset}  No sandbox backend available — commands are running unconfined. Run /sandbox status for details.`,
  );
  logger.blank();
};

/** Resolves the active sandbox (if any) and the policy to run `command` under. */
const resolveSandboxForCommand = (
  cwd: string,
): { sandbox: SandboxProvider; policy: SandboxPolicy } | null => {
  const { mode, containerImage } = loadSandboxConfig();
  const sandbox = resolveConfiguredSandbox(mode, containerImage);
  if (!sandbox) {
    if (mode !== "off") {
      warnSandboxUnavailable();
    }
    return null;
  }
  const policy = buildSandboxPolicy({
    cwd,
    network: networkPolicyForMode(getApprovalMode()),
  });
  return { sandbox, policy };
};

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
 * and its output is not proxied back to the agent — deliberate, since this
 * is how a long-running dev server is meant to behave, so unlike foreground
 * commands this does **not** gain a kill-after-timeout (that would defeat
 * the feature). It does gain the same sandbox confinement and env scrubbing
 * as foreground commands when a backend is available (see
 * {@link resolveSandboxForCommand}) — a backgrounded `rm -rf` deserves the
 * same containment as a foregrounded one.
 *
 * @param context - Provides `currentDir` for the spawned process's cwd.
 * @param command - Raw command line to run.
 */
const runBackgroundCommand = async (
  context: DispatchContext,
  command: string,
): Promise<CommandRunResult> => {
  if (getApprovalMode() !== "auto") {
    const { approved, feedback } = await confirmRunOrSkip(command);
    if (!approved) {
      printDeclineFeedback(feedback);
      return declinedCommandResult(feedback);
    }
    printBashApproved();
  }

  if (command.trim().length === 0) {
    return { stdout: "", stderr: "empty command", exitCode: 1 };
  }

  const sandboxed = resolveSandboxForCommand(context.currentDir);
  const spawnSpec = sandboxed
    ? (() => {
        const { argv } = sandboxed.sandbox.wrapCommand(command, {
          cwd: context.currentDir,
          policy: sandboxed.policy,
        });
        return { bin: argv[0] ?? "/bin/sh", args: argv.slice(1) };
      })()
    : (() => {
        const commandParts = command.trim().split(/\s+/);
        return { bin: commandParts[0] ?? "", args: commandParts.slice(1) };
      })();

  let spawnedProcess;
  try {
    spawnedProcess = spawn(spawnSpec.bin, spawnSpec.args, {
      detached: true,
      stdio: "ignore",
      cwd: context.currentDir,
      env: scrubEnv(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
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
  sandboxed: { sandbox: SandboxProvider; policy: SandboxPolicy } | null,
): Promise<ShellResult> => {
  const startTime = Date.now();

  const trackedCommand = wrapCommandForCwdTracking(command, isWindowsShell());
  const executionResult = await context.runShell(trackedCommand, {
    sandbox: sandboxed?.sandbox,
    policy: sandboxed?.policy,
  });

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
 * 3. Every foreground command runs through the platform sandbox backend
 *    (see {@link resolveSandboxForCommand}) when one is available — `"safe"`
 *    included, since sandboxing confines what a command can *do*, which is
 *    orthogonal to whether the user was asked to approve it first. If the
 *    sandbox denies something legitimate, the user is offered one retry
 *    *without* the sandbox rather than being stuck.
 * 4. Foreground runs wrap the command for CWD tracking, strip the marker from
 *    stdout, and call `setCurrentDir` when the new path is inside the workspace
 *    (escapes like `cd /` are ignored).
 *
 * Mode overrides (consulted via {@link getApprovalMode}):
 * - `auto` skips every approval prompt unconditionally — safe, cautious,
 *   dangerous, and background commands all run without a human checking
 *   first. Sandboxing still applies when a backend is available, and its
 *   network policy switches to deny-by-default specifically because `auto`
 *   is the one mode with no human in the loop to catch an exfiltration
 *   attempt (see {@link networkPolicyForMode}).
 * - `safe` always runs free regardless of mode.
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
  const mode = getApprovalMode();

  // background flag wins over heuristics so long-running servers skip CWD wrap.
  const commandClassification: BashClass = forceBackgroundExecution
    ? "background"
    : context.classifyCommand(command);

  printBash(command, commandClassification);

  if (commandClassification === "background") {
    return runBackgroundCommand(context, command);
  }

  const skipPrompt = mode === "auto";
  const sandboxed = resolveSandboxForCommand(context.currentDir);

  const needsPrompt = !skipPrompt && commandClassification !== "safe";

  if (needsPrompt) {
    const declineResult = await confirmForegroundCommand(
      command,
      commandClassification,
    );
    if (declineResult) {
      return declineResult;
    }
  }

  const result = await executeForegroundCommand(
    context,
    command,
    commandClassification,
    sandboxed,
  );

  if (sandboxed && detectSandboxDenial(sandboxed.sandbox, result)) {
    const { approved, feedback } = await confirmRunOrSkip(command);
    if (!approved) {
      printDeclineFeedback(feedback);
      return declinedCommandResult(feedback);
    }
    printBashApproved();
    return executeForegroundCommand(
      context,
      command,
      commandClassification,
      null,
    );
  }

  return result;
};
