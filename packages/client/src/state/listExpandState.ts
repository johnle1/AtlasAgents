/**
 * Tracks directories shown in file listings so the user can expand them with Ctrl+O.
 *
 * @remarks
 * When the client prints a directory tree (via `list` / `listStructure`), each
 * listed directory is registered with {@link pushListDir}. The user can press
 * **Ctrl+O** to expand the most recently listed directory that has not yet
 * been expanded; {@link peekUnexpanded} returns that candidate.
 *
 * State is module-scoped and in-memory — call {@link clearExpandState} when
 * starting a fresh listing so stale paths are not offered for expansion.
 *
 * @example
 * ```ts
 * clearExpandState();
 * pushListDir("/workspace/src", 0);
 * pushListDir("/workspace/src/utils", 4);
 *
 * const next = peekUnexpanded();
 * if (next.found && next.entry) {
 *   await expandDirectory(next.entry.absolutePath, next.entry.indent);
 *   markExpanded(next.entry.absolutePath);
 * }
 * ```
 */

/**
 * One directory entry eligible for interactive expansion.
 *
 * @remarks
 * `indent` matches the column offset used when rendering the listing so
 * expanded children align with their parent row.
 */
export type ListExpandEntry = {
  /** Absolute path to the directory on disk. */
  absolutePath: string;

  /**
   * Visual nesting depth in the rendered listing (`0` = root of the listing).
   *
   * @remarks
   * Indent is measured in spaces, not directory depth — nested rows use
   * larger values (e.g. `4`, `8`) to match renderer padding.
   */
  indent: number;
};

/** Directories in listing order; the last push is the newest candidate. */
const stack: ListExpandEntry[] = [];

/** Paths the user has already expanded via Ctrl+O. */
const expanded = new Set<string>();

/**
 * Registers a directory from a file listing for possible Ctrl+O expansion.
 *
 * @remarks
 * Each call appends to an internal stack. {@link peekUnexpanded} scans from
 * newest to oldest and skips paths in {@link markExpanded}.
 *
 * @param absolutePath - Full path to the directory that was printed.
 * @param indent - Column offset for nested rendering. Defaults to `0`.
 *
 * @example
 * ```ts
 * pushListDir("/home/user/project/src", 0);
 * pushListDir("/home/user/project/src/lib", 4);
 * ```
 */
export const pushListDir = (absolutePath: string, indent = 0): void => {
  stack.push({ absolutePath, indent });
};

/**
 * Marks a directory as expanded so Ctrl+O will not select it again.
 *
 * @param absolutePath - Path previously returned by {@link peekUnexpanded}.
 *
 * @example
 * ```ts
 * markExpanded("/home/user/project/src");
 * ```
 */
export const markExpanded = (absolutePath: string): void => {
  expanded.add(absolutePath);
};

/**
 * Returns whether a directory has already been expanded.
 *
 * @param absolutePath - Path to check.
 * @returns `true` if {@link markExpanded} was called for this path.
 */
export const isExpanded = (absolutePath: string): boolean =>
  expanded.has(absolutePath);

/**
 * Returns the newest listed directory that has not yet been expanded.
 *
 * @remarks
 * Scans the internal stack from end to start (LIFO) and returns the first
 * entry whose path is absent from the expanded set. The `found` discriminant
 * lets callers narrow `entry` without optional chaining on `undefined`.
 *
 * @returns A result object. When `found` is `true`, `entry` is defined.
 *   When `found` is `false`, every stacked directory is expanded or the
 *   stack is empty.
 *
 * @example
 * ```ts
 * const result = peekUnexpanded();
 * if (result.found && result.entry) {
 *   await fileProxy.expandDirectory(
 *     result.entry.absolutePath,
 *     result.entry.indent,
 *   );
 * }
 * ```
 *
 * @example <caption>No directories left to expand</caption>
 * ```ts
 * const result = peekUnexpanded();
 * if (!result.found) {
 *    All listed directories are expanded or none were pushed.
 * }
 * ```
 */
export const peekUnexpanded = (): {
  found: boolean;
  entry?: ListExpandEntry;
} => {
  // Newest listings are at the end — walk backwards for the latest candidate.
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    if (entry && !expanded.has(entry.absolutePath)) {
      return { found: true, entry };
    }
  }
  return { found: false };
};

/**
 * Resets all expansion tracking for a new file listing session.
 *
 * @remarks
 * Clears both the directory stack and the expanded-path set. Call this
 * before rendering a new tree so Ctrl+O does not target directories from
 * a previous command.
 *
 * @example
 * ```ts
 * clearExpandState();
 * await listStructure(context, 2);
 * ```
 */
export const clearExpandState = (): void => {
  stack.length = 0;
  expanded.clear();
};
