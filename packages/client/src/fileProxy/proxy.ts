/**
 * {@link LocalFileProxy} — sandboxed FS / shell / MCP facade for the client.
 *
 * @remarks
 * Wired into the RSocket file responder so the server can ask the client to
 * read/write files and run commands entirely under `workspaceRoot`.
 */

import * as path from "node:path";
import type { ClientOpResponse, ClientRoute } from "@loopycode/shared";
import {
  isTaskActive,
  startThinking,
  startWorking,
  stopAnimated,
} from "../state/agentStatus.js";
import type { BashClass } from "../renderer.js";
import { classifyCommand } from "./commandClassifier.js";
import { QUIET_PROXY_ROUTES } from "./constants.js";
import { dispatch } from "./dispatch.js";
import {
  expandDirectory as expandDirectoryImpl,
  listDirectoryEntries as listDirectoryEntriesImpl,
  listStructure as listStructureImpl,
} from "./directoryListing.js";
import { loadConfig } from "../config/index.js";
import { assertInsideRoot, resolveAbsolutePath } from "./pathUtils.js";
import { runShell } from "./shellRunner.js";
import { tokenSaveWorkingLabel } from "../mcp/tokenSaveLabels.js";
import type { DispatchContext } from "./types.js";

/**
 * Builds a short working-spinner label for long-running proxy routes.
 *
 * @param route - Client route id.
 * @param payload - Request body (may include `path`, `command`, MCP fields).
 * @returns Label string, or `null` when the route should use the generic `"Agent"`.
 */
const workingLabelForRoute = (
  route: string,
  payload: unknown,
): string | null => {
  const body = payload as Record<string, unknown>;
  const path = String(body.path ?? "").trim();
  switch (route) {
    case "file.read":
      return path ? `Reading ${path}` : "Reading file";
    case "file.write":
      return path ? `Writing ${path}` : "Writing file";
    case "file.create_dir":
      return path ? `Creating ${path}` : "Creating directory";
    case "file.delete_file":
      return path ? `Deleting ${path}` : "Deleting file";
    case "command.run": {
      const command = String(body.command ?? "").trim();
      if (!command) return "Running command";
      // Truncate so the status line stays readable for long command strings.
      return command.length > 56
        ? `Running ${command.slice(0, 56)}…`
        : `Running ${command}`;
    }
    case "mcp.call": {
      const tool = String(body.tool ?? "").trim();
      const args = (body.arguments ?? {}) as Record<string, unknown>;
      return tokenSaveWorkingLabel(tool, args);
    }
    default:
      return null;
  }
};

/**
 * Secure local workspace proxy for file, shell, and allow-listed MCP routes.
 *
 * @remarks
 * Holds the workspace root + current directory, validates every path against
 * the root, and exposes {@link handle} as the single entry used by the RSocket
 * responder. Mutating handlers perform their own approval UI; this class wraps
 * dispatch in a {@link ClientOpResponse} envelope and manages working/thinking
 * spinners (skipped for {@link QUIET_PROXY_ROUTES}).
 *
 * Call {@link setSessionAbortSignal} after connect so long shell runs abort when
 * the RSocket session drops.
 *
 * @example
 * ```ts
 * const proxy = new LocalFileProxy("/home/user/project", (cwd) => {
 *   console.log("cwd →", cwd);
 * });
 * proxy.setSessionAbortSignal(() => connection.getSessionAbortSignal());
 *
 * const result = await proxy.handle("file.read", { path: "README.md" });
 * if (result.ok) console.log(result.data);
 * ```
 */
export class LocalFileProxy {
  /** Absolute sandbox root — ceiling for all path operations. */
  private workspaceRoot: string;

  /** Absolute cwd for relative paths and shell `cwd` (starts at the root). */
  private currentDir: string;

  /**
   * Lazy getter for the live RSocket session abort signal.
   * Re-read on each shell run so reload/reconnect picks up a new controller.
   */
  private sessionAbortSignal?: () => AbortSignal | undefined;

  /**
   * Creates a proxy bound to `workspaceRoot` (resolved absolute).
   *
   * @param workspaceRoot - Workspace path (relative or absolute).
   * @param onCwdChanged - Optional UI callback when cwd changes.
   */
  constructor(
    workspaceRoot: string,
    private readonly onCwdChanged?: (cwd: string) => void,
  ) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.currentDir = this.workspaceRoot;
  }

  /**
   * Returns the current working directory inside the workspace.
   *
   * @returns Absolute cwd path.
   */
  getCwd = (): string => this.currentDir;

  /**
   * Returns the absolute workspace root (sandbox ceiling).
   *
   * @returns Absolute root path.
   */
  getWorkspaceRoot = (): string => this.workspaceRoot;

  /**
   * Replaces the workspace root and resets cwd to that root.
   *
   * @remarks
   * Notifies {@link onCwdChanged} so prompts update. Does not migrate open
   * relative state beyond resetting cwd to the new root.
   *
   * @param workspacePath - New workspace path (resolved absolute).
   */
  setWorkspaceRoot = (workspacePath: string): void => {
    const resolvedWorkspacePath = path.resolve(workspacePath);
    this.workspaceRoot = resolvedWorkspacePath;
    // Drop any prior subdirectory cwd — it may not exist under the new root.
    this.currentDir = resolvedWorkspacePath;
    this.onCwdChanged?.(this.currentDir);
  };

  /**
   * Wires the RSocket session abort getter used by shell execution.
   *
   * @param signalGetter - Returns the current session `AbortSignal`, if any.
   */
  setSessionAbortSignal = (
    signalGetter: () => AbortSignal | undefined,
  ): void => {
    this.sessionAbortSignal = signalGetter;
  };

  /**
   * Resolves a relative path against cwd and asserts it stays in the root.
   *
   * @param relativePath - Path relative to {@link getCwd} (absolute rejected).
   * @returns Absolute path under the workspace.
   * @throws {@link Error} When absolute or outside the root.
   */
  resolveAbsolute = (relativePath: string): string =>
    resolveAbsolutePath(this.workspaceRoot, this.currentDir, relativePath);

  /**
   * Classifies a shell command for approval UI (`safe` / `dangerous` / `cautious`).
   *
   * @param command - Full command line.
   * @returns Heuristic {@link BashClass}.
   */
  classifyCommand = (command: string): BashClass => classifyCommand(command);

  /**
   * Dispatches one client route and returns a {@link ClientOpResponse} envelope.
   *
   * @remarks
   * - If the session abort signal is already aborted → `{ ok: false, error: "Connection lost" }`
   *   without running the handler.
   * - Quiet routes skip the working spinner.
   * - Handler throws become `{ ok: false, error: message }` (never thrown to the responder).
   * - `finally` restores thinking spinner if a task is still active, else stops animation.
   *
   * @param route - Wire route string (cast to {@link ClientRoute} for dispatch).
   * @param payload - JSON body for the handler.
   * @returns Success `{ ok: true, data }` or failure `{ ok: false, error }`.
   *
   * @example
   * ```ts
   * const res = await proxy.handle("command.run", { command: "ls" });
   * if (!res.ok) console.error(res.error);
   * ```
   */
  handle = async (
    route: string,
    payload: unknown,
  ): Promise<ClientOpResponse> => {
    const abortSignal = this.sessionAbortSignal?.();
    if (abortSignal?.aborted) {
      return { ok: false, error: "Connection lost" };
    }

    const shouldShowWorkingSpinner = !QUIET_PROXY_ROUTES.has(route);

    if (shouldShowWorkingSpinner) {
      startWorking(workingLabelForRoute(route, payload) ?? "Agent");
    }

    try {
      const context = this.buildContext();
      const responseData = await dispatch(
        context,
        route as ClientRoute,
        payload,
      );
      return { ok: true, data: responseData };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return { ok: false, error: errorMessage };
    } finally {
      if (shouldShowWorkingSpinner) {
        // Prefer thinking over a dead spinner if the overall task is still running.
        if (isTaskActive()) {
          startThinking("Agent");
        } else {
          stopAnimated();
        }
      }
    }
  };

  /**
   * Builds an indented tree string for the current directory.
   *
   * @param depth - Max nesting depth for {@link listStructure}.
   * @returns Tree text.
   */
  listStructure = async (depth: number): Promise<string> =>
    listStructureImpl(
      {
        workspaceRoot: this.workspaceRoot,
        currentDir: this.currentDir,
      },
      depth,
    );

  /**
   * Lists one directory’s entries (skipping {@link SKIP_DIR_NAMES}).
   *
   * @param dirPath - Absolute or resolvable directory path.
   * @returns Name + isDirectory pairs.
   */
  listDirectoryEntries = async (
    dirPath: string,
  ): Promise<Array<{ name: string; isDirectory: boolean }>> =>
    listDirectoryEntriesImpl(this.workspaceRoot, dirPath);

  /**
   * Expands a directory in the interactive list UI.
   *
   * @param dirPath - Directory to expand.
   * @param indent - Parent row indent for nested display.
   */
  expandDirectory = async (dirPath: string, indent: number): Promise<void> =>
    expandDirectoryImpl(
      {
        workspaceRoot: this.workspaceRoot,
        listDirectoryEntries: (directoryPath: string) =>
          this.listDirectoryEntries(directoryPath),
      },
      dirPath,
      indent,
    );

  /**
   * Snapshot of workspace state + helpers passed into {@link dispatch}.
   *
   * @remarks
   * `runShell` always uses the **current** `currentDir`, config timeout, and
   * latest session abort signal at call time.
   *
   * @returns Fresh {@link DispatchContext} for one `handle` invocation.
   */
  private buildContext = (): DispatchContext => ({
    workspaceRoot: this.workspaceRoot,
    currentDir: this.currentDir,
    resolveAbsolute: this.resolveAbsolute,
    setCurrentDir: (absolutePath: string) => {
      assertInsideRoot(this.workspaceRoot, absolutePath);
      this.currentDir = absolutePath;
      this.onCwdChanged?.(absolutePath);
    },
    classifyCommand: this.classifyCommand,
    runShell: (command: string) =>
      runShell(
        command,
        this.currentDir,
        loadConfig().shellTimeoutMs,
        this.sessionAbortSignal?.(),
      ),
    listStructure: this.listStructure,
    onCwdChanged: this.onCwdChanged,
  });
}
