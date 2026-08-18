/**
 * Cached git-branch probe for the footer.
 *
 * @remarks
 * Parses `git rev-parse --abbrev-ref HEAD`. Detached HEAD (`HEAD`) and
 * spawn failures become `null` so the footer simply omits the segment.
 * The runner is injected for unit tests — production uses a short
 * `execFileSync` with a timeout so a hung git cannot freeze the UI.
 */

import { execFileSync } from "node:child_process";

/**
 * Parses `git rev-parse --abbrev-ref HEAD` stdout.
 *
 * @param stdout - Raw command output.
 * @returns Branch name, or `null` for empty / detached HEAD.
 */
export const parseGitBranch = (stdout: string): string | null => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed === "HEAD") {
    return null;
  }
  return trimmed.split("\n")[0] ?? null;
};

/**
 * Runs git (or a test double) and returns the current branch.
 *
 * @param cwd - Directory to pass as `git -C`.
 * @param run - Optional runner; defaults to a 400 ms `execFileSync`.
 * @returns Branch name, or `null` on any failure.
 *
 * @example
 * ```ts
 * readGitBranch("/tmp/proj", () => "main\n"); // "main"
 * ```
 */
export const readGitBranch = (
  cwd: string,
  run: (cmd: string, args: string[]) => string | null = defaultGitRun,
): string | null => {
  try {
    const stdout = run("git", [
      "-C",
      cwd,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    return stdout === null ? null : parseGitBranch(stdout);
  } catch {
    return null;
  }
};

const defaultGitRun = (cmd: string, args: string[]): string | null => {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 400,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

let cached: { cwd: string; branch: string | null; at: number } | null = null;
const CACHE_MS = 5_000;

/**
 * Cached {@link readGitBranch} so the footer can re-render without
 * spawning git on every Ink frame.
 *
 * @param cwd - Working directory to probe.
 * @returns Cached branch, refreshed at most every 5 seconds per cwd.
 */
export const cachedGitBranch = (cwd: string): string | null => {
  const now = Date.now();
  if (cached && cached.cwd === cwd && now - cached.at < CACHE_MS) {
    return cached.branch;
  }
  const branch = readGitBranch(cwd);
  cached = { cwd, branch, at: now };
  return branch;
};
