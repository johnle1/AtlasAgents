/**
 * Route name for a file/command operation sent from the server to the connected
 * CLI client over the RSocket bridge.
 *
 * @remarks
 * These are the only operations the server can ask a client to perform. Each route
 * corresponds to a request handler on the client side; the server never touches the
 * file system or shell directly — it only knows workspace-relative paths and shell
 * commands, and delegates all actual I/O to whichever client is bound to the session.
 *
 * **Route families:**
 * - `file.*` — Workspace file system operations (read, write, list, search, directory
 *   management, and working-directory tracking). See {@link WorkspaceManager} for the
 *   server-side callers of these routes.
 * - `command.*` — Shell command execution and pre-execution risk classification.
 *   See {@link TerminalExecutor} for the server-side caller of `command.run`.
 * - `mcp.call` — Invokes a Model Context Protocol tool exposed by the client.
 *
 * @example
 * ```ts
 * // Sending a request over the bridge
 * const route: ClientRoute = "file.read";
 * const result = await bridge.request<{ content: string }>(sessionId, route, { path: "README.md" });
 * ```
 */
export type ClientRoute =
  /** Read the full contents of a workspace-relative file. */
  | "file.read"
  /** Write (replace) the contents of a workspace-relative file. May be rejected by the client. */
  | "file.write"
  /** List the workspace directory tree up to a given depth. */
  | "file.list_dir"
  /** Search the workspace for files matching a glob or text pattern. */
  | "file.search"
  /** Create a new directory (and any missing parent directories) in the workspace. */
  | "file.create_dir"
  /** Delete a single file from the workspace. */
  | "file.delete_file"
  /** Delete a directory (and its contents) from the workspace. */
  | "file.delete_dir"
  /** Change the client's current working directory for subsequent relative paths. */
  | "file.cd"
  /** Retrieve the client's current working directory. */
  | "file.get_cwd"
  /** Execute a shell command, optionally in the background. */
  | "command.run"
  /** Classify a shell command's risk level (safe/cautious/dangerous) before running it. */
  | "command.classify"
  /** Invoke a Model Context Protocol tool exposed by the client. */
  | "mcp.call";

/**
 * Standard response envelope wrapping the result of any client operation.
 *
 * @remarks
 * Every response the client sends back over the bridge — regardless of which
 * {@link ClientRoute} was invoked — is wrapped in this shape. Callers should check
 * `ok` before trusting `data`: a `false` value means the operation failed and `error`
 * should contain a human-readable explanation, while `data` should be treated as absent.
 *
 * This envelope is deliberately generic (`T` defaults to `unknown`) since different
 * routes return different payload shapes — callers supply the expected `data` type
 * at the call site (e.g. `ClientOpResponse<{ content: string }>` for `file.read`).
 *
 * @example
 * ```ts
 * const response: ClientOpResponse<{ content: string }> = await bridge.request(
 *   sessionId,
 *   "file.read",
 *   { path: "package.json" },
 * );
 *
 * if (response.ok) {
 *   console.log(response.data?.content);
 * } else {
 *   console.error("Read failed:", response.error);
 * }
 * ```
 */
export type ClientOpResponse<T = unknown> = {
  /** Whether the operation succeeded. When false, `data` is absent and `error` explains why. */
  ok: boolean;
  /** The operation's result payload. Only meaningful when `ok` is true. */
  data?: T;
  /** Human-readable failure reason. Only present when `ok` is false. */
  error?: string;
};
