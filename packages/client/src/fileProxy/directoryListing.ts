/**
 * Directory tree listing and interactive expand helpers for the file proxy.
 *
 * @remarks
 * Used by `file.list_dir` and UI expand actions. Always calls
 * {@link assertInsideRoot} on joined paths and skips {@link SKIP_DIR_NAMES}.
 * Some helpers also update list/expand UI state via `listExpandState` / renderer.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { markExpanded, pushListDir } from "../listExpandState.js";
import { printListDir, printListDirEntries } from "../renderer.js";
import { SKIP_DIR_NAMES } from "./constants.js";
import { assertInsideRoot } from "./pathUtils.js";
import type { DispatchContext } from "./types.js";

/**
 * Walks `currentDir` up to `depth` levels and returns an indented name tree.
 *
 * @remarks
 * Also prints the cwd and pushes expand-state for the CLI tree UI. Read errors
 * on individual directories are skipped (permission / race) rather than failing
 * the whole tree. Depth `0` yields an empty string (no walk levels).
 *
 * @param context - Needs `workspaceRoot` and `currentDir`.
 * @param depth - Maximum nesting level to include (caller usually clamps ≥ 1).
 * @returns Newline-joined entry names with two spaces of indent per level.
 *
 * @example
 * ```ts
 * const text = await listStructure(
 *   { workspaceRoot: "/proj", currentDir: "/proj" },
 *   2,
 * );
 * ```
 */
export const listStructure = async (
  context: Pick<DispatchContext, "workspaceRoot" | "currentDir">,
  depth: number,
): Promise<string> => {
  printListDir(context.currentDir);
  pushListDir(context.currentDir, 0);

  const structureLines: string[] = [];

  const walkDirectory = async (
    directoryPath: string,
    currentLevel: number,
  ): Promise<void> => {
    if (currentLevel >= depth) {
      return;
    }

    let directoryEntries;
    try {
      directoryEntries = await fs.readdir(directoryPath, {
        withFileTypes: true,
      });
    } catch {
      // Unreadable dirs (permissions / deleted mid-walk) — skip rather than fail.
      return;
    }

    for (const entry of directoryEntries) {
      if (SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(directoryPath, entry.name);
      assertInsideRoot(context.workspaceRoot, absolutePath);

      const indentation = "  ".repeat(currentLevel);
      structureLines.push(`${indentation}${entry.name}`);

      if (entry.isDirectory() && currentLevel + 1 < depth) {
        await walkDirectory(absolutePath, currentLevel + 1);
      }
    }
  };

  await walkDirectory(context.currentDir, 0);
  return structureLines.join("\n");
};

/**
 * Lists one directory’s entries (name + isDirectory), skipping noise dirs.
 *
 * @param workspaceRoot - Sandbox root for {@link assertInsideRoot}.
 * @param dirPath - Directory to list (resolved to absolute before checks).
 * @returns Entry metadata; does not recurse.
 * @throws {@link Error} When `dirPath` escapes the workspace or cannot be read.
 *
 * @example
 * ```ts
 * const entries = await listDirectoryEntries("/proj", "/proj/src");
 * ```
 */
export const listDirectoryEntries = async (
  workspaceRoot: string,
  dirPath: string,
): Promise<Array<{ name: string; isDirectory: boolean }>> => {
  const absolutePath = path.resolve(dirPath);
  assertInsideRoot(workspaceRoot, absolutePath);

  const directoryEntries = await fs.readdir(absolutePath, {
    withFileTypes: true,
  });

  return directoryEntries
    .filter((entry) => !SKIP_DIR_NAMES.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
};

/**
 * Expands one directory in the CLI list UI (print children + remember state).
 *
 * @remarks
 * Marks the path expanded, prints children at `indent + 4`, and registers
 * nested directories for further expand actions.
 *
 * @param context - Workspace root plus a `listDirectoryEntries` bound function.
 * @param dirPath - Directory being expanded.
 * @param indent - Current visual indent of the parent row.
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
  const absolutePath = path.resolve(dirPath);
  markExpanded(absolutePath);

  const directoryEntries = await context.listDirectoryEntries(absolutePath);

  // +4 matches the interactive tree’s nested indent step in the renderer.
  printListDirEntries(
    directoryEntries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
    })),
    indent + 4,
  );

  for (const entry of directoryEntries) {
    if (entry.isDirectory) {
      pushListDir(path.join(absolutePath, entry.name), indent + 4);
    }
  }
};
