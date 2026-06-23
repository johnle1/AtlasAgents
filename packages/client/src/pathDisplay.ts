/**
 * =============================================================================
 * Path display formatting and truncation utilities
 * =============================================================================
 *
 * What this module does:
 *   Formats absolute file paths for display in the CLI with home directory
 *   abbreviation (~) and middle-truncation for long paths in prompts.
 *
 * Key concepts:
 *   - formatDisplayPath: Replaces /home/user with ~ for brevity.
 *   - truncatePathMiddle: Cuts long paths to fit terminal width with ellipsis.
 *   - buildPromptLabel: Creates the CLI input prompt prefix.
 *   - formatHumanError: Converts OS errors to friendly messages with paths.
 *
 * Used by:
 *   - renderer.ts — displays paths in CLI output and prompts.
 *   - index.ts — shows working directory in prompt.
 *   - error handlers — displays user-friendly error messages.
 */

import * as os from "node:os";
import * as path from "node:path";

// ===== MODULE STATE =====
// Cache the user's home directory for reuse across function calls
const home = os.homedir();

/**
 * <Summary>
 * What it does:
 *   Converts an absolute file path to a display-friendly format by replacing
 *   the home directory prefix with a tilde (~) abbreviation.
 *
 * How it does it (step by step):
 *   1. Resolves the input path to an absolute normalized path.
 *   2. Checks if the resolved path is the home directory itself.
 *   3. If yes, returns "~" as the entire display path.
 *   4. Checks if resolved path starts with home directory + separator.
 *   5. If yes, replaces the home prefix with "~" and returns result.
 *   6. If not under home, returns the full resolved path unchanged.
 *
 * Parameters:
 *   @param absolutePath - File system path (absolute or relative).
 *
 * Returns:
 *   @returns Display path with ~ substitution e.g. "~/Documents/file.txt".
 * </Summary>
 */
export const formatDisplayPath = (absolutePath: string): string => {
  // ===== STEP 1: Resolve Path to Absolute Form =====
  // Step 1a: Convert relative or ambiguous path to absolute normalized form
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
 * <Summary>
 * What it does:
 *   Truncates a display path to a maximum length by replacing the middle
 *   with an ellipsis (…) while preserving the start and end of the path.
 *
 * How it does it (step by step):
 *   1. Checks if the path length is within the maxLen limit.
 *   2. If yes, returns the path unchanged.
 *   3. If no, calculates how many characters to keep (maxLen - 1 for ellipsis).
 *   4. Splits the kept characters roughly in half: head for start, tail for end.
 *   5. Slices the first head characters, appends "…", then appends last tail chars.
 *   6. Returns the truncated path e.g. "~/Doc…file.txt".
 *
 * Parameters:
 *   @param displayPath - Path to potentially truncate (e.g., from formatDisplayPath).
 *   @param maxLen - Maximum length after truncation (default 40 characters).
 *
 * Returns:
 *   @returns Path truncated to maxLen if needed, otherwise unchanged.
 * </Summary>
 */
export const truncatePathMiddle = (
  displayPath: string,
  maxLen = 40,
): string => {
  // ===== STEP 1: Check if Path Fits Within Length Limit =====
  // Step 1a: If path length is within maxLen, no truncation needed
  if (displayPath.length <= maxLen) {
    return displayPath;
  }

  // ===== STEP 2: Calculate Allocation for Head and Tail =====
  // Step 2a: Reserve 1 character for the ellipsis (…)
  // Step 2b: Remaining characters split between head and tail
  const keep = maxLen - 1;

  // ===== STEP 3: Calculate Head Length =====
  // Step 3a: Head is the ceiling of keep/2 (favors showing start of path)
  const head = Math.ceil(keep / 2);

  // ===== STEP 4: Calculate Tail Length =====
  // Step 4a: Tail is the floor of keep/2 (shows end of path)
  const tail = Math.floor(keep / 2);

  // ===== STEP 5: Build Truncated Path =====
  // Step 5a: Take first head characters from the beginning
  // Step 5b: Append ellipsis in the middle
  // Step 5c: Append last tail characters from the end
  // Step 5d: Result preserves start and end for readability
  return (
    displayPath.slice(0, head) +
    "…" +
    displayPath.slice(displayPath.length - tail)
  );
};

/**
 * <Summary>
 * What it does:
 *   Returns the readline input prompt prefix (`> `).
 *
 * How it does it (step by step):
 *   1. Returns a fixed `> ` string (cwd is ignored; path is not shown in the prompt).
 *
 * Parameters:
 *   @param cwd - Current working directory (unused; kept for call-site compatibility).
 *
 * Returns:
 *   @returns Prompt string `> `.
 * </Summary>
 */
export const buildPromptLabel = (cwd: string): string => "> ";

/**
 * <Summary>
 * What it does:
 *   Converts Node.js file system errors into human-friendly error messages
 *   that include the file path and explain what went wrong.
 *
 * How it does it (step by step):
 *   1. Extracts the error code from the error object (errno).
 *   2. Calls formatDisplayPath to convert file path to display format.
 *   3. Matches the error code against known POSIX error types.
 *   4. Returns a descriptive message appropriate to the error:
 *      - ENOENT: file does not exist.
 *      - EACCES/EPERM: permission denied.
 *      - EISDIR: path is a directory (not a file).
 *      - ENOTDIR: path component is not a directory.
 *   5. For unknown errors, extracts the error message and includes it.
 *
 * Parameters:
 *   @param op - Operation name e.g. "read", "write", "delete".
 *   @param filePath - File system path where error occurred.
 *   @param err - Error object from file system operation.
 *
 * Returns:
 *   @returns User-friendly error message e.g.
 *     "Cannot read ~/file.txt — file or directory does not exist."
 * </Summary>
 */
export const formatHumanError = (
  op: string,
  filePath: string,
  err: unknown,
): string => {
  // ===== STEP 1: Extract Error Code =====
  // Step 1a: Access the errno code from the error object
  // Step 1b: Common codes: ENOENT, EACCES, ENOTDIR, EISDIR, etc.
  const code = (err as NodeJS.ErrnoException).code;

  // ===== STEP 2: Format File Path for Display =====
  // Step 2a: Convert absolute path to display format with ~ substitution
  const display = formatDisplayPath(filePath);

  // ===== STEP 3: Handle "File Not Found" Error =====
  // Step 3a: ENOENT = Error NO ENTry (file or directory doesn't exist)
  if (code === "ENOENT") {
    return `Cannot ${op} ${display} — file or directory does not exist.`;
  }

  // ===== STEP 4: Handle "Permission Denied" Errors =====
  // Step 4a: EACCES = Error ACcESs denied (user lacks permissions)
  // Step 4b: EPERM = Error PERMission (operation not permitted)
  if (code === "EACCES" || code === "EPERM") {
    return `Cannot ${op} ${display} — permission denied.`;
  }

  // ===== STEP 5: Handle "Is Directory" Error =====
  // Step 5a: EISDIR = Error Is DIRectory (expected file, got directory)
  // Step 5b: Occurs when trying to read/write a directory as a file
  if (code === "EISDIR") {
    return `Cannot ${op} ${display} — path is a directory.`;
  }

  // ===== STEP 6: Handle "Not a Directory" Error =====
  // Step 6a: ENOTDIR = Error NOT DIRectory (expected directory, got file)
  // Step 6b: Occurs when trying to access subdirectory in a file
  if (code === "ENOTDIR") {
    return `Cannot ${op} ${display} — not a directory.`;
  }

  // ===== STEP 7: Handle Unknown Error Codes =====
  // Step 7a: Extract message from error object if available
  const message = err instanceof Error ? err.message : String(err);

  // Step 7b: Return generic message with the extracted error text
  return `Cannot ${op} ${display} — ${message}`;
};
