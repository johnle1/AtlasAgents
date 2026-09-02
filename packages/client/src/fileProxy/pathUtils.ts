/**
 * Workspace path sandbox helpers for the file proxy.
 *
 * @remarks
 * All absolute paths used for read/write/delete/cd must pass
 * {@link assertInsideRoot}. Relative resolution goes through
 * {@link resolveAbsolutePath}, which also rejects absolute caller inputs so the
 * agent cannot point outside the workspace via `/etc/...`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolves `candidate` to its real (symlink-free) path, falling back to the
 * realpath of its closest existing ancestor when the path itself (or a
 * trailing segment) doesn't exist yet.
 *
 * @remarks
 * `fs.realpathSync` throws unless the full path exists, which is too strict
 * for a path being validated *before* creation (a new file under `mkdir -p`,
 * or a not-yet-existing target of `file.write`). Recursing on `dirname`
 * still dereferences every symlink that *does* exist — including one placed
 * inside the workspace that points outside it — so a still-nonexistent
 * suffix cannot be used to dodge the check.
 *
 * @param candidate - Absolute path to resolve.
 * @returns The real path, with any nonexistent suffix preserved verbatim.
 */
const realpathOrClosestAncestor = (candidate: string): string => {
  try {
    return fs.realpathSync(candidate);
  } catch {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return candidate;
    }
    return path.join(realpathOrClosestAncestor(parent), path.basename(candidate));
  }
};

/**
 * Returns whether `candidate` sits on or under `workspaceRoot`.
 *
 * @remarks
 * Both inputs are resolved via {@link realpathOrClosestAncestor} before
 * comparing, so a symlink inside the workspace that points outside it (e.g.
 * `workspaceRoot/link -> /etc`) cannot pass this check just because its own
 * path string is a descendant of `workspaceRoot`. Uses
 * `path.relative(root, candidate)` on the resolved forms:
 * - a result starting with `..` means the candidate is an ancestor (traversal)
 * - an absolute relative result on Windows means a different drive / root escape
 *
 * Used by auto-mode keepUndo confinement — {@link assertInsideRoot} throws
 * the same check.
 *
 * @param workspaceRoot - Absolute sandbox root.
 * @param candidate - Absolute path to test.
 * @returns `true` when `candidate` is the root or a descendant.
 *
 * @example
 * ```ts
 * isInsideRoot("/proj", "/proj/src/a.ts"); // true
 * isInsideRoot("/proj", "/etc/passwd"); // false
 * ```
 */
export const isInsideRoot = (
  workspaceRoot: string,
  candidate: string,
): boolean => {
  const resolvedRoot = realpathOrClosestAncestor(workspaceRoot);
  const resolvedCandidate = realpathOrClosestAncestor(candidate);
  const relativePathFromRoot = path.relative(resolvedRoot, resolvedCandidate);
  return (
    !relativePathFromRoot.startsWith("..") &&
    !path.isAbsolute(relativePathFromRoot)
  );
};

/**
 * Throws if `candidate` is outside `workspaceRoot`.
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
  if (!isInsideRoot(workspaceRoot, candidate)) {
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
