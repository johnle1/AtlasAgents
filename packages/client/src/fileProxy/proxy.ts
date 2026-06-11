import * as path from "node:path";
import type { ClientOpResponse, ClientRoute } from "@loopycode/shared";
import {
  isTaskActive,
  startThinking,
  startWorking,
  stopAnimated,
} from "../agentStatus.js";
import type { BashClass } from "../renderer.js";
import { classifyCommand } from "./commandClassifier.js";
import { QUIET_PROXY_ROUTES } from "./constants.js";
import { dispatch } from "./dispatch.js";
import {
  expandDirectory as expandDirectoryImpl,
  listDirectoryEntries as listDirectoryEntriesImpl,
  listStructure as listStructureImpl,
} from "./directoryListing.js";
import { loadConfig } from "../config.js";
import { assertInsideRoot, resolveAbsolutePath } from "./pathUtils.js";
import { runShell } from "./shellRunner.js";
import type { DispatchContext } from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Provides a secure interface for file system operations and command execution within a workspace.
 *
 * How it fits in the system:
 *   Acts as the central coordination point between the agent/client and local file system operations.
 *   Manages workspace state, validates paths, routes requests to handlers, and provides UI feedback.
 *   Ensures all operations stay within workspace boundaries and handles errors consistently.
 *
 * Dependencies:
 *   - classifyCommand — assesses command safety levels.
 *   - dispatch — routes requests to appropriate handlers.
 *   - directoryListing functions — provide directory traversal capabilities.
 *   - pathUtils — provides path validation and resolution.
 *   - shellRunner — executes shell commands.
 *   - agentStatus — manages UI state (spinners, indicators).
 *
 * Dependants:
 *   - Agent/client code — instantiates this class to perform file operations.
 *   - UI components — use this class for directory browsing and file operations.
 * </Summary>
 */
export class LocalFileProxy {
  /**
   * <Summary>
   * What it does:
   *   The root directory of the workspace that serves as the security boundary.
   *
   * Used by:
   *   - All file operations — ensures paths stay within this boundary.
   *   - Path validation functions — validates paths against this root.
   *
   * Produced by:
   *   - constructor — initializes from provided workspace path.
   *   - setWorkspaceRoot — updates when workspace is changed.
   * </Summary>
   */
  private workspaceRoot: string;

  /**
   * <Summary>
   * What it does:
   *   The current working directory within the workspace.
   *
   * Used by:
   *   - Path resolution — used as base for relative paths.
   *   - Directory operations — determines where operations are performed.
   *   - Shell execution — sets the working directory for commands.
   *
   * Produced by:
   *   - constructor — initializes to workspace root.
   *   - setCurrentDir — updated by handlers when changing directories.
   * </Summary>
   */
  private currentDir: string;

  /**
   * <Summary>
   * What it does:
   *   Initializes the LocalFileProxy with a workspace root and optional directory change callback.
   *
   * How it does it (step by step):
   *   1. Resolve the provided workspace path to an absolute path.
   *   2. Store the resolved path as the workspace root.
   *   3. Set the current directory to the workspace root initially.
   *   4. Store the optional callback for directory change notifications.
   *
   * Parameters:
   *   @param {string} workspaceRoot — The root directory of the workspace (can be relative or absolute).
   *   @param {(cwd: string) => void} onCwdChanged — Optional callback called when current directory changes.
   *
   * Dependencies:
   *   - node:path — provides path.resolve() for absolute path conversion.
   *
   * Dependants:
   *   - Agent/client code — creates instance to interact with file system.
   * </Summary>
   */
  constructor(
    workspaceRoot: string,
    private readonly onCwdChanged?: (cwd: string) => void,
  ) {
    // ===== STEP 1: Resolve workspace root to absolute path =====
    // Step 1a: Convert the provided workspace path to an absolute path
    // Step 1b: This ensures consistent path handling regardless of input format
    this.workspaceRoot = path.resolve(workspaceRoot);

    // ===== STEP 2: Initialize current directory =====
    // Step 2a: Set the current directory to the workspace root initially
    // Step 2b: User can navigate within the workspace starting from root
    this.currentDir = this.workspaceRoot;
  }

  /**
   * <Summary>
   * What it does:
   *   Returns the current working directory.
   *
   * How it does it (step by step):
   *   1. Return the currentDir field value.
   *
   * Returns:
   *   @returns {string} — The current working directory path.
   *
   * Dependencies:
   *   - None (simple field access).
   *
   * Dependants:
   *   - UI components — display current directory to user.
   *   - Path resolution functions — use as base for relative paths.
   * </Summary>
   */
  getCwd = (): string => this.currentDir;

  /**
   * <Summary>
   * What it does:
   *   Changes the workspace root and resets the current directory to the new root.
   *
   * How it does it (step by step):
   *   1. Resolve the provided workspace path to an absolute path.
   *   2. Update the workspace root field with the resolved path.
   *   3. Reset the current directory to the new workspace root.
   *   4. Call the onCwdChanged callback if provided to notify listeners.
   *
   * Parameters:
   *   @param {string} workspacePath — The new workspace root directory (can be relative or absolute).
   *
   * Returns:
   *   @returns {void} — Returns after updating state and notifying listeners.
   *
   * Dependencies:
   *   - node:path — provides path.resolve() for absolute path conversion.
   *
   * Dependants:
   *   - Workspace management code — uses this to switch between different projects.
   * </Summary>
   */
  setWorkspaceRoot = (workspacePath: string): void => {
    // ===== STEP 1: Resolve workspace path to absolute =====
    // Step 1a: Convert the provided workspace path to an absolute path
    const resolvedWorkspacePath = path.resolve(workspacePath);

    // ===== STEP 2: Update workspace root =====
    // Step 2a: Set the workspace root to the resolved path
    this.workspaceRoot = resolvedWorkspacePath;

    // ===== STEP 3: Reset current directory =====
    // Step 3a: Reset current directory to the new workspace root
    // Step 3b: This ensures we start at the root of the new workspace
    this.currentDir = resolvedWorkspacePath;

    // ===== STEP 4: Notify listeners =====
    // Step 4a: Call the callback if provided to notify of directory change
    this.onCwdChanged?.(this.currentDir);
  };

  /**
   * <Summary>
   * What it does:
   *   Resolves a relative path to an absolute path within the workspace.
   *
   * How it does it (step by step):
   *   1. Call the resolveAbsolutePath utility with workspace root, current directory, and the relative path.
   *   2. The utility validates the path stays within workspace boundaries.
   *   3. Return the validated absolute path.
   *
   * Parameters:
   *   @param {string} relativePath — The path to resolve (can be relative or absolute).
   *
   * Returns:
   *   @returns {string} — The validated absolute path guaranteed to be inside the workspace.
   *
   * Dependencies:
   *   - resolveAbsolutePath — performs the actual path resolution and validation.
   *
   * Dependants:
   *   - Path consumers — use this to safely resolve user-provided paths.
   * </Summary>
   */
  resolveAbsolute = (relativePath: string): string =>
    resolveAbsolutePath(this.workspaceRoot, this.currentDir, relativePath);

  /**
   * <Summary>
   * What it does:
   *   Classifies a shell command's safety level (safe, dangerous, or cautious).
   *
   * How it does it (step by step):
   *   1. Call the classifyCommand utility with the provided command string.
   *   2. The utility analyzes the command for dangerous patterns and safe operations.
   *   3. Return the classification result.
   *
   * Parameters:
   *   @param {string} command — The shell command to classify (e.g., "rm -rf file.txt").
   *
   * Returns:
   *   @returns {BashClass} — One of "safe", "dangerous", or "cautious" indicating the command's risk level.
   *
   * Dependencies:
   *   - classifyCommand — performs the actual command analysis.
   *
   * Dependants:
   *   - Command execution handlers — use this to determine if user confirmation is needed.
   * </Summary>
   */
  classifyCommand = (command: string): BashClass => classifyCommand(command);

  /**
   * <Summary>
   * What it does:
   *   Handles incoming proxy requests by routing them to appropriate handlers with UI feedback.
   *
   * How it does it (step by step):
   *   1. Check if the route is a quiet route that doesn't need a working spinner.
   *   2. If not quiet, start the working spinner to show activity.
   *   3. Build the dispatch context with current state and utilities.
   *   4. Dispatch the request to the appropriate handler via the dispatch system.
   *   5. Return success response with the handler's data.
   *   6. If an error occurs, return error response with the error message.
   *   7. In the finally block, restore UI state based on task activity.
   *
   * Parameters:
   *   @param {string} route — The route identifier that determines which handler to call.
   *   @param {unknown} payload — The request payload containing parameters for the handler.
   *
   * Returns:
   *   @returns {Promise<ClientOpResponse>} — Standardized response with ok status and either data or error.
   *
   * Dependencies:
   *   - dispatch — routes the request to the appropriate handler.
   *   - buildContext — creates the dispatch context.
   *   - QUIET_PROXY_ROUTES — determines if spinner is needed.
   *   - agentStatus functions — manage UI state (startWorking, startThinking, stopAnimated).
   *   - isTaskActive — checks if there's an active task for UI state restoration.
   *
   * Dependants:
   *   - Agent/client code — calls this to execute file operations and commands.
   * </Summary>
   */
  handle = async (
    route: string,
    payload: unknown,
  ): Promise<ClientOpResponse> => {
    // ===== STEP 1: Determine if UI feedback is needed =====
    // Step 1a: Check if this route is a quiet route (instant metadata operations)
    // Step 1b: Quiet routes don't need spinners because they complete instantly
    const shouldShowWorkingSpinner = !QUIET_PROXY_ROUTES.has(route);

    // ===== STEP 2: Start working indicator =====
    // Step 2a: If this route needs UI feedback, start the working spinner
    if (shouldShowWorkingSpinner) {
      startWorking("Agent");
    }

    try {
      // ===== STEP 3: Build dispatch context =====
      // Step 3a: Create the dispatch context with current workspace state
      // Step 3b: This context is passed to all handlers for state access
      const context = this.buildContext();

      // ===== STEP 4: Dispatch request to handler =====
      // Step 4a: Call the dispatch system to route the request to the appropriate handler
      // Step 4b: The handler performs the actual operation and returns data
      const responseData = await dispatch(
        context,
        route as ClientRoute,
        payload,
      );

      // ===== STEP 5: Return success response =====
      // Step 5a: Return standardized success response with the handler's data
      return { ok: true, data: responseData };
    } catch (error) {
      // ===== STEP 6: Handle errors =====
      // Step 6a: Extract error message from Error object or convert to string
      // Step 6b: Return standardized error response with the error message
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return { ok: false, error: errorMessage };
    } finally {
      // ===== STEP 7: Restore UI state =====
      // Step 7a: If we showed a working spinner, restore the appropriate UI state
      if (shouldShowWorkingSpinner) {
        // Step 7b: Check if there's still an active task running
        if (isTaskActive()) {
          // Step 7c: If task is active, switch to thinking indicator
          startThinking("Agent");
        } else {
          // Step 7d: If no active task, stop all animated indicators
          stopAnimated();
        }
      }
    }
  };

  /**
   * <Summary>
   * What it does:
   *   Generates a hierarchical string representation of the directory structure up to a specified depth.
   *
   * How it does it (step by step):
   *   1. Build a context object with workspace root and current directory.
   *   2. Call the listStructure implementation with the context and depth parameter.
   *   3. Return the generated directory structure string.
   *
   * Parameters:
   *   @param {number} depth — Maximum depth to traverse (0 = current directory only, 1 = one level deep, etc.).
   *
   * Returns:
   *   @returns {Promise<string>} — String representation of the directory structure with indentation.
   *
   * Dependencies:
   *   - listStructureImpl — performs the actual directory traversal and structure generation.
   *
   * Dependants:
   *   - Directory listing commands — use this to display project structure to users.
   * </Summary>
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
   * <Summary>
   * What it does:
   *   Lists the entries in a directory, returning their names and directory status.
   *
   * How it does it (step by step):
   *   1. Call the listDirectoryEntries implementation with workspace root and directory path.
   *   2. The implementation validates the path and reads the directory contents.
   *   3. Return the array of entry objects with name and isDirectory properties.
   *
   * Parameters:
   *   @param {string} dirPath — The directory path to list (can be relative or absolute).
   *
   * Returns:
   *   @returns {Promise<Array<{ name: string; isDirectory: boolean }>>} — Array of entry objects.
   *
   * Dependencies:
   *   - listDirectoryEntriesImpl — performs the actual directory listing.
   *
   * Dependants:
   *   - expandDirectory — uses this to get entries when expanding a directory.
   *   - Directory browsing commands — use this to display directory contents.
   * </Summary>
   */
  listDirectoryEntries = async (
    dirPath: string,
  ): Promise<Array<{ name: string; isDirectory: boolean }>> =>
    listDirectoryEntriesImpl(this.workspaceRoot, dirPath);

  /**
   * <Summary>
   * What it does:
   *   Expands a directory in the UI by listing its contents and marking it as expanded.
   *
   * How it does it (step by step):
   *   1. Build a context object with workspace root and a bound listDirectoryEntries function.
   *   2. Call the expandDirectory implementation with the context, directory path, and indent level.
   *   3. The implementation lists the entries and displays them with proper indentation.
   *   4. Return when the directory has been expanded and entries displayed.
   *
   * Parameters:
   *   @param {string} dirPath — The directory path to expand.
   *   @param {number} indent — The indentation level to use for displaying the entries.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the directory has been expanded.
   *
   * Dependencies:
   *   - expandDirectoryImpl — performs the actual directory expansion.
   *   - listDirectoryEntries — provides the bound function for getting directory contents.
   *
   * Dependants:
   *   - Directory expansion commands — use this when a user expands a directory in the file browser.
   * </Summary>
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
   * <Summary>
   * What it does:
   *   Builds the dispatch context object containing workspace state and utility functions.
   *
   * How it does it (step by step):
   *   1. Create an object with workspace root and current directory.
   *   2. Add the resolveAbsolute utility function for path resolution.
   *   3. Add the setCurrentDir function that validates and updates the current directory.
   *   4. Add the classifyCommand function for command safety assessment.
   *   5. Add the runShell function bound to the current directory.
   *   6. Add the listStructure function for directory structure generation.
   *   7. Add the onCwdChanged callback for directory change notifications.
   *   8. Return the complete context object.
   *
   * Returns:
   *   @returns {DispatchContext} — The complete dispatch context with all required state and utilities.
   *
   * Dependencies:
   *   - assertInsideRoot — validates paths in setCurrentDir.
   *   - runShell — executes shell commands.
   *   - classifyCommand — assesses command safety.
   *   - resolveAbsolute — resolves paths.
   *   - listStructure — generates directory structures.
   *
   * Dependants:
   *   - handle — calls this to create context for dispatching requests.
   * </Summary>
   */
  private buildContext = (): DispatchContext => ({
    // ===== STEP 1: Add workspace state =====
    // Step 1a: Include workspace root for security boundary validation
    workspaceRoot: this.workspaceRoot,
    // Step 1b: Include current directory for path resolution and operations
    currentDir: this.currentDir,

    // ===== STEP 2: Add path utilities =====
    // Step 2a: Include path resolution function for safe path handling
    resolveAbsolute: this.resolveAbsolute,

    // ===== STEP 3: Add directory change handler =====
    // Step 3a: Include function to change current directory with validation
    setCurrentDir: (absolutePath: string) => {
      // Step 3b: Validate the new path is inside workspace root
      assertInsideRoot(this.workspaceRoot, absolutePath);
      // Step 3c: Update the current directory field
      this.currentDir = absolutePath;
      this.onCwdChanged?.(absolutePath);
    },

    // ===== STEP 4: Add command utilities =====
    // Step 4a: Include command classification function for safety assessment
    classifyCommand: this.classifyCommand,

    // ===== STEP 5: Add shell execution =====
    // Step 5a: Include shell execution function bound to current directory
    runShell: (command: string) =>
      runShell(command, this.currentDir, loadConfig().shellTimeoutMs),

    // ===== STEP 6: Add directory structure utility =====
    // Step 6a: Include directory structure generation function
    listStructure: this.listStructure,

    // ===== STEP 7: Add callback =====
    // Step 7a: Include directory change callback for notifications
    onCwdChanged: this.onCwdChanged,
  });
}
