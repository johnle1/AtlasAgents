import * as fs from "node:fs/promises";
import * as path from "node:path";
import fg from "fast-glob";
import { computeDiff, formatDiffPlain } from "@loopycode/shared";
import { formatDisplayPath } from "../../pathDisplay.js";
import {
  printCd,
  printCreateDir,
  printDelete,
  printRead,
  printSkipped,
  printSuccessOp,
  printWrite,
} from "../../renderer.js";
import { requestApproval } from "../../ui/uiBridge.js";
import { listStructure } from "../directoryListing.js";
import {
  assertInsideRoot,
  requireNonEmptyPath,
} from "../pathUtils.js";
import type { DispatchContext } from "../types.js";

/**
 * <Summary>
 * What it does:
 *   Reads the contents of a file and returns them as a string.
 *
 * How it does it (step by step):
 *   1. Extract the file path from the request body.
 *   2. Resolve the path to an absolute path within the workspace.
 *   3. Print the read operation to the console for user awareness.
 *   4. Read the file contents from the filesystem as UTF-8 text.
 *   5. Return the file contents in a standardized response format.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing path resolution utilities.
 *   @param {Record<string, unknown>} requestBody — The request body containing the file path.
 *
 * Returns:
 *   @returns {Promise<unknown>} — Object containing the file content as a string.
 *
 * Dependencies:
 *   - context.resolveAbsolute — resolves the file path to an absolute path.
 *   - node:fs/promises — provides readFile() for reading file contents.
 *   - printRead — displays the read operation to the user.
 *
 * Dependants:
 *   - dispatch system — routes file.read requests to this handler.
 * </Summary>
 */
export const handleFileRead = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  // ===== STEP 1: Extract file path =====
  // Step 1a: Extract the file path from the request body, default to empty string
  const filePath = requireNonEmptyPath(String(requestBody.path ?? ""));

  // ===== STEP 2: Resolve to absolute path =====
  // Step 2a: Resolve the relative path to an absolute path within the workspace
  // Step 2b: This ensures the path is validated and stays within workspace boundaries
  const absolutePath = context.resolveAbsolute(filePath);

  // ===== STEP 3: Display read operation =====
  // Step 3a: Print the read operation to inform the user which file is being read
  printRead(absolutePath);

  // ===== STEP 4: Read file contents =====
  // Step 4a: Read the file contents from the filesystem as UTF-8 text
  // Step 4b: This will throw an error if the file doesn't exist or cannot be read
  const fileContent = await fs.readFile(absolutePath, "utf-8");

  // ===== STEP 5: Return file contents =====
  // Step 5a: Return the file contents in a standardized response format
  return { content: fileContent };
};

/**
 * <Summary>
 * What it does:
 *   Writes content to a file after showing the diff and requesting user approval.
 *
 * How it does it (step by step):
 *   1. Extract the file path and content from the request body.
 *   2. Resolve the file path to an absolute path within the workspace.
 *   3. Attempt to read the existing file content (if file exists).
 *   4. Compute the diff between the previous and new content.
 *   5. Display the diff to the user for review.
 *   6. Request user approval to apply the changes.
 *   7. If approved, create parent directories if needed and write the file.
 *   8. Print success message and return the formatted diff.
 *   9. If not approved, print skipped message and return rejection result.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing path resolution utilities.
 *   @param {Record<string, unknown>} requestBody — The request body containing the file path and content.
 *
 * Returns:
 *   @returns {Promise<unknown>} — Object with accepted boolean and diff (if approved), or accepted false (if rejected).
 *
 * Dependencies:
 *   - context.resolveAbsolute — resolves the file path to an absolute path.
 *   - computeDiff — calculates the difference between old and new content.
 *   - formatDiffPlain — formats the diff for display and storage.
 *   - formatDisplayPath — formats the path for user display.
 *   - node:fs/promises — provides readFile(), mkdir(), and writeFile() for file operations.
 *   - printWrite — displays the diff to the user.
 *   - requestApproval — prompts user for approval.
 *
 * Dependants:
 *   - dispatch system — routes file.write requests to this handler.
 * </Summary>
 */
export const handleFileWrite = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  // ===== STEP 1: Extract file parameters =====
  // Step 1a: Extract the file path from the request body, default to empty string
  const filePath = requireNonEmptyPath(String(requestBody.path ?? ""));
  // Step 1b: Extract the file content from the request body, default to empty string
  const newContent = String(requestBody.content ?? "");

  // ===== STEP 2: Resolve to absolute path =====
  // Step 2a: Resolve the relative path to an absolute path within the workspace
  const absolutePath = context.resolveAbsolute(filePath);

  // ===== STEP 3: Read existing file content =====
  // Step 3a: Initialize variable to store previous file content (empty string if file doesn't exist)
  let previousContent = "";

  try {
    // Step 3b: Attempt to read the existing file content as UTF-8 text
    previousContent = await fs.readFile(absolutePath, "utf-8");
  } catch (error) {
    // Step 3c: If file doesn't exist (ENOENT), that's expected for new files
    // Step 3d: If it's a different error, re-throw it to indicate a real problem
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // Step 3e: If ENOENT, continue with empty previous content (new file)
  }

  // ===== STEP 4: Compute and display diff =====
  // Step 4a: Compute the diff between the previous and new content
  const diffChunks = computeDiff(previousContent, newContent);

  // Step 4b: Display the diff to the user for review
  await printWrite(absolutePath, diffChunks);

  // ===== STEP 5: Request user approval =====
  // Step 5a: Prompt the user to approve applying the changes
  const userApproved = (await requestApproval({
    type: "keepUndo",
    contextLabel: `Apply changes to ${formatDisplayPath(absolutePath)}`,
  })) as boolean;

  // ===== STEP 6: Handle user rejection =====
  // Step 6a: If user didn't approve, print skipped message and return early
  if (!userApproved) {
    printSkipped();
    return { accepted: false };
  }

  // ===== STEP 7: Create parent directories =====
  // Step 7a: Create the parent directory if it doesn't exist
  // Step 7b: recursive: true ensures all intermediate directories are created
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  // ===== STEP 8: Write file =====
  // Step 8a: Write the new content to the file as UTF-8 text
  await fs.writeFile(absolutePath, newContent, "utf-8");

  // ===== STEP 9: Print success message =====
  // Step 9a: Inform the user that the file was written successfully
  printSuccessOp("Written.");

  // ===== STEP 10: Return success result =====
  // Step 10a: Return the accepted status and formatted diff for record keeping
  return {
    accepted: true,
    diff: formatDiffPlain(diffChunks, absolutePath),
  };
};

/**
 * <Summary>
 * What it does:
 *   Generates a hierarchical directory structure string up to a specified depth.
 *
 * How it does it (step by step):
 *   1. Extract the depth parameter from the request body.
 *   2. Validate and normalize the depth to be at least 1.
 *   3. Call the listStructure utility to generate the directory tree.
 *   4. Return the directory structure in a standardized response format.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing workspace state.
 *   @param {Record<string, unknown>} requestBody — The request body containing the depth parameter.
 *
 * Returns:
 *   @returns {Promise<unknown>} — Object containing the directory structure as a string.
 *
 * Dependencies:
 *   - listStructure — generates the hierarchical directory structure.
 *
 * Dependants:
 *   - dispatch system — routes file.list_dir requests to this handler.
 * </Summary>
 */
export const handleFileListDir = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  // ===== STEP 1: Extract and validate depth =====
  // Step 1a: Extract the depth parameter from the request body, default to 1
  // Step 1b: Ensure depth is at least 1 (no negative or zero values)
  // Step 1c: Use Math.floor to handle fractional depth values
  const traversalDepth = Math.max(
    1,
    Math.floor(Number(requestBody.depth ?? 1)),
  );

  // ===== STEP 2: Generate directory structure =====
  // Step 2a: Call the listStructure utility to generate the directory tree
  // Step 2b: This traverses the directory and builds a hierarchical string representation
  const directoryStructure = await listStructure(context, traversalDepth);

  // ===== STEP 3: Return directory structure =====
  // Step 3a: Return the directory structure in a standardized response format
  return { text: directoryStructure };
};

/**
 * <Summary>
 * What it does:
 *   Searches for files and directories matching a glob pattern within the workspace.
 *
 * How it does it (step by step):
 *   1. Extract the search pattern from the request body.
 *   2. Use fast-glob to search for files matching the pattern.
 *   3. Configure the search to exclude common directories (node_modules, dist, .git).
 *   4. Search within the workspace root directory.
 *   5. Return the matched paths in a standardized response format.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing workspace root.
 *   @param {Record<string, unknown>} requestBody — The request body containing the search pattern.
 *
 * Returns:
 *   @returns {Promise<unknown>} — Object containing the array of matched file paths.
 *
 * Dependencies:
 *   - fast-glob — provides fast glob pattern matching for file search.
 *
 * Dependants:
 *   - dispatch system — routes file.search requests to this handler.
 * </Summary>
 */
export const handleFileSearch = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  // ===== STEP 1: Extract search pattern =====
  // Step 1a: Extract the search pattern from the request body, default to empty string
  const searchPattern = requireNonEmptyPath(
    String(requestBody.pattern ?? ""),
    "pattern",
  );

  // ===== STEP 2: Perform glob search =====
  // Step 2a: Use fast-glob to search for files matching the pattern
  // Step 2b: Search within the workspace root directory
  // Step 2c: dot: false excludes hidden files/directories from results
  // Step 2d: onlyFiles: false includes both files and directories in results
  // Step 2e: ignore excludes common generated directories (node_modules, dist, .git)
  const matchedPaths = await fg(searchPattern, {
    cwd: context.workspaceRoot,
    dot: false,
    onlyFiles: false,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
  });

  // ===== STEP 3: Validate and return matched paths =====
  const paths = matchedPaths
    .map((rel) => path.resolve(context.workspaceRoot, rel))
    .filter((abs) => {
      try {
        assertInsideRoot(context.workspaceRoot, abs);
        return true;
      } catch {
        return false;
      }
    });

  return { paths };
};

/**
 * <Summary>
 * What it does:
 *   Creates a directory after requesting user approval.
 *
 * How it does it (step by step):
 *   1. Extract the directory path from the request body.
 *   2. Resolve the path to an absolute path within the workspace.
 *   3. Print the directory creation operation to the console.
 *   4. Request user approval to create the directory.
 *   5. If approved, create the directory with recursive option.
 *   6. Print success message and return creation result.
 *   7. If not approved, print skipped message and return rejection result.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing path resolution utilities.
 *   @param {Record<string, unknown>} requestBody — The request body containing the directory path.
 *
 * Returns:
 *   @returns {Promise<unknown>} — Object with created boolean indicating success or rejection.
 *
 * Dependencies:
 *   - context.resolveAbsolute — resolves the directory path to an absolute path.
 *   - formatDisplayPath — formats the path for user display.
 *   - node:fs/promises — provides mkdir() for directory creation.
 *   - printCreateDir — displays the creation operation to the user.
 *   - requestApproval — prompts user for approval.
 *
 * Dependants:
 *   - dispatch system — routes file.create_dir requests to this handler.
 * </Summary>
 */
export const handleFileCreateDir = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  // ===== STEP 1: Extract directory path =====
  // Step 1a: Extract the directory path from the request body, default to empty string
  const directoryPath = requireNonEmptyPath(String(requestBody.path ?? ""));

  // ===== STEP 2: Resolve to absolute path =====
  // Step 2a: Resolve the relative path to an absolute path within the workspace
  const absolutePath = context.resolveAbsolute(directoryPath);

  // ===== STEP 3: Display creation operation =====
  // Step 3a: Print the directory creation operation to inform the user
  printCreateDir(absolutePath);

  // ===== STEP 4: Request user approval =====
  // Step 4a: Prompt the user to approve creating the directory
  const userApproved = (await requestApproval({
    type: "keepUndo",
    contextLabel: `Create directory ${formatDisplayPath(absolutePath)}`,
  })) as boolean;

  // ===== STEP 5: Handle user rejection =====
  // Step 5a: If user didn't approve, print skipped message and return early
  if (!userApproved) {
    printSkipped();
    return { created: false };
  }

  // ===== STEP 6: Create directory =====
  // Step 6a: Create the directory with all parent directories if needed
  // Step 6b: recursive: true ensures all intermediate directories are created
  await fs.mkdir(absolutePath, { recursive: true });

  // ===== STEP 7: Print success message =====
  // Step 7a: Inform the user that the directory was created successfully
  printSuccessOp("Directory created.");

  // ===== STEP 8: Return success result =====
  // Step 8a: Return the created status in a standardized response format
  return { created: true };
};

/**
 * <Summary>
 * What it does:
 *   Deletes a file after requesting user approval.
 *
 * How it does it (step by step):
 *   1. Extract the file path from the request body.
 *   2. Resolve the path to an absolute path within the workspace.
 *   3. Print the file deletion operation to the console.
 *   4. Request user approval to delete the file.
 *   5. If approved, delete the file from the filesystem.
 *   6. Print success message and return deletion result.
 *   7. If not approved, print skipped message and return rejection result.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing path resolution utilities.
 *   @param {Record<string, unknown>} requestBody — The request body containing the file path.
 *
 * Returns:
 *   @returns {Promise<unknown>} — Object with deleted boolean indicating success or rejection.
 *
 * Dependencies:
 *   - context.resolveAbsolute — resolves the file path to an absolute path.
 *   - formatDisplayPath — formats the path for user display.
 *   - node:fs/promises — provides unlink() for file deletion.
 *   - printDelete — displays the deletion operation to the user.
 *   - requestApproval — prompts user for approval.
 *
 * Dependants:
 *   - dispatch system — routes file.delete_file requests to this handler.
 * </Summary>
 */
export const handleFileDeleteFile = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  // ===== STEP 1: Extract file path =====
  // Step 1a: Extract the file path from the request body, default to empty string
  const filePath = requireNonEmptyPath(String(requestBody.path ?? ""));

  // ===== STEP 2: Resolve to absolute path =====
  // Step 2a: Resolve the relative path to an absolute path within the workspace
  const absolutePath = context.resolveAbsolute(filePath);

  // ===== STEP 3: Display deletion operation =====
  // Step 3a: Print the file deletion operation to inform the user
  printDelete(absolutePath);

  // ===== STEP 4: Request user approval =====
  // Step 4a: Prompt the user to approve deleting the file
  const userApproved = (await requestApproval({
    type: "keepUndo",
    contextLabel: `Delete file ${formatDisplayPath(absolutePath)}`,
  })) as boolean;

  // ===== STEP 5: Handle user rejection =====
  // Step 5a: If user didn't approve, print skipped message and return early
  if (!userApproved) {
    printSkipped();
    return { deleted: false };
  }

  // ===== STEP 6: Delete file =====
  // Step 6a: Delete the file from the filesystem
  await fs.unlink(absolutePath);

  // ===== STEP 7: Print success message =====
  // Step 7a: Inform the user that the file was deleted successfully
  printSuccessOp("Deleted.");

  // ===== STEP 8: Return success result =====
  // Step 8a: Return the deleted status in a standardized response format
  return { deleted: true };
};

/**
 * <Summary>
 * What it does:
 *   Deletes a directory and all its contents after requesting user approval.
 *
 * How it does it (step by step):
 *   1. Extract the directory path from the request body.
 *   2. Resolve the path to an absolute path within the workspace.
 *   3. Print the directory deletion operation to the console.
 *   4. Request user approval to delete the directory.
 *   5. If approved, delete the directory recursively with force option.
 *   6. Print success message and return deletion result.
 *   7. If not approved, print skipped message and return rejection result.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing path resolution utilities.
 *   @param {Record<string, unknown>} requestBody — The request body containing the directory path.
 *
 * Returns:
 *   @returns {Promise<unknown>} — Object with deleted boolean indicating success or rejection.
 *
 * Dependencies:
 *   - context.resolveAbsolute — resolves the directory path to an absolute path.
 *   - formatDisplayPath — formats the path for user display.
 *   - node:fs/promises — provides rm() for directory deletion.
 *   - printDelete — displays the deletion operation to the user.
 *   - requestApproval — prompts user for approval.
 *
 * Dependants:
 *   - dispatch system — routes file.delete_dir requests to this handler.
 * </Summary>
 */
export const handleFileDeleteDir = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  // ===== STEP 1: Extract directory path =====
  // Step 1a: Extract the directory path from the request body, default to empty string
  const directoryPath = requireNonEmptyPath(String(requestBody.path ?? ""));

  // ===== STEP 2: Resolve to absolute path =====
  // Step 2a: Resolve the relative path to an absolute path within the workspace
  const absolutePath = context.resolveAbsolute(directoryPath);

  // ===== STEP 3: Display deletion operation =====
  // Step 3a: Print the directory deletion operation to inform the user
  printDelete(absolutePath);

  // ===== STEP 4: Request user approval =====
  // Step 4a: Prompt the user to approve deleting the directory
  const userApproved = (await requestApproval({
    type: "keepUndo",
    contextLabel: `Delete directory ${formatDisplayPath(absolutePath)}`,
  })) as boolean;

  // ===== STEP 5: Handle user rejection =====
  // Step 5a: If user didn't approve, print skipped message and return early
  if (!userApproved) {
    printSkipped();
    return { deleted: false };
  }

  // ===== STEP 6: Delete directory recursively =====
  // Step 6a: Delete the directory and all its contents recursively
  // Step 6b: recursive: true deletes all subdirectories and files
  // Step 6c: force: true ignores file permissions and deletes read-only files
  await fs.rm(absolutePath, { recursive: true, force: true });

  // ===== STEP 7: Print success message =====
  // Step 7a: Inform the user that the directory was deleted successfully
  printSuccessOp("Deleted.");

  // ===== STEP 8: Return success result =====
  // Step 8a: Return the deleted status in a standardized response format
  return { deleted: true };
};

/**
 * <Summary>
 * What it does:
 *   Changes the current working directory after validating the path is a directory.
 *
 * How it does it (step by step):
 *   1. Extract the target directory path from the request body.
 *   2. Resolve the path to an absolute path within the workspace.
 *   3. Get file system stats for the path to validate it exists and is a directory.
 *   4. Throw an error if the path is not a directory.
 *   5. Update the current directory in the context.
 *   6. Print the directory change operation to the console.
 *   7. Notify listeners via the onCwdChanged callback if provided.
 *   8. Return the new current working directory.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing directory state.
 *   @param {Record<string, unknown>} requestBody — The request body containing the target path.
 *
 * Returns:
 *   @returns {Promise<unknown>} — Object containing the new current working directory path.
 *
 * Throws:
 *   @throws {Error} — When the target path is not a directory.
 *
 * Dependencies:
 *   - context.resolveAbsolute — resolves the directory path to an absolute path.
 *   - context.setCurrentDir — updates the current directory in the context.
 *   - context.onCwdChanged — notifies listeners of directory changes.
 *   - node:fs/promises — provides stat() for path validation.
 *
 * Dependants:
 *   - dispatch system — routes file.cd requests to this handler.
 * </Summary>
 */
export const handleFileCd = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  // ===== STEP 1: Extract target path =====
  // Step 1a: Extract the target directory path from the request body, default to empty string
  const targetPath = requireNonEmptyPath(String(requestBody.path ?? ""));

  // ===== STEP 2: Resolve to absolute path =====
  // Step 2a: Resolve the relative path to an absolute path within the workspace
  const absolutePath = context.resolveAbsolute(targetPath);

  // ===== STEP 3: Validate path is a directory =====
  // Step 3a: Get file system stats for the path to check if it exists and its type
  const fileStats = await fs.stat(absolutePath);

  // ===== STEP 4: Check if path is a directory =====
  // Step 4a: If the path is not a directory, throw an error to prevent invalid navigation
  if (!fileStats.isDirectory()) {
    throw new Error("Not a directory");
  }

  // ===== STEP 5: Update current directory =====
  // Step 5a: Update the current directory in the context to the new absolute path
  context.setCurrentDir(absolutePath);

  // ===== STEP 6: Display directory change =====
  // Step 6a: Print the directory change operation to inform the user
  printCd(absolutePath);

  // ===== STEP 7: Return new current directory =====
  // Step 8a: Return the new current working directory in a standardized response format
  return { cwd: absolutePath };
};

/**
 * <Summary>
 * What it does:
 *   Returns the current working directory without requiring user interaction.
 *
 * How it does it (step by step):
 *   1. Access the current directory from the context.
 *   2. Return the current directory in a standardized response format.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing the current directory.
 *
 * Returns:
 *   @returns {Promise<unknown>} — Object containing the current working directory path.
 *
 * Dependencies:
 *   - context.currentDir — provides the current directory value.
 *
 * Dependants:
 *   - dispatch system — routes file.get_cwd requests to this handler.
 * </Summary>
 */
export const handleFileGetCwd = (context: DispatchContext): Promise<unknown> =>
  // ===== STEP 1: Return current directory =====
  // Step 1a: Access the current directory from the context
  // Step 1b: Return it in a standardized response format
  Promise.resolve({ cwd: context.currentDir });
