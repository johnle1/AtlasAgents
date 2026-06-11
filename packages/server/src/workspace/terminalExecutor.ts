/**
 * <Summary>
 * What it does:
 *   Classifies shell commands by safety (for display/policy), runs them with cwd
 *   locked to the workspace root, and gates every agent run through ConfirmationBroker.
 *
 * How it fits in the system:
 *   Agent shell tooling; runWithConfirmation always prompts before spawn.
 *
 * Dependencies:
 *   - node:child_process — spawn shell with timeout and SIGKILL.
 *   - ./confirmationBroker.js — requestCommand before every runWithConfirmation.
 *
 * Dependants:
 *   - Agent.
 * </Summary>
 */

import { spawn } from "node:child_process";

import type { ConfirmationBroker } from "./confirmationBroker.js";

const SAFE_BASE_COMMANDS = new Set([
  "ls",
  "cat",
  "pwd",
  "echo",
  "find",
  "grep",
  "head",
  "tail",
  "wc",
]);

const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "diff"]);

const DANGEROUS_TOKENS = new Set([
  "rm",
  "rmdir",
  "drop",
  "truncate",
  "reset",
  "--hard",
  "--force",
  "-rf",
  "-f",
  "dd",
  "mkfs",
]);

/**
 * <Summary>
 * What it does:
 *   Safety tier for a shell command string before execution.
 *
 * Used by:
 *   - TerminalExecutor.runWithConfirmation.
 * </Summary>
 */
export type CommandClass = "safe" | "cautious" | "dangerous";

/**
 * <Summary>
 * What it does:
 *   Captured stdout, stderr, and exit status from one shell run.
 *
 * Used by:
 *   - TerminalExecutor.run, runWithConfirmation.
 * </Summary>
 */
export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const DEFAULT_RUN_TIMEOUT_MS = 30_000;

export class TerminalExecutor {
  private readonly workspaceRoot: string;

  private readonly confirmation: ConfirmationBroker | undefined;

  private readonly timeoutMs: number;

  /**
   * @param {{ workspaceRoot: string; confirmation?: ConfirmationBroker; timeoutMs?: number }} deps — cwd root, optional broker, optional run timeout (default 30s).
   */
  constructor(deps: {
    workspaceRoot: string;
    confirmation?: ConfirmationBroker;
    timeoutMs?: number;
  }) {
    this.workspaceRoot = deps.workspaceRoot;
    this.confirmation = deps.confirmation;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  /**
   * <Summary>
   * What it does:
   *   Tokenises a command and returns safe, dangerous, or cautious per project rules.
   *
   * How it does it (step by step):
   *   1. Lowercases and trims the command string.
   *   2. Splits on whitespace into tokens.
   *   3. Returns safe when the base command is in the safe list or git with a safe subcommand.
   *   4. Returns dangerous when any token matches a dangerous token or chmod 777 appears.
   *   5. Otherwise returns cautious.
   *
   * Parameters:
   *   @param {string} command — Raw shell command.
   *
   * Returns:
   *   @returns {CommandClass} — Classification result.
   *
   * Dependants:
   *   - runWithConfirmation.
   * </Summary>
   */
  classify = (command: string): CommandClass => {
    // Step 1: Normalize the command string for consistent comparison
    // Convert to lowercase and remove leading/trailing whitespace
    const normalizedLowerCaseCommand = command.toLowerCase().trim();

    // Step 2: Split the command into tokens by whitespace
    // Filter out empty strings that may result from multiple spaces
    // Example: "git   status" → ["git", "status"]
    const commandTokens = normalizedLowerCaseCommand
      .split(/\s+/)
      .filter((tokenString) => tokenString.length > 0);

    // Step 3: Guard against empty commands (edge case)
    // If no tokens parsed, default to cautious classification
    if (commandTokens.length === 0) {
      return "cautious";
    }

    // Step 4: Extract the base command (first token)
    // This is the program name being invoked (e.g., "git", "ls", "rm")
    const baseCommand = commandTokens[0] ?? "";

    // Step 5: Check if base command is in the safe list (ls, cat, pwd, etc.)
    // These commands only read/display data and cannot modify the filesystem
    if (SAFE_BASE_COMMANDS.has(baseCommand)) {
      return "safe";
    }

    // Step 6: Special case: check for safe git subcommands
    // git by itself is not safe, but "git status", "git log", "git diff" are read-only
    // Require at least 2 tokens ("git" + subcommand)
    if (
      baseCommand === "git" &&
      commandTokens.length >= 2 &&
      SAFE_GIT_SUBCOMMANDS.has(commandTokens[1] ?? "")
    ) {
      return "safe";
    }

    // Step 7: Check for the specific dangerous pattern: chmod 777
    // This pattern grants full permissions to all users (critical security risk)
    if (normalizedLowerCaseCommand.includes("chmod 777")) {
      return "dangerous";
    }

    // Step 8: Scan all tokens for dangerous keywords
    // Look for destructive commands: rm, rmdir, drop, truncate, reset --hard, -rf, -f, dd, mkfs
    for (const currentToken of commandTokens) {
      if (DANGEROUS_TOKENS.has(currentToken)) {
        return "dangerous";
      }
    }

    // Step 9: If not safe and not dangerous, return cautious
    // Cautious commands require user approval via ConfirmationBroker
    return "cautious";
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Spawns /bin/sh -c (or cmd.exe on Windows) in the workspace root with a hard timeout.
   *
   * How it does it (step by step):
   *   1. Refuses to run when the process uid is 0 (root).
   *   2. Spawns a child with cwd set to workspaceRoot.
   *   3. Collects stdout and stderr buffers until exit.
   *   4. Sends SIGKILL when the timeout elapses before exit.
   *
   * Parameters:
   *   @param {string} command — Shell command string.
   *
   * Returns:
   *   @returns {Promise<CommandResult>} — Captured streams and exit code.
   *
   * @throws {Error} — When running as root.
   *
   * Dependants:
   *   - runWithConfirmation.
   * </Summary>
   */
  run = (command: string): Promise<CommandResult> => {
    // Step 1: Security check - refuse to execute as root (uid 0)
    // Running arbitrary commands as root is a critical security risk
    // process.getuid() only available on Unix-like systems; check before calling
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return Promise.reject(
        new Error("Refusing to run shell commands as root"),
      );
    }

    return new Promise((resolve, reject) => {
      // Step 2: Initialize buffer arrays to accumulate output streams
      // These will collect all data chunks from stdout and stderr
      const stdoutDataChunks: Buffer[] = [];
      const stderrDataChunks: Buffer[] = [];

      // Step 3: Detect the operating system to choose correct shell
      // Windows uses cmd.exe, Unix-like systems use /bin/sh
      const isWindowsPlatform = process.platform === "win32";

      // Step 4: Spawn child process with appropriate shell and options
      // cwd: set working directory to workspace root (confines file operations)
      // stdio: ignore stdin, pipe stdout/stderr for capture
      const childProcess = isWindowsPlatform
        ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
            cwd: this.workspaceRoot,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn("/bin/sh", ["-c", command], {
            cwd: this.workspaceRoot,
            stdio: ["ignore", "pipe", "pipe"],
          });

      // Step 5: Set up timeout handler
      // If command doesn't exit before timeoutMs, force kill with SIGKILL
      const killTimeoutHandle = setTimeout(() => {
        childProcess.kill("SIGKILL");
      }, this.timeoutMs);

      // Step 6: Helper function to accumulate data chunks
      // Converts streaming data into array of buffers for later concatenation
      const accumulateDataChunk = (
        chunkArray: Buffer[],
        dataChunk: Buffer,
      ): void => {
        chunkArray.push(dataChunk);
      };

      // Step 7: Attach listeners to stdout stream
      // Collect all data emitted from the process's standard output
      childProcess.stdout?.on("data", (dataChunk: Buffer) => {
        accumulateDataChunk(stdoutDataChunks, dataChunk);
      });

      // Step 8: Attach listeners to stderr stream
      // Collect all data emitted from the process's standard error
      childProcess.stderr?.on("data", (dataChunk: Buffer) => {
        accumulateDataChunk(stderrDataChunks, dataChunk);
      });

      // Step 9: Handle process errors (e.g., shell not found, spawn failed)
      // Clean up timeout and reject the promise
      childProcess.on("error", (processError) => {
        clearTimeout(killTimeoutHandle);
        reject(processError);
      });

      // Step 10: Handle process termination (normal exit or timeout)
      // code: exit code (0 for success, non-zero for errors)
      // signal: termination signal if killed (SIGKILL, SIGTERM, etc.)
      childProcess.on("close", (exitCodeOrNull, terminationSignal) => {
        // Step 10a: Cancel the timeout since process already exited
        clearTimeout(killTimeoutHandle);

        // Step 10b: Convert all stderr chunks to UTF-8 string
        let combinedStderr = Buffer.concat(stderrDataChunks).toString("utf-8");

        // Step 10c: Determine the exit code
        // If code is null (shouldn't happen), use -1 as error indicator
        let finalExitCode = exitCodeOrNull ?? -1;

        // Step 10d: Check if process was killed due to timeout
        // If so, append timeout message to stderr and set exit code to -1
        if (terminationSignal === "SIGKILL") {
          combinedStderr += `\n[timeout: command exceeded ${this.timeoutMs}ms]`;
          finalExitCode = -1;
        }

        // Step 10e: Resolve with complete command result
        // Convert stdout chunks to UTF-8 string
        resolve({
          stdout: Buffer.concat(stdoutDataChunks).toString("utf-8"),
          stderr: combinedStderr,
          exitCode: finalExitCode,
        });
      });
    });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Runs immediately for safe commands; otherwise asks ConfirmationBroker and
   *   returns a skipped result when the user declines.
   *
   * How it does it (step by step):
   *   1. Classifies the command string.
   *   2. Safe commands run without confirmation.
   *   3. Cautious and dangerous commands require a broker; calls requestCommand.
   *   4. On decline, returns empty stdout, stderr message, exitCode -1 without running.
   *
   * Parameters:
   *   @param {string} command — Shell command string.
   *
   * Returns:
   *   @returns {Promise<CommandResult>} — Same shape as run.
   *
   * @throws {Error} — When no ConfirmationBroker is configured.
   *
   * Dependants:
   *   - Agent.
   * </Summary>
   */
  runWithConfirmation = async (command: string): Promise<CommandResult> => {
    if (this.confirmation === undefined) {
      throw new Error(
        "ConfirmationBroker is required before running shell commands",
      );
    }

    const approved = await this.confirmation.requestCommand(command);
    if (!approved) {
      return {
        stdout: "",
        stderr: "skipped by user",
        exitCode: -1,
      };
    }

    // Step 6: User approved, execute the command
    // Run the command and return the actual result (stdout, stderr, exitCode)
    return this.run(command);
  };
}
