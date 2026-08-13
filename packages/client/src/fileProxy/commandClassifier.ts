/**
 * Heuristic shell-command safety classification for approval UI.
 *
 * @remarks
 * Returns `"safe"`, `"dangerous"`, or `"cautious"` using allow/deny token sets
 * from `constants.ts`. This is **not** a complete shell parser — quoted
 * metacharacters are not distinguished from real ones (e.g. `grep "a;b" f`
 * also fails closed). Prefer failing to `"cautious"` so the user still
 * confirms unknown forms.
 */

import type { BashClass } from "../renderer.js";
import {
  DANGEROUS_TOKENS,
  ESCAPING_PATH_PATTERN,
  SAFE_BASE_COMMANDS,
  SAFE_FIND_PRIMARIES,
  SAFE_GIT_SUBCOMMANDS,
  SHELL_METACHARACTER_PATTERN,
} from "./constants.js";

/**
 * Reports whether a `find` invocation carries a primary we have not vetted.
 *
 * @remarks
 * Only `-`-prefixed tokens are considered; bare operands (paths, `-name`
 * patterns, `{}`, `+`) are values, not primaries. Negative numeric arguments
 * such as the `-1` in `-mtime -1` are skipped for the same reason.
 */
const hasUnknownFindPrimary = (commandTokens: string[]): boolean =>
  commandTokens
    .slice(1)
    .some(
      (token) =>
        token.startsWith("-") &&
        !SAFE_FIND_PRIMARIES.has(token) &&
        !/^-\d+$/.test(token),
    );

const isPipeToShell = (command: string): boolean =>
  /(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh|dash)\b/.test(command);

const isForkBomb = (command: string): boolean =>
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command);

/**
 * Classifies a shell command line for auto-run vs approval flows.
 *
 * @remarks
 * Evaluation order:
 * 1. Empty → `"cautious"`
 * 2. Fork-bomb, `curl|sh` / `wget|sh`, or `git clean` → `"dangerous"`
 * 3. Any token in {@link DANGEROUS_TOKENS} → `"dangerous"`
 * 4. Contains a shell metacharacter ({@link SHELL_METACHARACTER_PATTERN}) → `"cautious"`
 * 5. `find` with a primary outside {@link SAFE_FIND_PRIMARIES} → `"cautious"`
 * 6. An argument matching {@link ESCAPING_PATH_PATTERN} → `"cautious"`
 * 7. Base command in {@link SAFE_BASE_COMMANDS} → `"safe"`
 * 8. `git` + safe subcommand → `"safe"`
 * 9. Otherwise → `"cautious"`
 *
 * Danger, metacharacter, `find`-primary, and escaping-path checks all run
 * unconditionally, before the allow-list fast paths — otherwise a command
 * chained onto an allow-listed base command (e.g. `echo x && rm -rf /`), one
 * abusing an allow-listed binary's own flags (e.g.
 * `find . -maxdepth 0 -exec sh p {} +`, which contains no shell metacharacter
 * at all), or one simply pointed outside the workspace
 * (e.g. `cat /Users/you/.ssh/id_rsa`) would return `"safe"` on the first
 * token alone, without ever seeing what follows.
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
 * classifyCommand("echo x && rm -rf /");          // "dangerous"
 * classifyCommand("find . -exec sh p {} +");      // "dangerous"
 * classifyCommand("find . -newermt yesterday");   // "cautious" (unknown primary)
 * classifyCommand("cat ~/.ssh/id_rsa");           // "cautious" (outside workspace)
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

  if (isForkBomb(normalizedCommand) || isPipeToShell(normalizedCommand)) {
    return "dangerous";
  }

  if (baseCommand === "git" && commandTokens[1] === "clean") {
    return "dangerous";
  }

  // Scan every token unconditionally, even when the base command is
  // allow-listed — a chained/subsequent command must not hide behind it.
  for (const token of commandTokens) {
    if (DANGEROUS_TOKENS.has(token)) {
      return "dangerous";
    }
  }

  // Shell metacharacters can chain, redirect, or substitute an entirely
  // different, unvetted command (e.g. `echo x && curl … | sh`) — never treat
  // these as "safe" from the first token alone.
  if (SHELL_METACHARACTER_PATTERN.test(normalizedCommand)) {
    return "cautious";
  }

  // `find` is allow-listed for read-only searches, but its own primaries can
  // execute commands (`-exec … {} +`), destroy data (`-delete`), or write
  // files (`-fprintf`) with no shell metacharacter at all. The known-bad ones
  // are caught by DANGEROUS_TOKENS above; anything else unrecognized fails
  // closed here so an unlisted primary cannot inherit "safe".
  if (baseCommand === "find" && hasUnknownFindPrimary(commandTokens)) {
    return "cautious";
  }

  // `command.run` has no path confinement (only `cwd`), so an allow-listed
  // reader aimed at an absolute or traversing path would silently read
  // outside the workspace and ship the contents back. Require approval.
  if (commandTokens.slice(1).some((token) => ESCAPING_PATH_PATTERN.test(token))) {
    return "cautious";
  }

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

  // Unknown binaries / build tools: require confirm, but without the “dangerous” banner.
  return "cautious";
};
