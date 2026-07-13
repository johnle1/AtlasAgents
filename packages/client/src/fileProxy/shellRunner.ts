/**
 * Child-process shell runner with timeout and AbortSignal support.
 *
 * @remarks
 * Spawns `cmd.exe /c` on Windows and `/bin/sh -c` elsewhere, captures stdout /
 * stderr, and always settles exactly once. Used by {@link DispatchContext.runShell}.
 */

import { spawn } from "node:child_process";
import type { ShellResult } from "./types.js";

/**
 * Stderr token prepended when a command is killed for exceeding its timeout.
 *
 * @remarks
 * Lets the UI and models distinguish hard kills from normal tool stderr.
 */
export const SHELL_TIMEOUT_MARKER = "[TIMEOUT]";

/**
 * Builds the human-readable timeout line appended to stderr.
 *
 * @param timeoutMs - Limit that was exceeded, in milliseconds.
 * @returns Message including {@link SHELL_TIMEOUT_MARKER}.
 *
 * @example
 * ```ts
 * formatShellTimeoutMessage(30_000);
 * → "[TIMEOUT] Command exceeded 30000ms and was killed."
 * ```
 */
export const formatShellTimeoutMessage = (timeoutMs: number): string =>
  `${SHELL_TIMEOUT_MARKER} Command exceeded ${timeoutMs}ms and was killed.`;

/**
 * Formats an AbortSignal reason into a stderr cancellation line.
 *
 * @param signal - Already-aborted signal whose `reason` may be string or Error.
 * @returns Message such as `"Command cancelled: Connection lost"`.
 */
const formatAbortMessage = (signal: AbortSignal): string => {
  // ===== STEP 1: Extract abort reason =====
  // Step 1a: Get the reason property from the AbortSignal
  // Step 1b: Reason can be: string, Error, undefined, or anything else
  const reason = signal.reason;

  // ===== STEP 2: Check for string reason =====
  // Step 2a: If reason is a non-empty string, include it in the message
  // Step 2b: This gives users context about why the abort happened
  if (typeof reason === "string" && reason.length > 0) {
    return `Command cancelled: ${reason}`;
  }

  // ===== STEP 3: Check for Error reason =====
  // Step 3a: If reason is an Error object with a message, extract the message
  // Step 3b: Error.message is the standard way to get error description
  if (reason instanceof Error && reason.message.length > 0) {
    return `Command cancelled: ${reason.message}`;
  }

  // ===== STEP 4: Fallback message =====
  // Step 4a: If no meaningful reason available, assume connection loss
  // Step 4b: This is the most common cause of AbortSignal (RSocket disconnect)
  return "Command cancelled (connection lost)";
};

/**
 * Executes a shell command in `cwd` and returns captured streams + exit code.
 *
 * @remarks
 * - Default timeout is 120 s (`SIGKILL` on expiry); stderr gains a timeout line.
 * - If `signal` aborts (or is already aborted), the child is killed and the
 *   Promise **resolves** (does not reject) with `exitCode: -1` and a cancel message.
 * - Spawn/`error` events **reject** the Promise (e.g. shell missing).
 * - Missing exit codes become `-1`.
 *
 * @param command - Full command line passed to the platform shell.
 * @param cwd - Absolute working directory for the child.
 * @param timeoutMs - Kill deadline; default `120_000`.
 * @param signal - Optional session abort (e.g. RSocket disconnect).
 * @returns {@link ShellResult} when the process closes or is cancelled.
 * @throws {@link Error} When the child emits `error` before a successful settle.
 *
 * @example
 * ```ts
 * const result = await runShell("ls -la", "/proj", 60_000);
 * console.log(result.exitCode, result.stdout);
 * ```
 */
export const runShell = (
  command: string,
  cwd: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<ShellResult> =>
  new Promise((resolve, reject) => {
    // ===== STEP 1: Detect platform =====
    // Step 1a: Check if running on Windows (win32 platform code)
    // Step 1b: Different shells and flags needed for Windows vs Unix
    const isWindowsPlatform = process.platform === "win32";

    // ===== STEP 2: Spawn shell process =====
    // Step 2a: On Windows: use cmd.exe with specific flags
    //         /d = Disable AutoRun registry commands (avoids startup scripts)
    //         /s = Strip first and last quotes from command string
    //         /c = Execute the command and exit
    // Step 2b: On Unix: use /bin/sh with -c flag to execute command string
    // Step 2c: Configure stdio:
    //         - stdin: "ignore" (no interactive input allowed)
    //         - stdout: "pipe" (capture output from command)
    //         - stderr: "pipe" (capture errors separately from stdout)
    // Step 2d: Set working directory (cwd) so command runs in correct location
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
    // Step 3a: Create arrays to accumulate stdout data chunks
    // Step 3b: Create arrays to accumulate stderr data chunks
    // Step 3c: Using Buffer arrays allows efficient streaming collection
    // Step 3d: Will concatenate all chunks at the end into single strings
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // ===== STEP 4: Set up execution timeout =====
    // Step 4a: Flag to track if process was killed due to timeout
    // Step 4b: Used later to append timeout message to stderr
    let timedOut = false;

    // Step 4c: Create timeout that fires after timeoutMs milliseconds
    // Step 4d: When timeout fires:
    //         1. Mark that we timed out (for stderr message)
    //         2. Send SIGKILL to the process (forces immediate termination)
    //         3. Process will emit 'close' event, triggering finish() below
    const executionTimeout = setTimeout(() => {
      timedOut = true;
      // Step 4e: SIGKILL cannot be caught/ignored - guarantees process dies
      spawnedProcess.kill("SIGKILL");
    }, timeoutMs);

    // ===== STEP 5: Settlement guard =====
    // Step 5a: Race condition: close event, abort event, and timeout can all fire
    // Step 5b: Only the FIRST completion event should settle the promise
    // Step 5c: This flag prevents multiple resolve/reject calls (which would error)
    // Step 5d: Possible completion sources:
    //         - Process closes normally (most common)
    //         - Process killed by timeout (timedOut: true)
    //         - AbortSignal fires (via onAbort)
    //         - Spawn error (via spawnedProcess.on('error'))
    let settled = false;

    // ===== HELPER: Settle promise exactly once =====
    /**
     * Settles the promise with a result and cleans up all timers/listeners.
     * Ensures promise only resolves once, preventing double-resolution errors.
     *
     * @param result - The ShellResult to resolve with.
     */
    const finish = (result: ShellResult): void => {
      // ===== STEP 1: Check settlement guard =====
      // Step 1a: If already settled by another event, exit early
      // Step 1b: Prevents double-resolution errors from multiple completion sources
      if (settled) return;

      // ===== STEP 2: Mark as settled =====
      // Step 2a: Set flag to prevent future finish() calls from executing
      settled = true;

      // ===== STEP 3: Clean up timeout =====
      // Step 3a: Clear the execution timeout timer
      // Step 3b: Prevents timeout from firing after promise already settled
      clearTimeout(executionTimeout);

      // ===== STEP 4: Remove abort listener =====
      // Step 4a: Remove the 'abort' event listener from the signal
      // Step 4b: Prevents memory leaks from accumulating listeners
      signal?.removeEventListener("abort", onAbort);

      // ===== STEP 5: Resolve the promise =====
      // Step 5a: Resolve with the ShellResult containing stdout/stderr/exitCode
      resolve(result);
    };

    // ===== HELPER: Build complete shell result =====
    /**
     * Constructs a ShellResult from captured buffers and metadata.
     * Appends timeout marker to stderr if process was killed due to timeout.
     *
     * @param exitCode - Process exit code from close event (may be null).
     * @returns Complete ShellResult ready to return to caller.
     */
    const buildResult = (exitCode: number | null): ShellResult => {
      // ===== STEP 1: Concatenate stderr chunks =====
      // Step 1a: Convert all stderr buffer chunks into a single UTF-8 string
      // Step 1b: Buffer.concat handles empty array (returns empty Buffer)
      let stderr = Buffer.concat(stderrChunks).toString("utf-8");

      // ===== STEP 2: Append timeout marker if applicable =====
      // Step 2a: If process was killed by timeout (timedOut flag is true)
      if (timedOut) {
        // Step 2b: Create timeout message using SHELL_TIMEOUT_MARKER
        const timeoutMessage = formatShellTimeoutMessage(timeoutMs);

        // Step 2c: Append timeout message to existing stderr
        // Step 2d: If stderr is empty, just use the timeout message alone
        // Step 2e: If stderr has content, append on new line for clarity
        stderr =
          stderr.length > 0 ? `${stderr}\n${timeoutMessage}` : timeoutMessage;
      }

      // ===== STEP 3: Return complete result =====
      // Step 3a: Concatenate all stdout chunks into a single UTF-8 string
      // Step 3b: Include cleaned stderr (with timeout marker if applicable)
      // Step 3c: Convert exit code: use provided code if available, else -1
      //         -1 indicates exit code was null/unavailable (e.g., killed by signal)
      return {
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr,
        exitCode: exitCode ?? -1,
      };
    };

    // ===== HELPER: Handle abort signal =====
    /**
     * Callback when the session AbortSignal is triggered.
     * Kills the process and resolves with cancellation message.
     */
    const onAbort = (): void => {
      // ===== STEP 1: Kill the process =====
      // Step 1a: Send SIGKILL to force immediate termination
      // Step 1b: Process will emit 'close' event, but finish() guard prevents double-settle
      spawnedProcess.kill("SIGKILL");

      // ===== STEP 2: Resolve with cancellation result =====
      // Step 2a: Resolve promise with empty stdout (process was cancelled)
      // Step 2b: Include formatted abort message in stderr
      // Step 2c: Set exitCode to -1 (indicating abnormal termination)
      finish({
        stdout: "",
        stderr: signal ? formatAbortMessage(signal) : "Command cancelled",
        exitCode: -1,
      });
    };

    // ===== STEP 6: Register abort listener =====
    // Step 6a: Add listener for 'abort' event on the signal (if provided)
    // Step 6b: { once: true } ensures listener only fires once then auto-removes
    // Step 6c: If signal aborts, onAbort() callback will be invoked
    signal?.addEventListener("abort", onAbort, { once: true });

    // ===== STEP 7: Check for early abort =====
    // Step 7a: Race condition: signal might already be aborted before listener attached
    // Step 7b: This can happen if abort was called synchronously
    // Step 7c: Manually invoke onAbort() if signal already aborted
    // Step 7d: Early return to skip attaching stream listeners (process will die anyway)
    if (signal?.aborted) {
      onAbort();
      return;
    }

    // ===== STEP 8: Listen for stdout data =====
    // Step 8a: Register data event listener on stdout stream
    // Step 8b: Optional chaining (?.) used because stdout might not exist
    // Step 8c: Each data chunk is pushed to the stdoutChunks array
    // Step 8d: Chunks will be concatenated later in buildResult()
    spawnedProcess.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    // ===== STEP 9: Listen for stderr data =====
    // Step 9a: Register data event listener on stderr stream
    // Step 9b: Optional chaining (?.) used because stderr might not exist
    // Step 9c: Each error data chunk is pushed to the stderrChunks array
    // Step 9d: Chunks will be concatenated later in buildResult()
    spawnedProcess.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    // ===== STEP 10: Listen for spawn errors =====
    // Step 10a: Register error event listener on the child process
    // Step 10b: Error events indicate spawn failed (e.g., shell not found)
    // Step 10c: These are different from exit codes (hard spawn failure vs command failure)
    spawnedProcess.on("error", (error: Error) => {
      // ===== STEP 10-1: Check settlement guard =====
      // Step 10-1a: If already settled, do nothing (don't double-reject)
      if (settled) return;

      // ===== STEP 10-2: Mark as settled =====
      // Step 10-2a: Set flag to prevent future settlement events from executing
      settled = true;

      // ===== STEP 10-3: Clean up resources =====
      // Step 10-3a: Clear the execution timeout to prevent it from firing
      clearTimeout(executionTimeout);

      // ===== STEP 10-4: Remove abort listener =====
      // Step 10-4a: Remove the abort event listener to prevent memory leaks
      signal?.removeEventListener("abort", onAbort);

      // ===== STEP 10-5: Reject the promise =====
      // Step 10-5a: This is a hard failure (spawn error)
      // Step 10-5b: Caller receives an error via promise rejection
      // Step 10-5c: Examples: shell missing, permission denied, OS resource limit
      reject(error);
    });

    // ===== STEP 11: Listen for process close =====
    // Step 11a: Register close event listener on the child process
    // Step 11b: Close fires when the process terminates (from any cause)
    // Step 11c: This is the normal completion path (no spawn error)
    // Step 11d: exitCode parameter is the process exit code (or null if killed by signal)
    spawnedProcess.on("close", (exitCode: number | null) => {
      // ===== STEP 11-1: Build and finish with results =====
      // Step 11-1a: Build the complete ShellResult from collected data
      // Step 11-1b: finish() handles settlement guard (only resolves once)
      // Step 11-1c: buildResult() appends timeout message if process was killed
      finish(buildResult(exitCode));
    });
  });
