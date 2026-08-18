/**
 * File-system route handlers for the local file proxy.
 *
 * @remarks
 * Each export matches a `file.*` {@link ClientRoute}. Mutating ops
 * (write / create / delete) show UI feedback and gate on
 * {@link requestApproval}. Paths always go through
 * `context.resolveAbsolute` (or search post-filters) so work stays inside the
 * workspace root.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import fg from "fast-glob";
import { computeDiff, formatDiffPlain } from "@atlasagents/shared";
import { formatDisplayPath } from "../../utils/pathDisplay.js";
import {
  printCd,
  printCreateDir,
  printDelete,
  printRead,
  printSkipped,
  printSuccessOp,
  printWrite,
} from "../../renderer.js";
import {
  printDeclineFeedback,
  requestApprovalWithFeedback,
} from "../../ui/approvalFlow.js";
import { listStructure } from "../directoryListing.js";
import { assertInsideRoot, requireNonEmptyPath } from "../pathUtils.js";
import type { DispatchContext } from "../types.js";

const KEEP_UNDO_REVISE = "What should change?";
const KEEP_UNDO_EDIT_REVISE = "What should change about this edit?";

/**
 * Builds a keep/undo prompt for a file mutation.
 */
const requestKeepUndo = (contextLabel: string, revisePrompt: string) =>
  requestApprovalWithFeedback({ type: "keepUndo", contextLabel }, revisePrompt);

/**
 * Reads a UTF-8 file relative to the proxy cwd.
 *
 * @param context - Dispatch context with `resolveAbsolute`.
 * @param requestBody - Expects `{ path: string }`.
 * @returns `{ content }` with the file text.
 * @throws {@link Error} When `path` is missing, escapes the root, or read fails.
 *
 * @example
 * ```ts
 * await handleFileRead(context, { path: "src/index.ts" });
 * → { content: "…" }
 * ```
 */
export const handleFileRead = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  const filePath = requireNonEmptyPath(String(requestBody.path ?? ""));
  const absolutePath = context.resolveAbsolute(filePath);
  printRead(absolutePath);
  const fileContent = await fs.readFile(absolutePath, "utf-8");
  return { content: fileContent };
};

/**
 * Writes a file after showing a diff and receiving keep/undo approval.
 *
 * @remarks
 * Missing files (ENOENT) are treated as empty previous content. Other read
 * errors propagate. On approval, parent dirs are created recursively.
 *
 * @param context - Dispatch context with `resolveAbsolute`.
 * @param requestBody - Expects `{ path: string, content?: string }`.
 * @returns `{ accepted: true, diff }` or `{ accepted: false }` if skipped.
 * @throws {@link Error} On path / unexpected FS errors.
 *
 * @example
 * ```ts
 * await handleFileWrite(context, { path: "a.ts", content: "export {}\n" });
 * ```
 */
export const handleFileWrite = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  const filePath = requireNonEmptyPath(String(requestBody.path ?? ""));
  const newContent = String(requestBody.content ?? "");
  const absolutePath = context.resolveAbsolute(filePath);

  let previousContent = "";
  try {
    previousContent = await fs.readFile(absolutePath, "utf-8");
  } catch (error) {
    // Only swallow "file does not exist yet" — other errno codes are real failures.
    const errnoCode =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (errnoCode !== "ENOENT") {
      throw error;
    }
  }

  const diffChunks = computeDiff(previousContent, newContent);
  await printWrite(absolutePath, diffChunks);

  const { approved, feedback } = await requestKeepUndo(
    `Apply changes to ${formatDisplayPath(absolutePath)}`,
    KEEP_UNDO_EDIT_REVISE,
  );

  if (!approved) {
    printDeclineFeedback(feedback);
    return { accepted: false, feedback };
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, newContent, "utf-8");
  printSuccessOp("Written.");

  return {
    accepted: true,
    diff: formatDiffPlain(diffChunks, absolutePath),
  };
};

/**
 * Returns a hierarchical directory listing as text.
 *
 * @param context - Needs cwd + workspace for {@link listStructure}.
 * @param requestBody - Optional `{ depth?: number }` (floored, minimum `1`).
 * @returns `{ text }` tree string.
 */
export const handleFileListDir = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  // depth≤0 would dump empty trees; floor rejects floats like 1.9 → 1 level intent.
  const traversalDepth = Math.max(
    1,
    Math.floor(Number(requestBody.depth ?? 1)),
  );
  const directoryStructure = await listStructure(context, traversalDepth);
  return { text: directoryStructure };
};

/**
 * Glob-searches under the workspace root for files and directories.
 *
 * @remarks
 * Ignores `node_modules` / `dist` / `.git`. Each hit is re-resolved and filtered
 * through {@link assertInsideRoot} so crafted globs cannot escape the sandbox.
 *
 * @param context - Provides `workspaceRoot`.
 * @param requestBody - Expects `{ pattern: string }` (non-empty).
 * @returns `{ paths: string[] }` of absolute matches.
 * @throws {@link Error} When `pattern` is empty.
 */
export const handleFileSearch = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  const searchPattern = requireNonEmptyPath(
    String(requestBody.pattern ?? ""),
    "pattern",
  );

  const matchedPaths = await fg(searchPattern, {
    cwd: context.workspaceRoot,
    dot: false,
    onlyFiles: false,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
  });

  // Defense in depth: drop anything that resolves outside the root after glob.
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
 * Creates a directory (recursive) after keep/undo approval.
 *
 * @param context - Dispatch context with `resolveAbsolute`.
 * @param requestBody - Expects `{ path: string }`.
 * @returns `{ created: true }` or `{ created: false }` if skipped.
 * @throws {@link Error} On path / mkdir failure.
 */
export const handleFileCreateDir = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  const directoryPath = requireNonEmptyPath(String(requestBody.path ?? ""));
  const absolutePath = context.resolveAbsolute(directoryPath);
  printCreateDir(absolutePath);

  const { approved } = await requestKeepUndo(
    `Create directory ${formatDisplayPath(absolutePath)}`,
    KEEP_UNDO_REVISE,
  );

  if (!approved) {
    printSkipped();
    return { created: false };
  }

  await fs.mkdir(absolutePath, { recursive: true });
  printSuccessOp("Directory created.");
  return { created: true };
};

/**
 * Deletes a single file after keep/undo approval.
 *
 * @param context - Dispatch context with `resolveAbsolute`.
 * @param requestBody - Expects `{ path: string }`.
 * @returns `{ deleted: true }` or `{ deleted: false }` if skipped.
 * @throws {@link Error} On path / unlink failure.
 */
export const handleFileDeleteFile = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  const filePath = requireNonEmptyPath(String(requestBody.path ?? ""));
  const absolutePath = context.resolveAbsolute(filePath);
  printDelete(absolutePath);

  const { approved } = await requestKeepUndo(
    `Delete file ${formatDisplayPath(absolutePath)}`,
    KEEP_UNDO_REVISE,
  );

  if (!approved) {
    printSkipped();
    return { deleted: false };
  }

  await fs.unlink(absolutePath);
  printSuccessOp("Deleted.");
  return { deleted: true };
};

/**
 * Recursively deletes a directory after keep/undo approval.
 *
 * @remarks
 * Uses `fs.rm({ recursive: true, force: true })` — irreversible for the tree.
 *
 * @param context - Dispatch context with `resolveAbsolute`.
 * @param requestBody - Expects `{ path: string }`.
 * @returns `{ deleted: true }` or `{ deleted: false }` if skipped.
 * @throws {@link Error} On path / rm failure.
 */
export const handleFileDeleteDir = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  const directoryPath = requireNonEmptyPath(String(requestBody.path ?? ""));
  const absolutePath = context.resolveAbsolute(directoryPath);
  printDelete(absolutePath);

  const { approved } = await requestKeepUndo(
    `Delete directory ${formatDisplayPath(absolutePath)}`,
    KEEP_UNDO_REVISE,
  );

  if (!approved) {
    printSkipped();
    return { deleted: false };
  }

  await fs.rm(absolutePath, { recursive: true, force: true });
  printSuccessOp("Deleted.");
  return { deleted: true };
};

/**
 * Changes the proxy current working directory to a workspace-relative path.
 *
 * @remarks
 * Requires the target to exist and be a directory. Updates cwd via
 * `context.setCurrentDir` (which notifies `onCwdChanged`).
 *
 * @param context - Dispatch context.
 * @param requestBody - Expects `{ path: string }`.
 * @returns `{ cwd }` absolute new directory.
 * @throws {@link Error} When missing, not a directory, or outside the root.
 */
export const handleFileCd = async (
  context: DispatchContext,
  requestBody: Record<string, unknown>,
): Promise<unknown> => {
  const targetPath = requireNonEmptyPath(String(requestBody.path ?? ""));
  const absolutePath = context.resolveAbsolute(targetPath);
  const fileStats = await fs.stat(absolutePath);

  if (!fileStats.isDirectory()) {
    throw new Error("Not a directory");
  }

  context.setCurrentDir(absolutePath);
  printCd(absolutePath);
  return { cwd: absolutePath };
};

/**
 * Returns the proxy’s current working directory without UI side effects.
 *
 * @param context - Dispatch context.
 * @returns Promise of `{ cwd: context.currentDir }`.
 */
export const handleFileGetCwd = (context: DispatchContext): Promise<unknown> =>
  Promise.resolve({ cwd: context.currentDir });
