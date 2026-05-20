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
 *   - ./diffEngine.js — unified diff via jsdiff.
 *   - ./confirmationBroker.js — optional accept/decline before write.
 *
 * Dependants:
 *   - Agent, TerminalExecutor.
 * </Summary>
 */

import fg from "fast-glob";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ConfirmationBroker } from "./confirmationBroker.js";
import { formatWritePreview } from "./diffEngine.js";

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
    const absolutePath = path.resolve(workspacePath);

    // Attempt to retrieve file statistics (metadata) from the resolved path
    let fileStats;
    try {
      fileStats = await fs.stat(absolutePath); // This will throw if the path does not exist or is inaccessible
    } catch (err) {
      // Extract the error code from the NodeJS error to identify the specific issue
      const errorCode = (err as NodeJS.ErrnoException).code;

      // If file does not exist, throw a specific WorkspaceError
      if (errorCode === "ENOENT") {
        throw new WorkspaceError(
          "NOT_FOUND",
          `Workspace directory not found: ${absolutePath}`,
        );
      }

      // For other unexpected errors, propagate the original error
      throw err;
    }

    // Verify that the path points to a directory, not a file
    if (!fileStats.isDirectory()) {
      throw new WorkspaceError(
        "NOT_FOUND",
        `Workspace path is not a directory: ${absolutePath}`,
      );
    }

    // Store the validated absolute path as the workspace root
    this.root = absolutePath;
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
    // Resolve and validate the relative path to an absolute path within workspace bounds
    const absolutePath = this.resolvePath(filePath);

    // Read the file contents as UTF-8 text
    return fs.readFile(absolutePath, "utf-8");
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Shows a unified diff preview, optionally waits for user approval, then writes
   *   new content when approved.
   *
   * How it does it (step by step):
   *   1. Reads current file contents (empty when new).
   *   2. Builds a jsdiff unified patch and colored terminal preview.
   *   3. When ConfirmationBroker is configured, requests accept/decline before writing.
   *   4. On approval, writes the new content directly.
   *
   * Parameters:
   *   @param {string} filePath — Relative file path.
   *   @param {string} content — New UTF-8 body.
   *
   * Returns:
   *   @returns {Promise<string>} — Unified diff patch string (plain text), or empty string if declined.
   *
   * @throws {WorkspaceError} — On illegal paths or missing root.
   *
   * Dependants:
   *   - Agent file edits.
   * </Summary>
   */
  writeFile = async (filePath: string, content: string): Promise<string> => {
    // Resolve the relative path to an absolute path within workspace bounds
    const absolutePath = this.resolvePath(filePath);

    // Attempt to read the existing file content for diff comparison
    // If the file doesn't exist, we'll use an empty string as the "before" state
    let previousContent = "";
    try {
      previousContent = await fs.readFile(absolutePath, "utf-8");
    } catch (err) {
      const errorCode = (err as NodeJS.ErrnoException).code;

      // Only ignore ENOENT (file not found). Re-throw any other filesystem errors.
      if (errorCode !== "ENOENT") {
        throw err;
      }
    }

    // Generate a unified diff patch and colored terminal preview of the changes
    const { patch, colored } = formatWritePreview(
      filePath,
      previousContent,
      content,
    );

    // If a confirmation broker is configured, request user approval before writing
    if (this.confirmation !== undefined) {
      const userApproved = await this.confirmation.requestWriteApproval({
        relativePath: filePath,
        patch,
        coloredDiff: colored,
      });

      // If the user declines, silently return without making any changes to the file
      if (!userApproved) {
        return "";
      }
    }

    // Ensure the parent directory exists before writing the file
    const parentDirectory = path.dirname(absolutePath);
    await fs.mkdir(parentDirectory, { recursive: true });

    // Write the new content to the file
    await fs.writeFile(absolutePath, content, "utf-8");

    // Return the unified diff patch for logging or display purposes
    return patch;
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
    // Guard against uninitialized workspace root
    if (this.root === null) {
      throw new WorkspaceError("NO_ROOT", "Workspace root is not set");
    }

    // Ensure depth is a non-negative integer; 0 means no recursion
    const maxDepth = Math.max(0, Math.floor(depth));
    if (maxDepth === 0) {
      return "";
    }

    const workspaceRoot = this.root;
    const treeLines: string[] = [];

    // Recursive helper function to traverse the directory tree
    const walkDirectory = async (
      currentDirAbsPath: string,
      currentDepthLevel: number,
    ): Promise<void> => {
      let directoryEntries;
      try {
        directoryEntries = await fs.readdir(currentDirAbsPath, {
          withFileTypes: true,
        });
      } catch {
        // Silently skip directories that cannot be read (permissions, etc.)
        return;
      }

      for (const entry of directoryEntries) {
        // Skip common directories that clutter the tree (dependencies, version control, build output)
        if (SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }

        const childAbsPath = path.join(currentDirAbsPath, entry.name);

        // Validate that the child path stays within workspace bounds
        assertInsideRoot(workspaceRoot, childAbsPath);

        // Add the entry to the tree with proper indentation
        const indentation = "  ".repeat(currentDepthLevel);
        treeLines.push(`${indentation}${entry.name}`);

        // Recursively process subdirectories up to maxDepth
        if (entry.isDirectory() && currentDepthLevel + 1 < maxDepth) {
          await walkDirectory(childAbsPath, currentDepthLevel + 1);
        }
      }
    };

    // Start tree traversal from the workspace root at depth 0
    await walkDirectory(workspaceRoot, 0);

    return treeLines.join("\n");
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
    // Guard against uninitialized workspace root
    if (this.root === null) {
      throw new WorkspaceError("NO_ROOT", "Workspace root is not set");
    }

    // Execute fast-glob pattern search from the workspace root directory
    // Configuration:
    // - cwd: search from workspace root to constrain results to workspace
    // - dot: false — ignore hidden files (starting with .)
    // - onlyFiles: false — return both files and directories
    // - ignore: exclude common non-project directories (dependencies, builds, version control)
    const matchingPaths = await fg(pattern, {
      cwd: this.root,
      dot: false,
      onlyFiles: false,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    });

    // Return a shallow copy of the matches array
    return [...matchingPaths];
  };
}
