/**
 * Proxies shell command execution to a connected CLI client via ClientBridge.
 *
 * @remarks
 * This module enables the server to execute arbitrary shell commands on the client machine
 * by routing execution requests through an RSocket bridge. The client handles the actual
 * subprocess invocation, I/O capture, and signal handling.
 *
 * **Use cases:**
 * - Running build/test commands triggered by user interactions
 * - Executing linters, formatters, or other CLI tools
 * - Running version control commands (git, etc.)
 * - Any server-side task that needs to interact with the local file system or environment
 *
 * **Design philosophy:**
 * Like {@link WorkspaceManager}, this class maintains zero knowledge of the actual shell
 * environment. All I/O delegation to the client ensures:
 * - Commands run in the user's actual environment (not the server sandbox)
 * - Environment variables, PATH, and credentials are accessible
 * - User can see and interact with long-running processes
 *
 * @example
 * ```ts
 * const bridge = new ClientBridge(...);
 * const executor = new TerminalExecutor(bridge);
 * executor.bindRequester("client_session_123");
 *
 * // Run a command with confirmation
 * const result = await executor.runWithConfirmation("npm test");
 * if (result.exitCode === 0) {
 *   console.log("Tests passed:", result.stdout);
 * } else {
 *   console.error("Tests failed:", result.stderr);
 * }
 *
 * // Run in background (non-blocking)
 * await executor.runWithConfirmation("npm build", undefined, { background: true });
 * ```
 *
 * @see {@link WorkspaceManager} for file system operations (parallel design pattern)
 * @see {@link ClientBridge} for the transport mechanism
 */

import type { IExperienceRecorder } from "../../orchestration/interfaces.js";
import type { ClientBridge } from "../../transport/clientBridge.js";

/**
 * Context for recording/auditing terminal command executions.
 *
 * @remarks
 * When provided to a command execution method, this context enables logging and replay
 * of commands for audit trails, task history, or post-execution analysis.
 *
 * @example
 * ```ts
 * const context: TerminalRecorderContext = {
 *   recorder: auditLog,
 *   taskId: "task_abc123"
 * };
 * await executor.runWithConfirmation("npm test", context);
 * // The command and its result are now recorded in auditLog under taskId
 * ```
 */
export type TerminalRecorderContext = {
  /** The recorder instance used to log this command execution for audit purposes. */
  recorder?: IExperienceRecorder;
  /** The task ID associating this command with a specific user action or workflow task. */
  taskId?: string;
};

/**
 * Classification of a shell command based on its safety and side effects.
 *
 * @remarks
 * This classification helps the client determine what confirmation or warnings to show
 * before executing the command. Users should be aware of the risks when executing
 * commands that modify the file system or environment.
 *
 * - **"safe":** Read-only commands that don't modify state (e.g., `ls`, `grep`, `git log`)
 * - **"cautious":** Commands that make local changes but are easily reversible (e.g., `npm install`, `git checkout`)
 * - **"dangerous":** Commands that cause significant side effects or data loss (e.g., `rm -rf`, `git push --force`)
 *
 * @example
 * ```ts
 * // These would be classified as:
 * "ls" as CommandClass;              // "safe"
 * "npm install" as CommandClass;     // "cautious"
 * "git push --force" as CommandClass; // "dangerous"
 * ```
 */
export type CommandClass = "safe" | "cautious" | "dangerous";

/**
 * The result of a shell command execution on the client.
 *
 * @remarks
 * When a command completes (or is rejected by the user), this object contains the
 * outcome including standard output, error output, and exit code. If the user rejected
 * the command before it ran, a `feedback` field provides their reason.
 *
 * **Exit codes:** Follow Unix conventions — 0 means success, non-zero means failure.
 * Some commands may exit with non-zero even on partial success (e.g., `diff` exits 1
 * when files differ, which is expected behavior).
 *
 * @example
 * ```ts
 * const result = await executor.runWithConfirmation("npm test");
 * // result might be:
 * // {
 * //   stdout: "PASS: tests/unit.test.ts\n",
 * //   stderr: "",
 * //   exitCode: 0
 * // }
 *
 * // Or if the user rejected:
 * // {
 * //   stdout: "",
 * //   stderr: "",
 * //   exitCode: 1,
 * //   feedback: "User chose not to run this command"
 * // }
 * ```
 */
export type CommandResult = {
  /** Standard output (stdout) from the command. May be empty if command produced no output. */
  stdout: string;
  /** Standard error (stderr) from the command. May be empty if command produced no errors. */
  stderr: string;
  /** Exit code returned by the command process. 0 typically indicates success, non-zero indicates failure. */
  exitCode: number;
  /** Human-readable reason when the user chose "Revise" or rejected the command before execution. */
  feedback?: string;
};

/**
 * Executor for running shell commands on the connected CLI client.
 *
 * @remarks
 * TerminalExecutor manages the lifecycle and routing of shell command execution requests
 * to a connected client. Like {@link WorkspaceManager}, it follows a bound session pattern:
 * 1. Constructor accepts a ClientBridge (typically injected)
 * 2. {@link bindRequester} associates the executor with a specific client session
 * 3. {@link run} and {@link runWithConfirmation} route commands to that client
 * 4. {@link dispose} cleans up when the session ends
 *
 * **Key differences from WorkspaceManager:**
 * - Commands execute asynchronously and may take time; they're not idempotent
 * - The client may show a confirmation prompt before running (for dangerous commands)
 * - Results include both stdout and stderr separately for separate stream handling
 * - Background execution is supported (non-blocking, fire-and-forget)
 *
 * @example
 * ```ts
 * const bridge = new ClientBridge(...);
 * const executor = new TerminalExecutor(bridge);
 * executor.bindRequester("client_xyz");
 *
 * // Simple run
 * const result1 = await executor.run("npm test");
 *
 * // With logging
 * const result2 = await executor.run("git status", {
 *   recorder: auditLog,
 *   taskId: "task_123"
 * });
 *
 * // With options
 * const result3 = await executor.runWithConfirmation(
 *   "rm -rf build/",
 *   undefined,
 *   { background: false }
 * );
 *
 * executor.dispose();
 * ```
 */
export class TerminalExecutor {
  /**
   * The ID of the currently bound client session, or null if no session is bound yet.
   * Set via {@link bindRequester} when a client connects.
   */
  private requesterId: string | null = null;

  /**
   * Tracks whether this executor has been disposed. Once "DISPOSED", all operations
   * will throw an error. This prevents accidental reuse after cleanup.
   */
  private state: "ACTIVE" | "DISPOSED" = "ACTIVE";

  /**
   * Creates a new TerminalExecutor.
   *
   * @param bridge - The ClientBridge transport layer used to send command execution
   *   requests to the connected CLI client. The bridge must be properly initialized
   *   and ready to handle requests before this executor is used.
   *
   * @remarks
   * The executor is created in an "unbound" state. {@link bindRequester} must be
   * called before any command executions will succeed. This allows the executor to be
   * instantiated before a client connection is established.
   *
   * @example
   * ```ts
   * const bridge = new ClientBridge(...);
   * const executor = new TerminalExecutor(bridge);
   * // Now call executor.bindRequester(...) when client connects
   * ```
   */
  constructor(private readonly bridge: ClientBridge) {}

  /**
   * Binds this executor to a specific client session ID.
   *
   * @remarks
   * This method must be called exactly once after construction and before any command
   * executions. Binding associates all subsequent operations with the given client session.
   * If called multiple times, the previous requesterId is silently overwritten.
   *
   * In a multi-client server, each client would have its own TerminalExecutor instance
   * bound to its own session ID, so each client's command executions are isolated.
   *
   * @param requesterId - The unique session ID of the connected client, e.g. "client_abc123".
   *   This ID is used as the recipient address when routing requests through the ClientBridge.
   *
   * @example
   * ```ts
   * const executor = new TerminalExecutor(bridge);
   * executor.bindRequester("client_session_xyz");
   *
   * // Now operations will route to that client
   * const result = await executor.run("echo hello");
   * ```
   */
  bindRequester = (requesterId: string): void => {
    this.requesterId = requesterId;
  };

  /**
   * Ensures the executor is in a valid state for operations and returns the bound requester ID.
   *
   * @remarks
   * This is a guard method called at the start of every command execution to validate
   * preconditions:
   * 1. The executor hasn't been disposed (state is still "ACTIVE")
   * 2. A client session has been bound (requesterId is set)
   *
   * If either condition fails, an Error is thrown with a descriptive message.
   * This prevents silent failures or operations routing to undefined clients.
   *
   * @returns The requesterId string if both conditions pass.
   * @throws {@link Error} if the executor has been disposed.
   * @throws {@link Error} if no client session is bound.
   *
   * @example
   * ```ts
   * // This is only called internally before operations:
   * // const id = this.requireRequester(); // Throws if not ready
   * // await this.bridge.request(id, "command.run", ...);
   * ```
   */
  private requireRequester = (): string => {
    // Check if this executor has been cleaned up already.
    if (this.state === "DISPOSED") {
      throw new Error("TerminalExecutor has been disposed");
    }
    // Check if a client session is bound. Without this, we have nowhere to route requests.
    if (!this.requesterId) {
      throw new Error("No client session bound for terminal");
    }
    return this.requesterId;
  };

  /**
   * Runs a shell command on the connected client (alias for {@link runWithConfirmation}).
   *
   * @remarks
   * This is a convenience method that calls {@link runWithConfirmation} without options,
   * allowing the client to show a confirmation prompt if the command is classified as risky.
   * For most use cases, this is the preferred method. Use {@link runWithConfirmation}
   * directly if you need to customize confirmation behavior or run in the background.
   *
   * **Logging:** If a {@link TerminalRecorderContext} is provided, the command execution
   * and its result are logged for audit purposes.
   *
   * @param command - The shell command to execute, e.g. "npm test" or "git commit -m 'msg'".
   *   This is the raw command string sent to the shell. No escaping or validation is performed
   *   by this method — ensure the command is safe before passing it.
   * @param ctx - Optional context for logging this command execution.
   * @returns A {@link CommandResult} containing stdout, stderr, exit code, and optional feedback.
   * @throws {@link Error} if the executor is disposed or no client is bound.
   * @throws If the command execution fails on the client side.
   *
   * @example
   * ```ts
   * // Simple execution
   * const result = await executor.run("npm test");
   * console.log(`Exit code: ${result.exitCode}`);
   *
   * // With logging
   * const result = await executor.run("git status", {
   *   recorder: auditLog,
   *   taskId: "task_123"
   * });
   * ```
   */
  run = async (
    command: string,
    ctx?: TerminalRecorderContext,
  ): Promise<CommandResult> => {
    return this.runWithConfirmation(command, ctx);
  };

  /**
   * Runs a shell command on the connected client with optional confirmation and background execution.
   *
   * @remarks
   * This is the primary method for executing commands. The client may display a confirmation
   * prompt for risky commands before proceeding. If the user chooses "Revise", the command
   * won't execute and the result will include a `feedback` message explaining why.
   *
   * **Foreground vs. background:**
   * - Foreground (default): The method waits for the command to complete and returns its result.
   * - Background: The method returns immediately without waiting; stdout/stderr will be empty.
   *
   * **Logging:** If a {@link TerminalRecorderContext} is provided with a recorder and taskId,
   * this execution is logged for audit or replay purposes.
   *
   * **Environment:** Commands execute in the client's shell environment, so they have access
   * to environment variables, PATH, credentials, and working directory. This is different from
   * the server's environment.
   *
   * @param command - The shell command to execute, e.g. "npm install" or "python script.py".
   *   Sent as-is to the client's shell (typically bash or similar).
   * @param ctx - Optional context for logging this command execution. If provided with a
   *   recorder and taskId, the command and its result are logged for audit purposes.
   * @param opts - Optional configuration:
   *   - background: If true, run the command without waiting for it to complete. Returns
   *     immediately with empty stdout/stderr. Defaults to false (foreground, blocking).
   * @returns A {@link CommandResult} containing the command's output and exit code.
   *   If the user rejected the command before running, exitCode will be non-zero and
   *   `feedback` will explain the reason.
   * @throws {@link Error} if the executor is disposed or no client is bound.
   * @throws If the bridge request fails or times out.
   *
   * @example
   * ```ts
   * // Foreground execution (wait for completion)
   * const result = await executor.runWithConfirmation("npm test");
   * if (result.exitCode === 0) {
   *   console.log("Tests passed");
   * } else {
   *   console.error("Tests failed:", result.stderr);
   * }
   *
   * // Background execution (fire and forget)
   * await executor.runWithConfirmation(
   *   "npm build && npm deploy",
   *   undefined,
   *   { background: true }
   * );
   * console.log("Deploy started in background...");
   *
   * // With logging
   * const result = await executor.runWithConfirmation(
   *   "git push origin main",
   *   { recorder: auditLog, taskId: "task_456" },
   *   { background: false }
   * );
   * ```
   */
  runWithConfirmation = async (
    command: string,
    ctx?: TerminalRecorderContext,
    opts?: { background?: boolean },
  ): Promise<CommandResult> => {
    // Validate that a client session is bound before attempting execution.
    const id = this.requireRequester();
    // Send the command execution request to the client via the bridge.
    // The client will show a confirmation prompt if needed and execute the command.
    const data = await this.bridge.request<CommandResult>(id, "command.run", {
      command,
      // Explicitly convert the background flag to a boolean; default to false if not set.
      background: opts?.background === true,
    });
    // Log this command execution if a recorder context was provided.
    if (ctx?.recorder && ctx.taskId) {
      ctx.recorder.logCommand(ctx.taskId, command, data);
    }
    return data;
  };

  /**
   * Cleans up this TerminalExecutor and prevents further operations.
   *
   * @remarks
   * This method marks the executor as disposed, freeing resources and preventing accidental
   * reuse after a session ends. Any operations attempted after dispose will throw
   * an Error.
   *
   * Call this when the client session terminates to ensure clean resource cleanup and
   * prevent silent failures from stale executor references.
   *
   * @example
   * ```ts
   * executor.dispose();
   * // Now any call to executor.run() will throw Error("TerminalExecutor has been disposed")
   * ```
   */
  dispose = (): void => {
    // Mark the executor as disposed so future operations will be rejected.
    this.state = "DISPOSED";
    // Clear the requester ID to be thorough (defensive programming).
    this.requesterId = null;
  };
}
