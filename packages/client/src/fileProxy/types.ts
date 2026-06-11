import type { BashClass } from "../renderer.js";

/**
 * <Summary>
 * What it does:
 *   Defines the shape of data returned from shell command execution.
 *
 * Used by:
 *   - shellRunner — returns objects of this shape after command execution.
 *   - Command handlers — consume this type to process command results.
 *   - Dispatch context — includes this in the runShell function signature.
 *
 * Produced by:
 *   - runShell — creates objects of this shape after executing shell commands.
 * </Summary>
 */
export type ShellResult = {
  /** The standard output from the shell command as a UTF-8 string. */
  stdout: string;

  /** The standard error output from the shell command as a UTF-8 string. */
  stderr: string;

  /**
   * The exit code from the shell command process.
   * 0 typically indicates success, non-zero values indicate errors.
   * -1 is used when the exit code is null/undefined.
   */
  exitCode: number;
};

/**
 * <Summary>
 * What it does:
 *   Defines the shape of the context object passed to file proxy dispatch handlers.
 *
 * Used by:
 *   - dispatch — passes this context to all handler functions.
 *   - File handlers — use this context to access workspace state and utilities.
 *   - Command handlers — use this context to execute commands and validate paths.
 *
 * Produced by:
 *   - LocalFileProxy.buildContext — creates this context object for dispatch operations.
 * </Summary>
 */
export type DispatchContext = {
  /**
   * The root directory of the workspace that serves as the security boundary.
   * All file operations must stay within this directory.
   */
  workspaceRoot: string;

  /**
   * The current working directory within the workspace.
   * Used as the base for resolving relative paths and executing commands.
   */
  currentDir: string;

  /**
   * Function to resolve a relative path to an absolute path within the workspace.
   * Validates that the resulting path stays within the workspace boundaries.
   *
   * @param relativePath — The path to resolve (can be relative or absolute).
   * @returns The validated absolute path guaranteed to be inside the workspace.
   */
  resolveAbsolute: (relativePath: string) => string;

  /**
   * Function to change the current working directory.
   * Validates that the new path is inside the workspace before updating.
   *
   * @param absolutePath — The absolute path to set as the current directory.
   */
  setCurrentDir: (absolutePath: string) => void;

  /**
   * Function to classify a shell command's safety level.
   * Returns "safe", "dangerous", or "cautious" based on command analysis.
   *
   * @param command — The shell command to classify.
   * @returns The safety classification of the command.
   */
  classifyCommand: (command: string) => BashClass;

  /**
   * Function to execute a shell command in the current directory.
   * Returns stdout, stderr, and exit code from the command execution.
   *
   * @param command — The shell command to execute.
   * @returns Promise resolving to the command execution results.
   */
  runShell: (command: string) => Promise<ShellResult>;

  /**
   * Function to generate a hierarchical directory structure string.
   * Returns a tree-like representation of directories up to a specified depth.
   *
   * @param depth — Maximum depth to traverse (0 = current directory only).
   * @returns Promise resolving to the directory structure string.
   */
  listStructure: (depth: number) => Promise<string>;

  /**
   * Optional callback function called when the current working directory changes.
   * Used to notify UI components or other listeners of directory changes.
   *
   * @param cwd — The new current working directory path.
   */
  onCwdChanged?: (cwd: string) => void;
};
