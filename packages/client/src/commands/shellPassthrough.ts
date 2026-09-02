/**
 * Local `!command` shell passthrough.
 *
 * @remarks
 * A prompt line starting with `!` runs the rest as a local shell command via
 * {@link runShell}. It never reaches {@link CommandHandler} or the agent
 * task stream, and — unlike `command.run`, which the *agent* issues — it
 * never prompts for approval: the user typed this command on their own
 * prompt line, so there is no second party to ask. A `"dangerous"`
 * classification still prints a warning line before running, purely
 * informational.
 *
 * @example
 * ```ts
 * const command = parseBang("!echo hi"); // "echo hi"
 * const entries = await handleBang({ command, runShell, cwd, timeoutMs, classifyCommand });
 * ```
 */

import type { HistoryVariant } from "../ui/types.js";
import type { BashClass } from "../renderer.js";
import type { ShellResult } from "../fileProxy/types.js";

/**
 * One history row produced by a bang command.
 */
export type BangHistoryEntry = {
  kind: "text";
  text: string;
  variant?: HistoryVariant;
};

/**
 * Extracts the shell command from a `!` line, or `null` if the line is not bang.
 *
 * @param line - Trimmed prompt text.
 * @returns The command (possibly empty for `!` alone), or `null`.
 */
export const parseBang = (line: string): string | null => {
  if (!line.startsWith("!")) {
    return null;
  }
  return line.slice(1).trim();
};

/**
 * Dependencies for {@link handleBang} so unit tests inject a fake `runShell`.
 */
export type HandleBangOptions = {
  /** Command after `!`; empty means print the usage hint. */
  command: string;
  runShell: (
    command: string,
    cwd: string,
    timeoutMs?: number,
  ) => Promise<ShellResult>;
  cwd: string;
  timeoutMs: number;
  /** Used only to decide whether to print the dangerous-command warning — never gates execution (see module remarks). */
  classifyCommand: (command: string) => BashClass;
};

const usageHint = (): BangHistoryEntry[] => [
  {
    kind: "text",
    text: "Usage: !<command> — run a local shell command (not sent to the agent).",
    variant: "system",
  },
];

/**
 * Runs a bang command and returns history entries for stdout/stderr/exit.
 *
 * @param options - Injected shell, cwd, and classifier.
 * @returns History rows to append. Does not throw on non-zero exit.
 */
export const handleBang = async (
  options: HandleBangOptions,
): Promise<BangHistoryEntry[]> => {
  const { command, runShell, cwd, timeoutMs, classifyCommand } = options;

  if (command.length === 0) {
    return usageHint();
  }

  const warnings: BangHistoryEntry[] = [];
  if (classifyCommand(command) === "dangerous") {
    warnings.push({
      kind: "text",
      text: "⚠ Dangerous command.",
      variant: "warning",
    });
  }

  const result = await runShell(command, cwd, timeoutMs);
  // cmd.exe (Windows) terminates output with \r\n; strip either form.
  const stdout = result.stdout.replace(/\r?\n$/, "");
  const stderr = result.stderr.replace(/\r?\n$/, "");

  const outputEntries: BangHistoryEntry[] = [];
  if (stdout.length > 0) {
    outputEntries.push({ kind: "text", text: stdout, variant: "secondary" });
  }
  if (stderr.length > 0) {
    outputEntries.push({
      kind: "text",
      text: stderr,
      variant: result.exitCode === 0 ? "secondary" : "warning",
    });
  }
  if (result.exitCode !== 0) {
    outputEntries.push({
      kind: "text",
      text: `exit ${result.exitCode}`,
      variant: "warning",
    });
  }
  if (outputEntries.length === 0) {
    outputEntries.push({ kind: "text", text: "(no output)", variant: "secondary" });
  }
  return [...warnings, ...outputEntries];
};
