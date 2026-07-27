/**
 * Workspace root and cwd slash commands: `/workspace` and `/cwd`.
 *
 * @remarks
 * `/workspace set` updates persisted config and the live {@link LocalFileProxy}
 * root together so the sandbox and prompt stay aligned.
 */

import { updateConfig } from "../config/index.js";
import type { LocalFileProxy } from "../localFileProxy.js";
import { printError, printLine, printSuccessOp } from "../renderer.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Handles `/workspace set <path>` — changes the client workspace root.
 *
 * @remarks
 * Expands a leading `~` to the home directory, resolves to absolute, and
 * requires an existing directory. Then updates config, calls
 * `fileProxy.setWorkspaceRoot` when available, and fires `onPromptUpdate`.
 *
 * @param sub - Must be `"set"`; anything else prints usage.
 * @param arg - Path to the new workspace directory.
 * @param fileProxy - Optional live proxy to update in-process.
 * @param onPromptUpdate - Optional UI callback after a successful change.
 *
 * @example
 * ```ts
 * await handleWorkspace("set", "~/code/my-app", fileProxy, refreshPrompt);
 * ```
 */
export const handleWorkspace = async (
  sub: string,
  arg: string,
  fileProxy: LocalFileProxy | undefined,
  onPromptUpdate: (() => void) | undefined,
): Promise<void> => {
  if (sub !== "set") {
    printError("Usage: /workspace set <path>");
    return;
  }

  const rawPath = arg.trim();
  if (!rawPath) {
    printError("Usage: /workspace set <path>");
    return;
  }

  // Shell-style ~ expansion so "/workspace set ~/proj" works without the shell.
  const expandedPath = rawPath.startsWith("~")
    ? path.join(os.homedir(), rawPath.slice(1))
    : rawPath;
  const resolvedPath = path.resolve(expandedPath);

  try {
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      printError("Path is not a directory.");
      return;
    }
  } catch {
    printError(`Directory not found: ${resolvedPath}`);
    return;
  }

  updateConfig({ workspace: resolvedPath });
  fileProxy?.setWorkspaceRoot(resolvedPath);
  printSuccessOp(`Workspace set to ${resolvedPath}`);
  onPromptUpdate?.();
};

/**
 * Handles `/cwd` — prints the active working directory inside the workspace.
 *
 * @remarks
 * Prefers {@link LocalFileProxy.getCwd} when the proxy exists (tracks `cd` via
 * the file proxy). Falls back to `process.cwd()` before a proxy is attached.
 *
 * @param fileProxy - Optional file proxy instance.
 *
 * @example
 * ```ts
 * handleCwd(fileProxy); // "  /Users/…/project/src"
 * ```
 */
export const handleCwd = (fileProxy: LocalFileProxy | undefined): void => {
  const currentWorkingDirectory = fileProxy?.getCwd() ?? process.cwd();
  printLine(`  ${currentWorkingDirectory}`);
};
