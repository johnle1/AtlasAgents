/**
 * Local `!command` shell passthrough.
 *
 * @remarks
 * A prompt line starting with `!` runs the rest as a local shell command via
 * {@link runShell}. It never reaches {@link CommandHandler} or the agent
 * task stream. Non-`"safe"` commands reuse the same run/skip approval (and
 * session allowlist) as `command.run`.
 *
 * @example
 * ```ts
 * const command = parseBang("!echo hi"); // "echo hi"
 * const entries = await handleBang({ command, runShell, cwd, timeoutMs, ... });
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
  classifyCommand: (command: string) => BashClass;
  requestApproval: (command: string) => Promise<boolean>;
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
 * @param options - Injected shell, cwd, classifier, and approval.
 * @returns History rows to append. Does not throw on non-zero exit.
 */
export const handleBang = async (
  options: HandleBangOptions,
): Promise<BangHistoryEntry[]> => {
  const { command, runShell, cwd, timeoutMs, classifyCommand, requestApproval } =
    options;

  if (command.length === 0) {
    return usageHint();
  }

  const classification = classifyCommand(command);
  if (classification !== "safe") {
    const approved = await requestApproval(command);
    if (!approved) {
      return [
        {
          kind: "text",
          text: "Command skipped.",
          variant: "warning",
        },
      ];
    }
  }

  const result = await runShell(command, cwd, timeoutMs);
  const entries: BangHistoryEntry[] = [];
  const stdout = result.stdout.replace(/\n$/, "");
  const stderr = result.stderr.replace(/\n$/, "");

  if (stdout.length > 0) {
    entries.push({ kind: "text", text: stdout, variant: "secondary" });
  }
  if (stderr.length > 0) {
    entries.push({
      kind: "text",
      text: stderr,
      variant: result.exitCode === 0 ? "secondary" : "warning",
    });
  }
  if (result.exitCode !== 0) {
    entries.push({
      kind: "text",
      text: `exit ${result.exitCode}`,
      variant: "warning",
    });
  }
  if (entries.length === 0) {
    entries.push({ kind: "text", text: "(no output)", variant: "secondary" });
  }
  return entries;
};
