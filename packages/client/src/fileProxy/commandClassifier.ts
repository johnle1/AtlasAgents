/**
 * Heuristic shell-command safety classification for approval UI.
 *
 * @remarks
 * Returns `"safe"`, `"dangerous"`, or `"cautious"` using allow/deny token sets
 * from `constants.ts`. This is **not** a complete shell parser — quotes,
 * pipes, and `$(…)` are not modeled. Prefer failing to `"cautious"` so the
 * user still confirms unknown forms.
 */

import type { BashClass } from "../renderer.js";
import {
  DANGEROUS_TOKENS,
  SAFE_BASE_COMMANDS,
  SAFE_GIT_SUBCOMMANDS,
} from "./constants.js";

/**
 * Classifies a shell command line for auto-run vs approval flows.
 *
 * @remarks
 * Evaluation order:
 * 1. Empty → `"cautious"`
 * 2. Base command in {@link SAFE_BASE_COMMANDS} → `"safe"`
 * 3. `git` + safe subcommand → `"safe"`
 * 4. Contains `chmod 777` → `"dangerous"`
 * 5. Any token in {@link DANGEROUS_TOKENS} → `"dangerous"`
 * 6. Otherwise → `"cautious"`
 *
 * Matching is case-insensitive on whitespace-split tokens.
 *
 * @param command - Full command string, e.g. `"git status"` or `"rm -rf dist"`.
 * @returns Risk class used by `command.run` approval UI.
 *
 * @example
 * ```ts
 * classifyCommand("ls -la");        // "safe"
 * classifyCommand("git status");    // "safe"
 * classifyCommand("rm -rf build");  // "dangerous"
 * classifyCommand("npm test");      // "cautious"
 * ```
 */
export const classifyCommand = (command: string): BashClass => {
  const normalizedCommand = command.toLowerCase().trim();
  const commandTokens = normalizedCommand
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (commandTokens.length === 0) {
    return "cautious";
  }

  const baseCommand = commandTokens[0] ?? "";

  if (SAFE_BASE_COMMANDS.has(baseCommand)) {
    return "safe";
  }

  if (
    baseCommand === "git" &&
    commandTokens.length >= 2 &&
    SAFE_GIT_SUBCOMMANDS.has(commandTokens[1] ?? "")
  ) {
    return "safe";
  }

  // World-writable modes are called out even when `chmod` is not in DANGEROUS_TOKENS.
  if (normalizedCommand.includes("chmod 777")) {
    return "dangerous";
  }

  for (const token of commandTokens) {
    if (DANGEROUS_TOKENS.has(token)) {
      return "dangerous";
    }
  }

  // Unknown binaries / build tools: require confirm, but without the “dangerous” banner.
  return "cautious";
};
