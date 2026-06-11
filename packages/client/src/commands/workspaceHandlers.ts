/**
 * Workspace-related command handlers.
 *
 * This module handles commands for managing workspace and current directory:
 * - /workspace set
 * - /cwd
 */

import { updateConfig } from "../config.js";
import type { LocalFileProxy } from "../localFileProxy.js";
import { printError, printLine, printSuccessOp } from "../renderer.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * <Summary>
 * What it does:
 *   Handles "/workspace set" to change the workspace directory.
 *
 * How it does it (step by step):
 *   1. Validates that subcommand is "set".
 *   2. Expands tilde (~) to home directory if present.
 *   3. Resolves the path to an absolute path.
 *   4. Validates that the path exists and is a directory.
 *   5. Updates config with the new workspace path.
 *   6. Updates file proxy and prompts if available.
 *
 * Parameters:
 *   @param {string} sub — Subcommand: must be "set".
 *   @param {string} arg — Path to the workspace directory.
 *   @param {LocalFileProxy | undefined} fileProxy — Optional file proxy instance.
 *   @param {(() => void) | undefined} onPromptUpdate — Optional callback for prompt updates.
 *
 * Returns:
 *   @returns {Promise<void>} — called for side effects only.
 *
 * Dependencies:
 *   - updateConfig — writes workspace to config.
 *   - LocalFileProxy.setWorkspaceRoot — updates file proxy workspace.
 *   - path, os, fs — path manipulation and validation.
 *   - renderer.printError, printSuccessOp — display output.
 *
 * Dependants:
 *   - CommandHandler.handle — calls this for /workspace commands.
 * </Summary>
 */
export const handleWorkspace = async (
  sub: string,
  arg: string,
  fileProxy: LocalFileProxy | undefined,
  onPromptUpdate: (() => void) | undefined,
): Promise<void> => {
  // Validate that subcommand is "set"
  if (sub !== "set") {
    printError("Usage: /workspace set <path>");
    return;
  }
  const rawPath = arg.trim();
  if (!rawPath) {
    printError("Usage: /workspace set <path>");
    return;
  }
  // Expand tilde (~) to home directory if present
  const expandedPath = rawPath.startsWith("~")
    ? path.join(os.homedir(), rawPath.slice(1))
    : rawPath;
  // Resolve to absolute path
  const resolvedPath = path.resolve(expandedPath);
  try {
    // Validate that the path exists and is a directory
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      printError("Path is not a directory.");
      return;
    }
  } catch {
    printError(`Directory not found: ${resolvedPath}`);
    return;
  }
  // Update config with new workspace path
  updateConfig({ workspace: resolvedPath });
  fileProxy?.setWorkspaceRoot(resolvedPath);
  printSuccessOp(`Workspace set to ${resolvedPath}`);
  onPromptUpdate?.();
};

/**
 * <Summary>
 * What it does:
 *   Handles "/cwd" to display the current working directory.
 *
 * How it does it (step by step):
 *   1. Gets the current working directory from file proxy or process.
 *   2. Prints the directory path to the console.
 *
 * Parameters:
 *   @param {LocalFileProxy | undefined} fileProxy — Optional file proxy instance.
 *
 * Returns:
 *   @returns {void} — called for side effects only.
 *
 * Dependencies:
 *   - LocalFileProxy.getCwd — gets current directory from file proxy.
 *   - process.cwd — fallback to process current directory.
 *   - renderer.printLine — displays the path.
 *
 * Dependants:
 *   - CommandHandler.handle — calls this for /cwd command.
 * </Summary>
 */
export const handleCwd = (
  fileProxy: LocalFileProxy | undefined,
): void => {
  // Get current working directory from file proxy or process
  const currentWorkingDirectory = fileProxy?.getCwd() ?? process.cwd();
  printLine(`  ${currentWorkingDirectory}`);
};
