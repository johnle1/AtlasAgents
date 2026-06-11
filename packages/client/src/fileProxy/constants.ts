/**
 * <Summary>
 * What it does:
 *   Defines directory names that should be skipped during file system traversal.
 *
 * Used by:
 *   - File traversal and search functions — skip these directories to avoid
 *     unnecessary processing of generated files and dependencies.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
export const SKIP_DIR_NAMES = new Set([
  "node_modules" /** Node.js dependency directory (contains thousands of files) */,
  ".git" /** Git repository metadata directory */,
  "dist" /** Build output directory (generated code) */,
  ".next" /** Next.js build output directory (generated code) */,
]);

/**
 * <Summary>
 * What it does:
 *   Defines proxy routes that should execute instantly without showing a working spinner.
 *
 * Used by:
 *   - Proxy request handlers — skip spinner animation for these fast metadata routes.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
export const QUIET_PROXY_ROUTES = new Set([
  "file.get_cwd" /** Get current working directory (instant metadata operation) */,
  "command.classify" /** Classify command safety level (instant analysis operation) */,
]);

/**
 * <Summary>
 * What it does:
 *   Defines base shell commands that are considered safe to execute without user confirmation.
 *
 * Used by:
 *   - classifyCommand — checks if a command's base command is in this set to mark it as "safe".
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
export const SAFE_BASE_COMMANDS = new Set([
  "ls" /** List directory contents (read-only operation) */,
  "cat" /** Display file contents (read-only operation) */,
  "pwd" /** Print working directory (read-only operation) */,
  "echo" /** Display text output (read-only operation) */,
  "find" /** Search for files (read-only operation) */,
  "grep" /** Search text in files (read-only operation) */,
  "head" /** Display first lines of file (read-only operation) */,
  "tail" /** Display last lines of file (read-only operation) */,
  "wc" /** Count lines, words, characters (read-only operation) */,
]);

/**
 * <Summary>
 * What it does:
 *   Defines git subcommands that are considered safe to execute without user confirmation.
 *
 * Used by:
 *   - classifyCommand — checks if a git command's subcommand is in this set to mark it as "safe".
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
export const SAFE_GIT_SUBCOMMANDS = new Set([
  "status" /** Show working tree status (read-only operation) */,
  "log" /** Show commit logs (read-only operation) */,
  "diff" /** Show changes between commits (read-only operation) */,
]);

/**
 * <Summary>
 * What it does:
 *   Defines command tokens and flags that indicate a command is potentially dangerous.
 *
 * Used by:
 *   - classifyCommand — checks if any token in the command matches this set to mark it as "dangerous".
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
export const DANGEROUS_TOKENS = new Set([
  "rm" /** Remove files or directories (destructive operation) */,
  "rmdir" /** Remove empty directories (destructive operation) */,
  "drop" /** Database drop command (destructive operation) */,
  "truncate" /** Truncate files to zero size (destructive operation) */,
  "reset" /** Git reset command (can discard changes) */,
  "--hard" /** Git hard reset flag (destructive, discards all changes) */,
  "--force" /** Force operation flag (bypasses safety checks) */,
  "-rf" /** Recursive force flag for rm (destructive, no confirmation) */,
  "-f" /** Force flag (bypasses safety checks) */,
  "dd" /** Low-level disk write command (can overwrite data) */,
  "mkfs" /** Make filesystem command (destructive, formats storage) */,
]);
