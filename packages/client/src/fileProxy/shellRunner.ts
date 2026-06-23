import { spawn } from "node:child_process";
import type { ShellResult } from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Executes a shell command in a specified directory and returns the output, errors, and exit code.
 *
 * How it does it (step by step):
 *   1. Detect the current platform to determine the appropriate shell (Windows vs Unix-like systems).
 *   2. Spawn a child process with the appropriate shell and command.
 *   3. Configure stdio to ignore stdin and pipe stdout and stderr for capture.
 *   4. Set up buffers to collect stdout and stderr chunks.
 *   5. Set a timeout to kill the process if it runs longer than 30 seconds.
 *   6. Listen for data events on stdout and stderr streams to collect output.
 *   7. Handle process errors by clearing timeout and rejecting the promise.
 *   8. Handle process close by clearing timeout, concatenating buffers, and resolving with results.
 *   9. Return the complete shell result with stdout, stderr, and exit code.
 *
 * Parameters:
 *   @param command - The shell command to execute (e.g., "ls -la", "git status").
 *   @param cwd - The working directory in which to execute the command.
 *
 * Returns:
 *   @returns Object containing stdout string, stderr string, and exit code.
 * </Summary>
 */
export const runShell = (
  command: string,
  cwd: string,
  timeoutMs = 30_000,
): Promise<ShellResult> =>
  new Promise((resolve, reject) => {
    // ===== STEP 1: Detect platform =====
    // Step 1a: Check if the current platform is Windows
    // Step 1b: This determines which shell to use (cmd.exe vs /bin/sh)
    const isWindowsPlatform = process.platform === "win32";

    // ===== STEP 2: Spawn appropriate shell process =====
    // Step 2a: On Windows, use cmd.exe with appropriate flags for command execution
    // Step 2b: On Unix-like systems, use /bin/sh with -c flag for command execution
    // Step 2c: Set working directory to the provided cwd parameter
    // Step 2d: Configure stdio: ignore stdin (no interactive input), pipe stdout and stderr for capture
    const spawnedProcess = isWindowsPlatform
      ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn("/bin/sh", ["-c", command], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });

    // ===== STEP 3: Initialize output buffers =====
    // Step 3a: Create arrays to collect stdout data chunks
    // Step 3b: Create arrays to collect stderr data chunks
    // Step 3c: Using arrays allows efficient collection of stream data
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // ===== STEP 4: Set execution timeout =====
    // Step 4a: Set a timeout to kill the process after 30 seconds
    // Step 4b: This prevents hung commands from blocking indefinitely
    // Step 4c: Store timeout ID for later cancellation
    const executionTimeout = setTimeout(
      () => spawnedProcess.kill("SIGKILL"),
      timeoutMs,
    );

    // ===== STEP 5: Capture stdout data =====
    // Step 5a: Listen for data events on the stdout stream
    // Step 5b: Push each data chunk into the stdout chunks array
    // Step 5c: Use optional chaining since stdout might not exist
    spawnedProcess.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    // ===== STEP 6: Capture stderr data =====
    // Step 6a: Listen for data events on the stderr stream
    // Step 6b: Push each data chunk into the stderr chunks array
    // Step 6c: Use optional chaining since stderr might not exist
    spawnedProcess.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    // ===== STEP 7: Handle process errors =====
    // Step 7a: Listen for error events on the child process
    // Step 7b: Clear the execution timeout since process has failed
    // Step 7c: Reject the promise with the error
    spawnedProcess.on("error", (error: Error) => {
      clearTimeout(executionTimeout);
      reject(error);
    });

    // ===== STEP 8: Handle process completion =====
    // Step 8a: Listen for close event when process terminates
    // Step 8b: Clear the execution timeout since process has completed
    // Step 8c: Concatenate all stdout chunks into a single buffer and convert to UTF-8 string
    // Step 8d: Concatenate all stderr chunks into a single buffer and convert to UTF-8 string
    // Step 8e: Use exit code if available, default to -1 if null/undefined
    // Step 8f: Resolve the promise with complete shell result
    spawnedProcess.on("close", (exitCode: number | null) => {
      clearTimeout(executionTimeout);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: exitCode ?? -1,
      });
    });
  });
