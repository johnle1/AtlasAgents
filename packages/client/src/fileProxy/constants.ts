/**
 * Static policy sets for traversal skips, quiet routes, and shell classification.
 *
 * @remarks
 * Consumed by directory listing, {@link LocalFileProxy.handle} spinner logic, and
 * {@link classifyCommand}. Edit carefully — classification is intentionally
 * heuristic, not a full shell security sandbox.
 */

/**
 * Directory basenames skipped while walking or listing the workspace.
 *
 * @remarks
 * Avoids drowning listings in dependency/build noise (`node_modules`, `.git`,
 * `dist`, `.next`). Matching is by **entry name only**, not full path.
 */
export const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
]);

/**
 * Proxy routes that complete so quickly that a working spinner would flicker.
 *
 * @remarks
 * {@link LocalFileProxy.handle} skips `startWorking` / teardown animation for
 * these metadata routes (`file.get_cwd`, `command.classify`).
 */
export const QUIET_PROXY_ROUTES = new Set([
  "file.get_cwd",
  "command.classify",
]);

/**
 * Base executables treated as read-only → classification `"safe"`.
 *
 * @remarks
 * Only the **first** whitespace token is matched (e.g. `ls`, `cat`). Pipelines
 * or wrappers around dangerous tools are **not** fully modeled — unknown / mixed
 * forms fall through to `"cautious"` or `"dangerous"` via token scans.
 */
export const SAFE_BASE_COMMANDS = new Set([
  "ls",
  "find",
  "cat",
  "head",
  "tail",
  "grep",
  "pwd",
  "echo",
  "wc",
]);

/**
 * `git <subcommand>` values treated as read-only → `"safe"`.
 *
 * @remarks
 * Requires base command `git` plus a second token in this set (`status`, `log`,
 * `diff`). Mutating git ops are left to the dangerous-token / cautious paths.
 */
export const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "diff"]);

/**
 * Command tokens that force classification `"dangerous"`.
 *
 * @remarks
 * Matched as whole whitespace-separated tokens after lowercasing (e.g. `rm`,
 * `-rf`, `--force`). Presence of any token here fails closed to requiring
 * explicit user approval with a danger warning in the CLI.
 */
export const DANGEROUS_TOKENS = new Set([
  "rm",
  "rmdir",
  "-rf",
  "-f",
  "--force",
  "--hard",
  "drop",
  "truncate",
  "dd",
  "mkfs",
  "reset",
]);
