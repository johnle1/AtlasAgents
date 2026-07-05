/**
 * Path display formatting and truncation utilities.
 *
 * @remarks
 * This module provides utilities for formatting file paths for display in the CLI,
 * including home directory abbreviation (~ substitution) and middle-truncation for
 * long paths to fit terminal width constraints.
 *
 * **Key functions:**
 * - `formatDisplayPath` — Replaces `/home/user` with `~` for brevity
 * - `truncatePathMiddle` — Cuts long paths with ellipsis while preserving start/end
 * - `buildPromptLabel` — Creates the CLI input prompt prefix
 * - `formatHumanError` — Converts OS errors to user-friendly messages
 */

import * as os from "node:os";
import * as path from "node:path";

// Cache the user's home directory to avoid repeated os.homedir() calls
const home = os.homedir();

/**
 * Converts an absolute file path to a display-friendly format with ~ abbreviation.
 *
 * @remarks
 * Replaces the home directory prefix with `~` for brevity in CLI output.
 * For example, `/home/user/Documents/file.txt` becomes `~/Documents/file.txt`.
 * Paths outside the home directory are returned unchanged.
 *
 * @param absolutePath - File system path (absolute or relative).
 * @returns Display path with ~ substitution, e.g., `"~/Documents/file.txt"`.
 *
 * @example
 * ```ts
 * formatDisplayPath("/home/user/project"); // "~/project"
 * formatDisplayPath("/tmp/file.txt"); // "/tmp/file.txt"
 * formatDisplayPath("/home/user"); // "~"
 * ```
 */
export const formatDisplayPath = (absolutePath: string): string => {
  const resolved = path.resolve(absolutePath);
  if (resolved === home) {
    return "~";
  }
  if (resolved.startsWith(home + path.sep)) {
    return "~" + resolved.slice(home.length);
  }
  return resolved;
};

/**
 * Truncates a display path to a maximum length by replacing the middle with an ellipsis.
 *
 * @remarks
 * Preserves the start and end of the path for readability while fitting within
 * terminal width constraints. For example, `~/very/long/path/to/file.txt` with maxLen=20
 * becomes `~/very…file.txt`.
 *
 * The head (start) gets one more character than the tail (end) when the split is uneven,
 * favoring the directory structure over the filename.
 *
 * @param displayPath - Path to potentially truncate (e.g., from formatDisplayPath).
 * @param maxLen - Maximum length after truncation (default 40 characters).
 * @returns Path truncated to maxLen if needed, otherwise unchanged.
 *
 * @example
 * ```ts
 * truncatePathMiddle("~/Documents/project/file.txt", 20);
 * "~/Doc…file.txt"
 * truncatePathMiddle("~/short.txt", 20);
 * "~/short.txt" (unchanged)
 * ```
 */
export const truncatePathMiddle = (
  displayPath: string,
  maxLen = 40,
): string => {
  if (displayPath.length <= maxLen) {
    return displayPath;
  }

  const keep = maxLen - 1; // Reserve 1 character for ellipsis
  const head = Math.ceil(keep / 2); // Favors showing start of path
  const tail = Math.floor(keep / 2); // Shows end of path

  return (
    displayPath.slice(0, head) +
    "…" +
    displayPath.slice(displayPath.length - tail)
  );
};

/**
 * Returns the readline input prompt prefix.
 *
 * @remarks
 * Currently returns a fixed `> ` string. The cwd parameter is unused but kept
 * for call-site compatibility in case future implementations want to show
 * the working directory in the prompt.
 *
 * @param cwd - Current working directory (unused; kept for API compatibility).
 * @returns Prompt string `> `.
 *
 * @example
 * ```ts
 * const prompt = buildPromptLabel("/home/user/project");
 * console.log(prompt); // "> "
 * ```
 */
export const buildPromptLabel = (cwd: string): string => "> ";

/**
 * Converts Node.js file system errors into human-friendly error messages.
 *
 * @remarks
 * Maps POSIX error codes to readable messages and formats the file path with
 * ~ substitution. Handles common errors like ENOENT (not found), EACCES/EPERM
 * (permission denied), EISDIR (is directory), and ENOTDIR (not a directory).
 *
 * For unknown error codes, falls back to the error's message string.
 *
 * @param op - Operation name e.g., "read", "write", "delete".
 * @param filePath - File system path where error occurred.
 * @param err - Error object from file system operation.
 * @returns User-friendly error message with formatted path.
 *
 * @example
 * ```ts
 * try {
 *   fs.readFileSync('/home/user/missing.txt');
 * } catch (err) {
 *   const msg = formatHumanError('read', '/home/user/missing.txt', err);
 *   console.log(msg); // "Cannot read ~/missing.txt — file or directory does not exist."
 * }
 * ```
 */
export const formatHumanError = (
  op: string,
  filePath: string,
  err: unknown,
): string => {
  const code = (err as NodeJS.ErrnoException).code;
  const display = formatDisplayPath(filePath);

  if (code === "ENOENT") {
    return `Cannot ${op} ${display} — file or directory does not exist.`;
  }
  if (code === "EACCES" || code === "EPERM") {
    return `Cannot ${op} ${display} — permission denied.`;
  }
  if (code === "EISDIR") {
    return `Cannot ${op} ${display} — path is a directory.`;
  }
  if (code === "ENOTDIR") {
    return `Cannot ${op} ${display} — not a directory.`;
  }

  const message = err instanceof Error ? err.message : String(err);
  return `Cannot ${op} ${display} — ${message}`;
};
