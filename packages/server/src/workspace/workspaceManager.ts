/**
 * <Summary>
 * What it does:
 *   Enforces workspace-root containment for all agent file IO, tree listing,
 *   and glob search scoped to the workspace.
 *
 * How it fits in the system:
 *   Hard boundary so relative paths cannot escape the configured project root.
 *
 * Dependencies:
 *   - node:fs/promises, node:path — filesystem primitives.
 *   - fast-glob — pattern search limited to workspace cwd.
 *   - ./diffEngine.js — line diff and Claude Code style preview.
 *   - ./confirmationBroker.js — optional request() before write.
 *
 * Dependants:
 *   - Agent, TerminalExecutor.
 * </Summary>
 */

import fg from "fast-glob";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ConfirmationBroker } from "./confirmationBroker.js";
import { computeDiff, formatDiff } from "./diffEngine.js";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", ".next"]);

/**
 * <Summary>
 * What it does:
 *   Typed failure for illegal paths or missing workspace configuration.
 *
 * Used by:
 *   - WorkspaceManager — thrown on invariant violations.
 *
 * Produced by:
 *   - WorkspaceManager.resolvePath and setRoot.
 * </Summary>
 */
export class WorkspaceError extends Error {
  /**
   * @param {'OUTSIDE_ROOT' | 'NO_ROOT' | 'NOT_FOUND'} code — Machine-readable reason.
   * @param {string} message — Human-readable detail.
   */
  constructor(
    public readonly code: "OUTSIDE_ROOT" | "NO_ROOT" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * <Summary>
 * What it does:
 *   Validates that a resolved absolute path stays inside the workspace root.
 *   Uses path.relative to handle platform differences (Windows vs Unix) and
 *   relative path escape sequences (..) safely.
 *
 * How it does it (step by step):
 *   1. Convert absolute candidate path to relative path from workspace root.
 *   2. Check if relative path starts with ".." (attempted escape upward).
 *   3. Check if relative path is absolute (attempted jump to different root).
 *   4. If either check fails, throw WorkspaceError with escape details.
 *   5. If both checks pass, function returns normally (path is safe).
 *
 * Parameters:
 *   @param {string} workspaceRoot — Absolute workspace root (e.g., "/Users/john/project").
 *   @param {string} candidateAbsolutePath — Full path to validate (e.g., "/Users/john/project/src/file.ts").
 *
 * Returns:
 *   @returns {void} — Returns silently when path is contained within root.
 *
 * @throws {WorkspaceError} — Throws with code='OUTSIDE_ROOT' when path escapes boundaries.
 *
 * Security Note:
 *   This function is a critical security boundary. It prevents:
 *   - Path traversal attacks using ".." (e.g., "../../etc/passwd")
 *   - Absolute path injection (e.g., "/etc/passwd" from user input)
 *   - Cross-workspace file access (e.g., accessing sibling projects)
 *
 * Example Scenarios:
 *   ✓ SAFE: workspaceRoot="/workspace", candidateAbsolutePath="/workspace/src/index.ts"
 *     → relativePathFromRoot="src/index.ts" (no .. or absolute, returns normally)
 *
 *   ✗ UNSAFE: workspaceRoot="/workspace", candidateAbsolutePath="/etc/passwd"
 *     → relativePathFromRoot="../../etc/passwd" (starts with .., throws OUTSIDE_ROOT)
 *
 *   ✗ UNSAFE: workspaceRoot="/workspace", candidateAbsolutePath="/tmp/file"
 *     → relativePathFromRoot="/tmp/file" (is absolute, throws OUTSIDE_ROOT)
 *
 *   ✗ UNSAFE: workspaceRoot="/workspace", candidateAbsolutePath="/workspace/../../../etc/passwd"
 *     → Resolved to "/etc/passwd" first, then detected as escape (throws OUTSIDE_ROOT)
 *
 * Dependants:
 *   - WorkspaceManager.resolvePath — validates joined paths before using them.
 *   - WorkspaceManager.listStructure — validates each child path during tree walk.
 * </Summary>
 */
const assertInsideRoot = (
  workspaceRoot: string,
  candidateAbsolutePath: string,
): void => {
  // Step 1: Convert absolute candidate path to relative path from workspace root
  // path.relative() computes the relative path between two absolute paths
  // Example: path.relative("/Users/john/project", "/Users/john/project/src/file.ts")
  //          → "src/file.ts" (contained inside root)
  // Example: path.relative("/Users/john/project", "/etc/passwd")
  //          → "../../etc/passwd" (escapes root upward)
  const relativePathFromRoot = path.relative(
    workspaceRoot,
    candidateAbsolutePath,
  );

  // Step 2-3: Check for escape attempts (upward or sideways)
  // Two conditions indicate an attempted escape:
  //   - startsWith('..'): Path traversal upward (e.g., "../../etc/passwd")
  //   - isAbsolute(): Absolute path on Windows (e.g., "C:\" or "/" after path.relative)
  // Either condition means the path is OUTSIDE the workspace boundary
  if (
    relativePathFromRoot.startsWith("..") ||
    path.isAbsolute(relativePathFromRoot)
  ) {
    // Step 4: Throw WorkspaceError with escape details
    // Include both the attempted path and workspace root in error message
    // for debugging and security audit logs
    throw new WorkspaceError(
      "OUTSIDE_ROOT",
      `Path escapes workspace root: ${candidateAbsolutePath} (root ${workspaceRoot})`,
    );
  }

  // Step 5: If both checks pass, function returns normally (path is safe)
  // Implicit return void when no exception thrown
  // Caller can safely use candidateAbsolutePath for file operations
};

export class WorkspaceManager {
  private root: string | null = null;

  private readonly confirmation: ConfirmationBroker | undefined;

  /**
   * @param {{ confirmation?: ConfirmationBroker }} [deps] — Optional write approval broker.
   */
  constructor(deps?: { confirmation?: ConfirmationBroker }) {
    this.confirmation = deps?.confirmation;
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Resolves and validates a workspace directory, then stores it as the root.
   *
   * Parameters:
   *   @param {string} workspacePath — Path to workspace directory.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes when root is stored.
   *
   * @throws {WorkspaceError} — When missing or not a directory.
   *
   * Dependants:
   *   - Server bootstrap.
   * </Summary>
   */
  setRoot = async (workspacePath: string): Promise<void> => {
    // Step 1: Convert workspace path to absolute path
    // This normalizes relative paths and resolves symlinks properly
    const absoluteWorkspacePath = path.resolve(workspacePath);

    // Step 2: Attempt to retrieve file statistics (metadata) from the resolved path
    // fs.stat will throw if the path does not exist or is inaccessible
    let workspacePathStats;
    try {
      workspacePathStats = await fs.stat(absoluteWorkspacePath);
    } catch (err) {
      // Step 2a: Extract the error code from the NodeJS error to identify the specific issue
      // Common error codes: ENOENT (not found), EACCES (permission denied), EISDIR (is a directory)
      const errorCode = (err as NodeJS.ErrnoException).code;

      // Step 2b: If file does not exist, throw a specific WorkspaceError with NOT_FOUND code
      // This helps callers distinguish between missing files and other errors
      if (errorCode === "ENOENT") {
        throw new WorkspaceError(
          "NOT_FOUND",
          `Workspace directory not found: ${absoluteWorkspacePath}`,
        );
      }

      // Step 2c: For other unexpected errors, propagate the original error
      // Callers can handle permission denied, I/O errors, etc.
      throw err;
    }

    // Step 3: Verify that the path points to a directory, not a file
    // isDirectory() returns true only for directories; false for files or symlinks to files
    if (!workspacePathStats.isDirectory()) {
      throw new WorkspaceError(
        "NOT_FOUND",
        `Workspace path is not a directory: ${absoluteWorkspacePath}`,
      );
    }

    // Step 4: Store the validated absolute path as the workspace root
    // This root is now used by all file operations (resolvePath, listStructure, searchFiles)
    this.root = absoluteWorkspacePath;
  };

  /**
   * <Summary>
   * What it does:
   *   Joins a relative path to the workspace root and rejects path traversal.
   *
   * Parameters:
   *   @param {string} relativePath — Path relative to workspace root.
   *
   * Returns:
   *   @returns {string} — Absolute path inside the workspace.
   *
   * @throws {WorkspaceError} — When root unset or resolved path escapes root.
   *
   * Dependants:
   *   - readFile, writeFile, listStructure, searchFiles.
   * </Summary>
   */
  resolvePath = (relativePath: string): string => {
    // Guard against uninitialized workspace root
    if (this.root === null) {
      throw new WorkspaceError("NO_ROOT", "Workspace root is not set");
    }

    // Combine workspace root with the relative path to produce an absolute path
    const absoluteJoinedPath = path.resolve(this.root, relativePath);

    // Validate that the resulting path stays within the workspace boundaries
    // This prevents directory traversal attacks (e.g., ../../etc/passwd)
    assertInsideRoot(this.root, absoluteJoinedPath);

    return absoluteJoinedPath;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Reads a UTF-8 file after path containment checks.
   *
   * Parameters:
   *   @param {string} filePath — Relative file path.
   *
   * Returns:
   *   @returns {Promise<string>} — Full file text.
   *
   * @throws {WorkspaceError} — Same as resolvePath; propagates fs errors.
   *
   * Dependants:
   *   - Agent tooling.
   * </Summary>
   */
  readFile = async (filePath: string): Promise<string> => {
    // Step 1: Resolve and validate the relative path to an absolute path within workspace bounds
    // This ensures the path cannot escape the workspace root (security boundary)
    // Throws WorkspaceError if root is not set or path is outside workspace
    const absoluteFilePath = this.resolvePath(filePath);

    // Step 2: Read the file contents as UTF-8 text from disk
    // Returns full file contents as a string
    // Throws if file does not exist or is unreadable
    return fs.readFile(absoluteFilePath, "utf-8");
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Builds a line diff preview, optionally waits for ConfirmationBroker.request,
   *   then writes new content when approved.
   *
   * How it does it (step by step):
   *   1. Reads current file contents (empty when new).
   *   2. Computes diff chunks and formats Claude Code style output.
   *   3. When ConfirmationBroker is configured, awaits request(formatted, path).
   *   4. On approval, writes the new content; on decline, returns without touching disk.
   *
   * Parameters:
   *   @param {string} filePath — Relative file path.
   *   @param {string} content — New UTF-8 body.
   *
   * Returns:
   *   @returns {Promise<string | undefined>} — Formatted diff after a successful write; undefined when the user declines (file unchanged).
   *
   * @throws {WorkspaceError} — On illegal paths or missing root.
   *
   * Dependants:
   *   - Agent file edits.
   * </Summary>
   */
  writeFile = async (
    filePath: string,
    content: string,
  ): Promise<string | undefined> => {
    // Step 1: Resolve and validate the relative path to an absolute path within workspace bounds
    // Throws WorkspaceError if root is not set or path is outside workspace
    const absoluteFilePath = this.resolvePath(filePath);

    // Step 2: Read existing file contents for diff calculation
    // If file doesn't exist (new file), previousFileContent remains empty string
    let previousFileContent = "";
    try {
      previousFileContent = await fs.readFile(absoluteFilePath, "utf-8");
    } catch (err) {
      // Step 2a: Extract error code to check if file simply doesn't exist
      const errorCode = (err as NodeJS.ErrnoException).code;

      // Step 2b: Only ignore ENOENT (file not found) errors
      // Other errors (permission denied, I/O issues) should be propagated
      if (errorCode !== "ENOENT") {
        throw err;
      }
      // If ENOENT, previousFileContent stays as empty string (this is a new file)
    }

    // Step 3: Compute line-level diff between existing content and new content
    // This produces chunks indicating which lines were added, removed, or unchanged
    const diffChunks = computeDiff(previousFileContent, content);

    // Step 4: Format diff chunks into Claude Code style colored output with line numbers
    // This generates the human-readable preview that will be shown for approval
    const formattedDiffPreview = formatDiff(diffChunks, filePath);

    // Step 5: Check if ConfirmationBroker is configured (user approval required)
    // If not configured, skip approval and proceed directly to writing
    if (this.confirmation !== undefined) {
      // Step 5a: Request user approval by showing formatted diff preview
      // The broker displays the diff and waits for user to approve or decline
      const userApprovedChanges = await this.confirmation.request(
        formattedDiffPreview,
        filePath,
      );

      // Step 5b: If user declined, return undefined without writing to disk
      // File remains unchanged and no further action is taken
      if (!userApprovedChanges) {
        return;
      }
    }

    // Step 6: Create parent directory if it doesn't exist (for new files in subdirectories)
    // recursive: true allows creating nested directories at once
    const parentDirectoryPath = path.dirname(absoluteFilePath);
    await fs.mkdir(parentDirectoryPath, { recursive: true });

    // Step 7: Write the new content to disk as UTF-8 text
    // This overwrites existing file or creates new file if it doesn't exist
    await fs.writeFile(absoluteFilePath, content, "utf-8");

    // Step 8: Return the formatted diff preview (indicates successful write)
    // Callers can use this for logging or display purposes
    return formattedDiffPreview;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Renders an indented directory tree up to a maximum depth from the workspace root.
   *
   * Parameters:
   *   @param {number} depth — Maximum recursion depth (>=1 lists root children only when depth is 1).
   *
   * Returns:
   *   @returns {Promise<string>} — Multiline tree text.
   *
   * @throws {WorkspaceError} — When root unset.
   *
   * Dependants:
   *   - Agent exploration helpers.
   * </Summary>
   */
  listStructure = async (depth: number): Promise<string> => {
    // Step 1: Guard against uninitialized workspace root
    // Must call setRoot() before any file operations
    if (this.root === null) {
      throw new WorkspaceError("NO_ROOT", "Workspace root is not set");
    }

    // Step 2: Validate and normalize the depth parameter
    // Ensure depth is a non-negative integer; 0 means no recursion (return empty string)
    const normalizedMaxDepth = Math.max(0, Math.floor(depth));
    if (normalizedMaxDepth === 0) {
      return "";
    }

    // Step 3: Store workspace root reference for use in nested walkDirectory function
    const workspaceRootPath = this.root;

    // Step 4: Initialize array to accumulate tree lines for final output
    // Each entry will be a formatted line with proper indentation
    const treeOutputLines: string[] = [];

    // Step 5: Define recursive helper function to traverse the directory tree
    // This function walks depth-first through directories, respecting maxDepth limit
    const walkDirectory = async (
      currentDirectoryAbsPath: string,
      currentRecursionDepth: number,
    ): Promise<void> => {
      // Step 5a: Read directory contents with file type information
      let directoryContents;
      try {
        // withFileTypes: true returns Dirent objects (include isDirectory(), isFile() methods)
        directoryContents = await fs.readdir(currentDirectoryAbsPath, {
          withFileTypes: true,
        });
      } catch {
        // Step 5b: Silently skip directories that cannot be read
        // This prevents permission denied errors from halting traversal
        return;
      }

      // Step 5c: Process each entry in the current directory
      for (const directoryEntry of directoryContents) {
        // Step 5d: Skip common directories that clutter the tree
        // Examples: node_modules, .git, dist, .next (defined in SKIP_DIR_NAMES)
        if (SKIP_DIR_NAMES.has(directoryEntry.name)) {
          continue;
        }

        // Step 5e: Construct absolute path for this entry
        const entryAbsolutePath = path.join(
          currentDirectoryAbsPath,
          directoryEntry.name,
        );

        // Step 5f: Validate that the entry path stays within workspace bounds
        // This security check prevents directory traversal outside the workspace
        assertInsideRoot(workspaceRootPath, entryAbsolutePath);

        // Step 5g: Add the entry to the tree with proper indentation
        // Indentation indicates depth level (2 spaces per level)
        const indentationString = "  ".repeat(currentRecursionDepth);
        treeOutputLines.push(`${indentationString}${directoryEntry.name}`);

        // Step 5h: Recursively process subdirectories only if within depth limit
        // Condition: is a directory AND next depth level is less than max depth
        if (
          directoryEntry.isDirectory() &&
          currentRecursionDepth + 1 < normalizedMaxDepth
        ) {
          await walkDirectory(entryAbsolutePath, currentRecursionDepth + 1);
        }
      }
    };

    // Step 6: Start tree traversal from the workspace root
    // Begin at depth 0, which will process all entries at all levels up to maxDepth
    await walkDirectory(workspaceRootPath, 0);

    // Step 7: Join all accumulated lines with newlines for final output
    // Returns multi-line string suitable for display
    return treeOutputLines.join("\n");
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Runs fast-glob from the workspace root only and returns relative matches.
   *
   * Parameters:
   *   @param {string} pattern — Glob pattern.
   *
   * Returns:
   *   @returns {Promise<string[]>} — Paths relative to workspace root.
   *
   * @throws {WorkspaceError} — When root unset.
   *
   * Dependants:
   *   - Agent search helpers.
   * </Summary>
   */
  searchFiles = async (pattern: string): Promise<string[]> => {
    // Step 1: Guard against uninitialized workspace root
    // Must call setRoot() before any file operations
    if (this.root === null) {
      throw new WorkspaceError("NO_ROOT", "Workspace root is not set");
    }

    // Step 2: Execute fast-glob pattern search from the workspace root directory
    // The glob pattern can use wildcards like *, **, ? for flexible matching
    // Results will be relative paths from the workspace root
    const foundFilePaths = await fg(pattern, {
      // cwd: change working directory to workspace root
      // This constrains all searches to remain within workspace
      cwd: this.root,

      // dot: false — ignore hidden files (starting with . on Unix/Mac)
      // Prevents .git, .env, and other dotfiles from appearing in results
      dot: false,

      // onlyFiles: false — return both files AND directories
      // If true, would only return files and skip directories
      onlyFiles: false,

      // ignore: exclude common non-project directories
      // Patterns prevent dependencies, builds, and version control from cluttering results
      // Examples: node_modules/ (npm packages), dist/ (compiled output), .git/ (version control)
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    });

    // Step 3: Return a shallow copy of the matches array
    // Shallow copy prevents external code from mutating the original array
    // Each element is a relative path string (not copied, still references same strings)
    return [...foundFilePaths];
  };
}
