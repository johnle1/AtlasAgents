/**
 * Workspace path sandbox helpers for the file proxy.
 *
 * @remarks
 * All absolute paths used for read/write/delete/cd must pass
 * {@link assertInsideRoot}. Relative resolution goes through
 * {@link resolveAbsolutePath}, which also rejects absolute caller inputs so the
 * agent cannot point outside the workspace via `/etc/...`.
 */

import * as path from "node:path";

/**
 * Throws if `candidate` is outside `workspaceRoot`.
 *
 * @remarks
 * Uses `path.relative(workspaceRoot, candidate)`:
 * - a result starting with `..` means the candidate is an ancestor (traversal)
 * - an absolute relative result on Windows means a different drive / root escape
 *
 * Call after `path.resolve` / `path.join` so symlinks and `..` segments are
 * normalized first (callers are responsible for resolving).
 *
 * @param workspaceRoot - Absolute sandbox root.
 * @param candidate - Absolute path to validate.
 * @throws {@link Error} With message `Path escapes workspace root: …`.
 *
 * @example
 * ```ts
 * assertInsideRoot("/proj", "/proj/src/a.ts"); // ok
 * assertInsideRoot("/proj", "/etc/passwd"); // throws
 * ```
 */
export const assertInsideRoot = (
  workspaceRoot: string,
  candidate: string,
): void => {
  const relativePathFromRoot = path.relative(workspaceRoot, candidate);

  // `..` → walked above root; absolute relative → different Windows drive/root.
  if (
    relativePathFromRoot.startsWith("..") ||
    path.isAbsolute(relativePathFromRoot)
  ) {
    throw new Error(`Path escapes workspace root: ${candidate}`);
  }
};

/**
 * Trims a path/pattern field and rejects empty values.
 *
 * @param value - Raw string from a request body.
 * @param field - Name used in the error message (default `"path"`).
 * @returns Trimmed non-empty string.
 * @throws {@link Error} When empty after trim (`"<field> is required"`).
 *
 * @example
 * ```ts
 * requireNonEmptyPath("  src/a.ts  "); // "src/a.ts"
 * requireNonEmptyPath("  ", "pattern"); // throws "pattern is required"
 * ```
 */
export const requireNonEmptyPath = (value: string, field = "path"): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
};

/**
 * Joins `relativePath` to `currentDir`, then asserts the result is under root.
 *
 * @remarks
 * Absolute `relativePath` values are rejected so clients cannot bypass the cwd
 * sandbox with filesystem-absolute paths. Prefer this over raw `path.resolve`
 * in handlers.
 *
 * @param workspaceRoot - Absolute sandbox root.
 * @param currentDir - Absolute cwd used as the join base.
 * @param relativePath - Path relative to `currentDir` only.
 * @returns Absolute path guaranteed inside `workspaceRoot`.
 * @throws {@link Error} When `relativePath` is absolute or the result escapes.
 *
 * @example
 * ```ts
 * resolveAbsolutePath("/proj", "/proj/src", "utils/a.ts");
 * // → "/proj/src/utils/a.ts"
 * ```
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
