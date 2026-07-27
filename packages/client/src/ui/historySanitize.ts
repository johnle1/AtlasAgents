const PASSWORD_HISTORY_PATTERN = /^\/set password\s+\S/i;

/**
 * Sanitizes sensitive information from input lines before they are added to the persistent history.
 *
 * @remarks
 * Specifically masks password values entered via the `/set password <value>` command
 * to prevent sensitive credentials from being written to plain text history files.
 *
 * @param line - The raw command or input line to sanitize.
 * @returns The sanitized input line, with sensitive data masked if matching patterns are found.
 *
 * @example
 * ```ts
 * const sanitized = sanitizeHistoryLine("/set password my_secret_123");
 * console.log(sanitized); // "/set password ***"
 * ```
 */
export const sanitizeHistoryLine = (line: string): string => {
  if (PASSWORD_HISTORY_PATTERN.test(line)) {
    return "/set password ***";
  }
  return line;
};

