import * as path from "node:path";

/**
 * <Summary>
 * What it does:
 *   Validates that a given path is inside the workspace root directory, throwing an error if it escapes.
 *
 * How it does it (step by step):
 *   1. Calculate the relative path from the workspace root to the candidate path.
 *   2. Check if the relative path starts with ".." (directory traversal on same volume).
 *   3. Check if the relative path is absolute (cross-drive escape on Windows).
 *   4. If either condition is true, throw an error indicating the path escapes the workspace.
 *   5. If neither condition is true, the path is safe and the function returns normally.
 *
 * Parameters:
 *   @param workspaceRoot - The root directory of the workspace that serves as the security boundary.
 *   @param candidate - The path to validate (can be absolute or relative).
 *
 * Returns:
 *   @returns Returns normally if the path is safe, throws an error if the path escapes the workspace.
 *
 * Throws:
 *   @throws {Error} — When the candidate path escapes the workspace root.
 * </Summary>
 */
export const assertInsideRoot = (
  workspaceRoot: string,
  candidate: string,
): void => {
  // ===== STEP 1: Calculate relative path =====
  // Step 1a: Calculate the relative path from workspace root to the candidate path
  // Step 1b: This helps detect if the candidate path goes outside the workspace
  const relativePathFromRoot = path.relative(workspaceRoot, candidate);

  // ===== STEP 2: Check for directory traversal =====
  // Step 2a: Check if the relative path starts with ".." (indicates going up directory levels)
  // Step 2b: This would mean the path escapes the workspace root (e.g., ../../etc/passwd)
  // Step 2c: Also check if the relative path is absolute (indicates completely different location)
  if (
    relativePathFromRoot.startsWith("..") ||
    path.isAbsolute(relativePathFromRoot)
  ) {
    // ===== STEP 3: Throw security error =====
    // Step 3a: Throw an error indicating the path attempts to escape the workspace
    // Step 3b: This prevents directory traversal attacks and unauthorized file access
    throw new Error(`Path escapes workspace root: ${candidate}`);
  }
};

/**
 * <Summary>
 * What it does:
 *   Rejects empty or whitespace-only path strings with a clear error.
 *
 * Parameters:
 *   @param value - Raw path or pattern from a request body.
 *   @param {string} [field] — Field name for the error message.
 *
 * Returns:
 *   @returns Trimmed non-empty path.
 *
 * Throws:
 *   @throws {Error} — When value is empty after trimming.
 * </Summary>
 */
export const requireNonEmptyPath = (value: string, field = "path"): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
};

/**
 * <Summary>
 * What it does:
 *   Resolves a relative path to an absolute path and validates it stays inside the workspace root.
 *
 * How it does it (step by step):
 *   1. Reject absolute paths from callers (must be relative to currentDir).
 *   2. Join with currentDir and resolve to absolute form.
 *   3. Validate the resolved path is inside the workspace root.
 *   4. Return the validated absolute path.
 *
 * Parameters:
 *   @param workspaceRoot - The root directory of the workspace that serves as the security boundary.
 *   @param currentDir - The current working directory (used for resolving relative paths).
 *   @param relativePath - Path relative to currentDir (absolute paths are rejected).
 *
 * Returns:
 *   @returns The validated absolute path guaranteed to be inside the workspace root.
 *
 * Throws:
 *   @throws {Error} — When an absolute path is supplied or the resolved path escapes the workspace.
 * </Summary>
 */
export const resolveAbsolutePath = (
  workspaceRoot: string,
  currentDir: string,
  relativePath: string,
): string => {
  if (path.isAbsolute(relativePath)) {
    throw new Error(
      "Absolute paths are not allowed; use a path relative to the workspace.",
    );
  }

  const absolutePath = path.resolve(currentDir, relativePath);
  assertInsideRoot(workspaceRoot, absolutePath);

  return absolutePath;
};
