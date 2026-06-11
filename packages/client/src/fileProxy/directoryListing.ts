import * as fs from "node:fs/promises";
import * as path from "node:path";
import { markExpanded, pushListDir } from "../listExpandState.js";
import { printListDir, printListDirEntries } from "../renderer.js";
import { SKIP_DIR_NAMES } from "./constants.js";
import { assertInsideRoot } from "./pathUtils.js";
import type { DispatchContext } from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Generates a hierarchical string representation of a directory structure up to a specified depth.
 *
 * How it does it (step by step):
 *   1. Print the current directory path to the console for user context.
 *   2. Push the current directory to the navigation state for tracking.
 *   3. Initialize an array to collect the directory tree lines.
 *   4. Define a recursive walk function to traverse directories.
 *   5. Start the walk from the current directory at depth level 0.
 *   6. For each directory entry, skip directories in the skip list (node_modules, .git, etc.).
 *   7. Validate the path is inside the workspace root for security.
 *   8. Add indented entry names to the lines array based on nesting level.
 *   9. Recursively walk subdirectories if depth limit not reached.
 *   10. Join all lines with newlines and return the complete structure string.
 *
 * Parameters:
 *   @param {Pick<DispatchContext, "workspaceRoot" | "currentDir">} context — Dispatch context containing
 *     workspace root path and current directory path.
 *   @param {number} depth — Maximum depth to traverse (0 = current directory only, 1 = one level deep, etc.).
 *
 * Returns:
 *   @returns {Promise<string>} — String representation of the directory structure with indentation for nesting.
 *
 * Dependencies:
 *   - printListDir — displays the current directory path to the user.
 *   - pushListDir — tracks the directory in navigation state.
 *   - SKIP_DIR_NAMES — provides list of directories to skip during traversal.
 *   - assertInsideRoot — ensures all paths remain within the workspace for security.
 *
 * Dependants:
 *   - Directory listing commands — use this to display project structure to users.
 * </Summary>
 */
export const listStructure = async (
  context: Pick<DispatchContext, "workspaceRoot" | "currentDir">,
  depth: number,
): Promise<string> => {
  // ===== STEP 1: Display current directory =====
  // Step 1a: Print the current directory path to provide context to the user
  printListDir(context.currentDir);

  // ===== STEP 2: Track directory in navigation state =====
  // Step 2a: Push the current directory to the list expand state with 0 indentation
  pushListDir(context.currentDir, 0);

  // ===== STEP 3: Initialize result array =====
  // Step 3a: Create array to store the directory tree lines
  const structureLines: string[] = [];

  // ===== STEP 4: Define recursive walk function =====
  // Step 4a: This function recursively traverses directories and builds the tree structure
  const walkDirectory = async (
    directoryPath: string,
    currentLevel: number,
  ): Promise<void> => {
    // ===== STEP 5: Check depth limit =====
    // Step 5a: Stop traversal if we've reached the maximum depth
    if (currentLevel >= depth) {
      return;
    }

    // ===== STEP 6: Read directory entries =====
    // Step 6a: Attempt to read the directory contents with file type information
    // Step 6b: Use withFileTypes: true to get isDirectory() and other metadata
    let directoryEntries;
    try {
      directoryEntries = await fs.readdir(directoryPath, {
        withFileTypes: true,
      });
    } catch {
      // Step 6c: If directory read fails (permission denied, not found, etc.), skip this directory
      return;
    }

    // ===== STEP 7: Process each directory entry =====
    // Step 7a: Iterate through all entries in the directory
    for (const entry of directoryEntries) {
      // ===== STEP 8: Skip ignored directories =====
      // Step 8a: Check if the entry name is in the skip list (node_modules, .git, etc.)
      // Step 8b: Skip these directories to avoid cluttering the output with generated files
      if (SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }

      // ===== STEP 9: Build absolute path =====
      // Step 9a: Construct the absolute path by joining directory path and entry name
      const absolutePath = path.join(directoryPath, entry.name);

      // ===== STEP 10: Security check =====
      // Step 10a: Ensure the path is inside the workspace root to prevent directory traversal attacks
      assertInsideRoot(context.workspaceRoot, absolutePath);

      // ===== STEP 11: Add indented entry to structure =====
      // Step 11a: Calculate indentation based on nesting level (2 spaces per level)
      const indentation = "  ".repeat(currentLevel);
      // Step 11b: Add the indented entry name to the structure lines
      structureLines.push(`${indentation}${entry.name}`);

      // ===== STEP 12: Recursively process subdirectories =====
      // Step 12a: If this is a directory and we haven't reached max depth, recurse into it
      if (entry.isDirectory() && currentLevel + 1 < depth) {
        await walkDirectory(absolutePath, currentLevel + 1);
      }
    }
  };

  // ===== STEP 13: Start directory traversal =====
  // Step 13a: Begin the recursive walk from the current directory at level 0
  await walkDirectory(context.currentDir, 0);

  // ===== STEP 14: Return complete structure =====
  // Step 14a: Join all lines with newlines and return the complete directory structure string
  return structureLines.join("\n");
};

/**
 * <Summary>
 * What it does:
 *   Lists the entries in a directory, returning their names and directory status.
 *
 * How it does it (step by step):
 *   1. Resolve the provided directory path to an absolute path.
 *   2. Validate the path is inside the workspace root for security.
 *   3. Read the directory contents with file type information.
 *   4. Filter out directories that should be skipped (node_modules, .git, etc.).
 *   5. Map the remaining entries to objects with name and isDirectory properties.
 *   6. Return the filtered and mapped entry list.
 *
 * Parameters:
 *   @param {string} workspaceRoot — The root directory of the workspace for security validation.
 *   @param {string} dirPath — The directory path to list (can be relative or absolute).
 *
 * Returns:
 *   @returns {Promise<Array<{ name: string; isDirectory: boolean }>>} — Array of entry objects
 *     containing the entry name and whether it's a directory.
 *
 * Dependencies:
 *   - assertInsideRoot — ensures the directory path is within the workspace.
 *   - SKIP_DIR_NAMES — provides list of directories to exclude from the listing.
 *
 * Dependants:
 *   - expandDirectory — uses this to get entries when expanding a directory in the UI.
 *   - Directory browsing commands — use this to display directory contents.
 * </Summary>
 */
export const listDirectoryEntries = async (
  workspaceRoot: string,
  dirPath: string,
): Promise<Array<{ name: string; isDirectory: boolean }>> => {
  // ===== STEP 1: Resolve to absolute path =====
  // Step 1a: Convert the directory path to an absolute path for consistent handling
  const absolutePath = path.resolve(dirPath);

  // ===== STEP 2: Security validation =====
  // Step 2a: Ensure the resolved path is inside the workspace root
  assertInsideRoot(workspaceRoot, absolutePath);

  // ===== STEP 3: Read directory contents =====
  // Step 3a: Read the directory with file type information to determine if entries are directories
  const directoryEntries = await fs.readdir(absolutePath, {
    withFileTypes: true,
  });

  // ===== STEP 4: Filter and map entries =====
  // Step 4a: Filter out directories that should be skipped (node_modules, .git, etc.)
  // Step 4b: Map the remaining entries to objects with name and isDirectory properties
  return directoryEntries
    .filter((entry) => !SKIP_DIR_NAMES.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
};

/**
 * <Summary>
 * What it does:
 *   Expands a directory in the UI by listing its contents and marking it as expanded.
 *
 * How it does it (step by step):
 *   1. Resolve the directory path to an absolute path.
 *   2. Mark the directory as expanded in the UI state.
 *   3. Get the directory entries using the provided listDirectoryEntries function.
 *   4. Print the directory entries with proper indentation for display.
 *   5. For each subdirectory found, push it to the navigation state for potential expansion.
 *
 * Parameters:
 *   @param {Pick<DispatchContext, "workspaceRoot"> & { listDirectoryEntries: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean }>> }} context —
 *     Dispatch context containing workspace root and the listDirectoryEntries function.
 *   @param {string} dirPath — The directory path to expand.
 *   @param {number} indent — The indentation level to use for displaying the entries.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the directory has been expanded and entries displayed.
 *
 * Dependencies:
 *   - markExpanded — marks the directory as expanded in the UI state.
 *   - printListDirEntries — displays the directory entries to the user.
 *   - pushListDir — tracks subdirectories in navigation state for later expansion.
 *
 * Dependants:
 *   - Directory expansion commands — use this when a user expands a directory in the file browser.
 * </Summary>
 */
export const expandDirectory = async (
  context: Pick<DispatchContext, "workspaceRoot"> & {
    listDirectoryEntries: (
      dirPath: string,
    ) => Promise<Array<{ name: string; isDirectory: boolean }>>;
  },
  dirPath: string,
  indent: number,
): Promise<void> => {
  // ===== STEP 1: Resolve to absolute path =====
  // Step 1a: Convert the directory path to an absolute path for consistent handling
  const absolutePath = path.resolve(dirPath);

  // ===== STEP 2: Mark directory as expanded =====
  // Step 2a: Mark this directory as expanded in the UI state so it stays open
  markExpanded(absolutePath);

  // ===== STEP 3: Get directory entries =====
  // Step 3a: Use the provided listDirectoryEntries function to get the directory contents
  const directoryEntries = await context.listDirectoryEntries(absolutePath);

  // ===== STEP 4: Display directory entries =====
  // Step 4a: Print the directory entries with increased indentation (indent + 4 spaces)
  // Step 4b: This creates a visual hierarchy showing the expanded contents
  printListDirEntries(
    directoryEntries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
    })),
    indent + 4,
  );

  // ===== STEP 5: Track subdirectories for navigation =====
  // Step 5a: Iterate through all directory entries
  for (const entry of directoryEntries) {
    // ===== STEP 6: Add subdirectories to navigation state =====
    // Step 6a: If this entry is a directory, add it to the navigation state
    // Step 6b: This allows the user to expand these subdirectories later
    if (entry.isDirectory) {
      pushListDir(path.join(absolutePath, entry.name), indent + 4);
    }
  }
};
