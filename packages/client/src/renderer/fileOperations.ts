/**
 * Scrollback printers for local file-proxy operations (read/write/delete/…).
 *
 * @remarks
 * Each `print*` mirrors a file-proxy route so the CLI history shows what the
 * agent is doing. Paths go through {@link formatDisplayPath}. Many mutating
 * ops call {@link beginBlockOutput} so the status bar yields to a history block.
 */

import type { DiffChunk } from "@loopycode/shared";
import { beginBlockOutput } from "../agentStatus.js";
import { renderDiffFromChunks } from "../diff/diffRenderer.js";
import { formatDisplayPath } from "../pathDisplay.js";
import { getTheme } from "../theme/themeManager.js";
import { appendBlock, appendDiff } from "./sink.js";
import type { DirEntry } from "./types.js";

/**
 * Glyphs that prefix operation lines in scrollback.
 *
 * @remarks
 * Chosen to skim like a file-tree / shell prompt (`▸`, `│`, `$`, `>`). Kept as
 * a single map so icons stay consistent across printers.
 */
const OPERATION_ICONS = {
  /** Expandable directory listing. */
  listDir: "▸",
  /** File read (tree-style bar). */
  read: "│",
  /** File write / modify. */
  write: "*",
  /** New file. */
  create: "+",
  /** New directory. */
  createDir: "+/",
  /** Delete. */
  delete: "-",
  /** Shell (unused here; see shellOperations). */
  bash: "$",
  /** Directory change. */
  cd: ">",
  /** Search / TokenSave lookup. */
  search: "/",
} as const;

/**
 * Builds a dim `icon Label(path)` line for low-emphasis ops (read, cd, search).
 *
 * @param icon - Prefix glyph from {@link OPERATION_ICONS}.
 * @param label - Operation verb shown to the user.
 * @param target - Absolute or relative path (shortened for display).
 * @returns ANSI-styled single line ending in theme reset.
 */
const operationLineDim = (
  icon: string,
  label: string,
  target: string,
): string => {
  const theme = getTheme();
  return `${theme.textSecondary}${icon} ${label}(${formatDisplayPath(target)})${theme.reset}`;
};

/**
 * Builds `icon Label(**path**)` with a bold path for high-emphasis mutations.
 *
 * @param icon - Prefix glyph from {@link OPERATION_ICONS}.
 * @param label - Operation verb.
 * @param target - Path shown bold inside parentheses.
 * @returns ANSI-styled single line.
 */
const operationLineBoldPath = (
  icon: string,
  label: string,
  target: string,
): string => {
  const theme = getTheme();
  return `${icon} ${label}(${theme.textBold}${formatDisplayPath(target)}${theme.reset})`;
};

/**
 * Prints a directory listing header with a ctrl+o expand hint.
 *
 * @param path - Directory being listed.
 *
 * @example
 * ```ts
 * printListDir("/proj/src");
 * ```
 */
export const printListDir = (path: string): void => {
  const theme = getTheme();
  // Hint is right-padded so it aligns visually with the operation label.
  appendBlock([
    `${theme.textSecondary}${OPERATION_ICONS.listDir} ListDir(${formatDisplayPath(path)})${theme.reset}          ${theme.textSecondary}(ctrl+o to expand)${theme.reset}`,
  ]);
};

/**
 * Prints a file-read operation line (dim styling).
 *
 * @param path - File being read.
 */
export const printRead = (path: string): void => {
  beginBlockOutput();
  appendBlock([operationLineDim(OPERATION_ICONS.read, "Read", path)]);
};

/**
 * Prints a TokenSave / search operation line (same visual weight as Read).
 *
 * @param label - Human label (e.g. from {@link tokenSaveHistoryLabel}).
 * @param target - Search query or resource target string.
 */
export const printTokenSaveOp = (label: string, target: string): void => {
  beginBlockOutput();
  appendBlock([operationLineDim(OPERATION_ICONS.search, label, target)]);
};

/** Cap on how many result lines print before truncating, same as printBashRan's stdout cap. */
const MAX_TOKENSAVE_RESULT_LINES = 8;

/**
 * Prints the real result body a TokenSave search/lookup call found, indented
 * beneath its query line from {@link printTokenSaveOp}.
 *
 * @remarks
 * Shows whatever the tool actually returned (file paths, symbol locations,
 * etc.) — there is no fixed schema, so this just echoes the tool's raw text
 * output the way {@link printBashRan} echoes command stdout. A blank/empty
 * result prints nothing.
 *
 * @param resultText - Raw text content returned by the TokenSave tool call.
 *
 * @example
 * ```ts
 * printTokenSaveResult("src/auth/login.ts:42\nsrc/auth/session.ts:18");
 * ```
 */
export const printTokenSaveResult = (resultText: string): void => {
  const trimmed = resultText.trim();
  if (trimmed.length === 0) {
    return;
  }

  const theme = getTheme();
  const resultLines = trimmed.split("\n");
  const shown = resultLines.slice(0, MAX_TOKENSAVE_RESULT_LINES);
  const omittedCount = resultLines.length - shown.length;

  const indentedLines = shown.map((line) => `    ${line}`).join("\n");
  const truncationNote =
    omittedCount > 0 ? `\n    … (${omittedCount} more line(s))` : "";

  appendBlock([
    `${theme.textSecondary}${indentedLines}${truncationNote}${theme.reset}`,
  ]);
};

/**
 * Prints an upcoming file write as a syntax-highlighted diff for approval.
 *
 * @remarks
 * Renders {@link DiffChunk}s via {@link renderDiffFromChunks}, then stores the
 * body under a `"Write <path>"` diff history card.
 *
 * @param path - File about to be written.
 * @param diffChunks - Unified-diff chunks (old → new).
 *
 * @example
 * ```ts
 * await printWrite("/proj/a.ts", chunks);
 * ```
 */
export const printWrite = async (
  path: string,
  diffChunks: DiffChunk[],
): Promise<void> => {
  beginBlockOutput();
  const diffBody = await renderDiffFromChunks(path, diffChunks);
  appendDiff(`Write ${formatDisplayPath(path)}`, diffBody);
};

/**
 * Prints a create-file header plus an indented content preview.
 *
 * @param path - File being created.
 * @param preview - Full or truncated file body to show beneath the header.
 */
export const printCreate = (path: string, preview: string): void => {
  beginBlockOutput();

  const outputLines = [
    operationLineBoldPath(OPERATION_ICONS.create, "Create", path),
    "",
    // Indent preview so it nests under the Create header visually.
    ...preview
      .split("\n")
      .map((previewLine) =>
        previewLine.length > 0 ? `    ${previewLine}` : "",
      ),
    "",
  ];

  appendBlock(outputLines);
};

/**
 * Prints a create-directory operation line (bold path).
 *
 * @param path - Directory being created.
 */
export const printCreateDir = (path: string): void => {
  beginBlockOutput();
  appendBlock([
    operationLineBoldPath(OPERATION_ICONS.createDir, "CreateDir", path),
    "",
  ]);
};

/**
 * Prints a delete operation with a permanent-removal warning.
 *
 * @param path - File or directory about to be deleted.
 */
export const printDelete = (path: string): void => {
  beginBlockOutput();
  const theme = getTheme();
  appendBlock([
    operationLineBoldPath(OPERATION_ICONS.delete, "Delete", path),
    "",
    `  ${theme.warning}⚠${theme.reset}  This permanently removes the file from disk.`,
    "",
  ]);
};

/**
 * Prints a cwd change (`cd`) operation line.
 *
 * @param path - New directory path.
 */
export const printCd = (path: string): void => {
  appendBlock([operationLineDim(OPERATION_ICONS.cd, "cd", path)]);
};

/**
 * Prints indented directory children after an expand (`ctrl+o`) action.
 *
 * @remarks
 * Directories get a `▸` + expand hint; files get `│`; unreadable entries get
 * a themed `!`. Indent is raw space count from the expand UI state.
 *
 * @param entries - Children to render.
 * @param indent - Leading spaces for nesting under the parent row.
 */
export const printListDirEntries = (
  entries: DirEntry[],
  indent: number,
): void => {
  const theme = getTheme();
  const indentationPadding = " ".repeat(indent);

  const entryLines = entries.map((directoryEntry) => {
    const entryIcon = directoryEntry.noRead
      ? `${theme.error}!${theme.reset}`
      : directoryEntry.isDirectory
        ? OPERATION_ICONS.listDir
        : OPERATION_ICONS.read;

    const expandHint = directoryEntry.isDirectory
      ? `  ${theme.textSecondary}(ctrl+o to expand)${theme.reset}`
      : "";

    return `${indentationPadding}  ${entryIcon} ${directoryEntry.name}${expandHint}`;
  });

  appendBlock(entryLines);
};
