/**
 * Cross-platform helpers to discover the post-command working directory.
 *
 * @remarks
 * Shell `cd` inside a child process does not update Node’s notion of cwd.
 * Commands are wrapped so they print {@link CWD_MARKER} + `pwd`/`cd` after
 * finishing; handlers strip the marker and call `setCurrentDir` when the path
 * stayed inside the workspace.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Unique stdout sentinel prefixing the reported working directory.
 *
 * @remarks
 * Chosen to be unlikely in normal tool output. Handlers use the **last**
 * occurrence so nested or echoed markers do not steal the real trailing path.
 */
export const CWD_MARKER = "##LOOPY_CWD##";

/**
 * Whether the host should use `cmd.exe` wrapping instead of POSIX `/bin/sh`.
 *
 * @returns `true` on `win32`, otherwise `false`.
 */
export const isWindowsShell = (): boolean => process.platform === "win32";

/**
 * Wraps `command` so it prints {@link CWD_MARKER}`+cwd` and preserves exit code.
 *
 * @remarks
 * **Unix:** brace-group the command, capture `$?`, `printf` marker + `$(pwd)`,
 * then `exit` with the captured status.
 *
 * **Windows:** `setlocal enabledelayedexpansion`, run the command, capture
 * `!errorlevel!` and `!cd!`, then `exit /b`. Do **not** call `endlocal` before
 * exit — that would discard `__loopy_status` before the exit code is applied.
 *
 * @param command - Original user/agent command line.
 * @param isWindows - Force Windows syntax; defaults to {@link isWindowsShell}.
 * @returns Shell snippet safe to pass to {@link runShell}.
 *
 * @example
 * ```ts
 * wrapCommandForCwdTracking("cd src", false);
 * // → `{ cd src; }; __loopy_status=$?; printf '%s' '##LOOPY_CWD##'"$(pwd)"; exit $__loopy_status`
 * ```
 */
export const wrapCommandForCwdTracking = (
  command: string,
  isWindows: boolean = isWindowsShell(),
): string => {
  if (isWindows) {
    // Delayed expansion required so !errorlevel! / !cd! reflect post-command state.
    // Intentionally no `endlocal` before `exit /b` — it would drop __loopy_status.
    return `setlocal enabledelayedexpansion & ${command} & set __loopy_status=!errorlevel! & echo ${CWD_MARKER}!cd! & exit /b !__loopy_status!`;
  }

  return `{ ${command}; }; __loopy_status=$?; printf '%s' '${CWD_MARKER}'"$(pwd)"; exit $__loopy_status`;
};

/**
 * Result of stripping {@link CWD_MARKER} from wrapped shell stdout.
 */
export type CwdExtractionResult = {
  /** Stdout with the marker and path suffix removed. */
  cleanedStdout: string;

  /** Canonical cwd after the command, when a non-empty path was present. */
  newCwd?: string;
};

/**
 * Parses the trailing CWD marker written by {@link wrapCommandForCwdTracking}.
 *
 * @remarks
 * Uses `lastIndexOf` so earlier accidental marker text in command output does
 * not win. Empty paths after the marker are ignored (returns cleaned stdout only).
 *
 * @param stdout - Raw stdout from a wrapped command.
 * @returns Cleaned stdout plus optional {@link canonicalizeTrackedCwd} path.
 *
 * @example
 * ```ts
 * extractCwdFromOutput("list\n##LOOPY_CWD##/tmp\n");
 * → { cleanedStdout: "list\n", newCwd: "/tmp" } (after realpath when possible)
 * ```
 */
export const extractCwdFromOutput = (stdout: string): CwdExtractionResult => {
  // Last marker wins — wrapped footer is always appended at the end.
  const markerIndex = stdout.lastIndexOf(CWD_MARKER);
  if (markerIndex === -1) {
    return { cleanedStdout: stdout };
  }

  const cleanedStdout = stdout.slice(0, markerIndex);
  const rawCwd = stdout
    .slice(markerIndex + CWD_MARKER.length)
    .replace(/\r?\n$/, "")
    .trim();

  if (!rawCwd) {
    return { cleanedStdout };
  }

  return { cleanedStdout, newCwd: canonicalizeTrackedCwd(rawCwd) };
};

/**
 * Normalizes a tracked cwd for storage and equality checks.
 *
 * @remarks
 * Prefers `fs.realpathSync` so symlinks compare equal to their targets. Falls
 * back to `path.resolve` when the path does not exist yet (e.g. race after mkdir).
 *
 * @param cwd - Absolute or relative directory path from the shell.
 * @returns Canonical absolute path string.
 */
export const canonicalizeTrackedCwd = (cwd: string): string => {
  try {
    return fs.realpathSync(cwd);
  } catch {
    // Path may not exist yet; still normalize `.` / `..` segments.
    return path.resolve(cwd);
  }
};

/**
 * Compares two cwd strings for equality with platform case rules.
 *
 * @remarks
 * Both sides are canonicalized first. On Windows, comparison is case-insensitive;
 * on POSIX it is case-sensitive.
 *
 * @param left - First path.
 * @param right - Second path.
 * @returns `true` when both denote the same directory under host rules.
 *
 * @example
 * ```ts
 * trackedCwdsEqual("/tmp", "/tmp"); // true
 * Windows: trackedCwdsEqual("C:\\A", "c:\\a") → true
 * ```
 */
export const trackedCwdsEqual = (left: string, right: string): boolean => {
  const a = canonicalizeTrackedCwd(left);
  const b = canonicalizeTrackedCwd(right);

  if (isWindowsShell()) {
    return a.toLowerCase() === b.toLowerCase();
  }

  return a === b;
};
