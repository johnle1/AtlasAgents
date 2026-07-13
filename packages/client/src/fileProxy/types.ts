/**
 * Shared contracts for the client local file-proxy (workspace FS + shell).
 *
 * @remarks
 * {@link DispatchContext} is the bag of state and helpers every route handler
 * receives from {@link LocalFileProxy}. {@link ShellResult} is the stdout /
 * stderr / exit-code shape returned by shell execution.
 */

import type { BashClass } from "../renderer.js";

/**
 * Captured result of one shell process started by {@link runShell}.
 *
 * @remarks
 * `exitCode` uses `-1` when the OS did not report a code (killed, aborted, or
 * otherwise unavailable). Stdout may briefly contain a CWD tracking marker
 * before handlers strip it — see {@link extractCwdFromOutput}.
 *
 * @example
 * ```ts
 * const result: ShellResult = {
 *   stdout: "ok\n",
 *   stderr: "",
 *   exitCode: 0,
 * };
 * ```
 */
export type ShellResult = {
  /**
   * UTF-8 combined stdout from the child process.
   *
   * @remarks
   * After CWD wrapping, may include a trailing `##LOOPY_CWD##…` segment until
   * command handlers strip it for display and persistence.
   */
  stdout: string;

  /**
   * UTF-8 combined stderr from the child process.
   *
   * @remarks
   * Timeout kills append a `[TIMEOUT]` line (see {@link SHELL_TIMEOUT_MARKER}).
   * Aborts put a cancellation message here with `exitCode: -1`.
   */
  stderr: string;

  /**
   * Process exit status.
   *
   * @remarks
   * - `0` — success (by convention)
   * - `1`–`255` — failure from the command
   * - `-1` — no exit code (timeout kill, abort, or missing code)
   */
  exitCode: number;
};

/**
 * Runtime context injected into every file-proxy route handler.
 *
 * @remarks
 * Built by `LocalFileProxy.buildContext()` for each {@link LocalFileProxy.handle}
 * call so handlers stay free of the proxy class while still enforcing the
 * workspace root sandbox, shared shell runner, and cwd callbacks.
 *
 * **Security:** `resolveAbsolute` and `setCurrentDir` must keep paths inside
 * `workspaceRoot`. Never bypass them with raw `path.resolve` in handlers.
 *
 * @example
 * ```ts
 * // Handlers receive context from dispatch — do not construct this manually
 * // unless writing tests:
 * const abs = context.resolveAbsolute("src/index.ts");
 * const classification = context.classifyCommand("git status");
 * ```
 */
export type DispatchContext = {
  /**
   * Absolute workspace root — the sandbox ceiling for all file and cwd ops.
   *
   * @remarks
   * Paths that normalize outside this directory throw via {@link assertInsideRoot}.
   */
  workspaceRoot: string;

  /**
   * Absolute current working directory used for relative paths and shell `cwd`.
   *
   * @remarks
   * Starts as `workspaceRoot`, then moves via `file.cd` or CWD tracking after
   * shell commands that change directory.
   */
  currentDir: string;

  /**
   * Resolves a **relative** path against {@link currentDir} and asserts it stays
   * inside {@link workspaceRoot}.
   *
   * @param relativePath - Path relative to `currentDir` (absolute inputs rejected).
   * @returns Absolute path known to be under `workspaceRoot`.
   * @throws {@link Error} When the path is absolute, empty, or escapes the root.
   */
  resolveAbsolute: (relativePath: string) => string;

  /**
   * Sets {@link currentDir} after asserting `absolutePath` is inside the root.
   *
   * @remarks
   * Invokes {@link onCwdChanged} when present so the CLI prompt can update.
   *
   * @param absolutePath - Absolute directory already validated or about to be checked.
   * @throws {@link Error} When the path escapes {@link workspaceRoot}.
   */
  setCurrentDir: (absolutePath: string) => void;

  /**
   * Heuristic safety class for a shell command string.
   *
   * @param command - Full command line, e.g. `"rm -rf build"`.
   * @returns `"safe"` | `"dangerous"` | `"cautious"` (see {@link classifyCommand}).
   */
  classifyCommand: (command: string) => BashClass;

  /**
   * Runs `command` with shell `cwd` = {@link currentDir}.
   *
   * @remarks
   * Honors configured timeout and optional session {@link AbortSignal}. Does not
   * perform approval UI — callers decide when to prompt.
   *
   * @param command - Shell command line (may already be CWD-wrapped).
   * @returns Captured {@link ShellResult}.
   */
  runShell: (command: string) => Promise<ShellResult>;

  /**
   * Builds an indented directory tree text under {@link currentDir}.
   *
   * @param depth - Max nesting levels to include (`1` = immediate children only).
   * @returns Multi-line tree string (also updates list UI side channels).
   */
  listStructure: (depth: number) => Promise<string>;

  /**
   * Optional UI hook when the sandbox cwd changes.
   *
   * @param cwd - New absolute current directory.
   */
  onCwdChanged?: (cwd: string) => void;
};
