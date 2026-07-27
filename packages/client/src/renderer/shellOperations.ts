/**
 * Scrollback printers for classified shell (`command.run`) operations.
 *
 * @remarks
 * Safe commands get accent color + compact timing; cautious/dangerous/background
 * get secondary styling and fuller stdout/stderr after approval. Truncation
 * limits keep runaway command output from flooding the Ink history.
 */

import { beginBlockOutput } from "../state/agentStatus.js";
import { getTheme } from "../theme/themeManager.js";
import { appendBlock } from "./sink.js";
import type { BashClass } from "./types.js";

/** Shell-prompt glyph used by {@link printBash}. */
const BASH_OPERATION_ICON = "$";

/**
 * Prints the command line about to run, colored by classification.
 *
 * @remarks
 * `safe` uses accent color (trusted); other classes use secondary so they look
 * less “endorsed” before the user approves.
 *
 * @param command - Full command string.
 * @param classification - Risk / mode class from the file proxy.
 *
 * @example
 * ```ts
 * printBash("git status", "safe");
 * printBash("rm -rf build", "dangerous");
 * ```
 */
export const printBash = (command: string, classification: BashClass): void => {
  const theme = getTheme();
  const commandColor =
    classification === "safe" ? theme.textAccent : theme.textSecondary;

  appendBlock([
    `${commandColor}${BASH_OPERATION_ICON} Bash(${command})${theme.reset}`,
  ]);
};

/**
 * Prints compact exit code + duration for a completed **safe** command.
 *
 * @param exitCode - Process exit status.
 * @param durationMs - Wall time from start to finish, in milliseconds.
 *
 * @example
 * ```ts
 * printBashResult(0, 1530); // → "exit 0 · 1.5s"
 * ```
 */
export const printBashResult = (exitCode: number, durationMs: number): void => {
  const theme = getTheme();
  const durationSeconds = (durationMs / 1000).toFixed(1);
  appendBlock([
    `  ${theme.success}→ exit ${exitCode} · ${durationSeconds}s${theme.reset}`,
  ]);
};

/**
 * Prints that the user skipped running a command (run/skip prompt).
 */
export const printSkipped = (): void => {
  const theme = getTheme();
  appendBlock([
    `  ${theme.error}✗${theme.reset}  Skipped — command was not run.`,
  ]);
};

/**
 * Prints that the user asked for changes instead of approving (run/skip or
 * keep/undo prompts) — the action was not taken and feedback was sent back.
 */
export const printReviseRequested = (): void => {
  const theme = getTheme();
  appendBlock([
    `  ${theme.textSecondary}↺${theme.reset}  Revise requested — not applied. Sending feedback...`,
  ]);
};

/**
 * Prints that the user approved and the command is starting.
 */
export const printBashApproved = (): void => {
  const theme = getTheme();
  appendBlock([`  ${theme.success}✓${theme.reset}  Running…`]);
};

/**
 * Prints post-run status plus truncated stdout/stderr for non-safe commands.
 *
 * @remarks
 * Stdout is capped at **8** lines, stderr at **4**, so noisy tools stay
 * skimmable. When both streams are empty and `exitCode === 0`, shows
 * `(no output)`.
 *
 * @param exitCode - Process exit status.
 * @param stdout - Captured standard output.
 * @param stderr - Captured standard error (may include timeout markers).
 *
 * @example
 * ```ts
 * printBashRan(0, "ok\n", "");
 * ```
 */
export const printBashRan = (
  exitCode: number,
  stdout: string,
  stderr: string,
): void => {
  beginBlockOutput();
  const theme = getTheme();

  const outputLines = [
    `  ${theme.success}✓${theme.reset}  Finished (exit ${exitCode}).`,
  ];

  const stdoutTrimmed = stdout.trim();
  const stderrTrimmed = stderr.trim();

  if (stdoutTrimmed.length > 0) {
    // Cap lines — full dump belongs in an external viewer, not Ink scrollback.
    outputLines.push(
      `${theme.textSecondary}${stdoutTrimmed.split("\n").slice(0, 8).join("\n")}${theme.reset}`,
    );
  }

  if (stderrTrimmed.length > 0) {
    outputLines.push(
      `${theme.textSecondary}${stderrTrimmed.split("\n").slice(0, 4).join("\n")}${theme.reset}`,
    );
  }

  if (
    stdoutTrimmed.length === 0 &&
    stderrTrimmed.length === 0 &&
    exitCode === 0
  ) {
    outputLines.push(`${theme.textSecondary}  (no output)${theme.reset}`);
  }

  appendBlock(outputLines);
};

/**
 * Prints a short success confirmation for a completed mutating op.
 *
 * @param message - e.g. `"Written."`, `"Deleted."`, workspace set text.
 *
 * @example
 * ```ts
 * printSuccessOp("Written.");
 * ```
 */
export const printSuccessOp = (message: string): void => {
  const theme = getTheme();
  appendBlock([`  ${theme.success}✓${theme.reset}  ${message}`]);
};
