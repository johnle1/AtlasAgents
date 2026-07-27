/**
 * Persists command-line input history across CLI sessions.
 *
 * @remarks
 * History is stored as newline-delimited text under the user config
 * directory ({@link HISTORY_FILE}). Lines are sanitized on read and write
 * so sensitive values such as `/set password` are never written to disk
 * in plain text.
 */
import * as fs from "node:fs";
import { HISTORY_FILE, ensureDirs } from "../../config/index.js";
import { sanitizeHistoryLine } from "../historySanitize.js";
import { logger } from "../../utils/logger.js";

/** Maximum number of input lines retained on disk. Older entries are dropped. */
const MAX_HISTORY = 1_000;

/**
 * Loads persisted input history from the previous CLI session.
 *
 * @remarks
 * Returns an empty array when the history file is missing or unreadable
 * (first run, permission error, or corrupt file). Each line is passed
 * through {@link sanitizeHistoryLine} so redacted password commands
 * appear consistently even if an older file contained raw secrets.
 *
 * @returns Up to {@link MAX_HISTORY} sanitized input lines, oldest first.
 *
 * @example
 * ```ts
 * const priorLines = loadHistory();
 * // Pass to App as initialInputHistory for arrow-key recall
 * ```
 */
export const loadHistory = (): string[] => {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
    return raw.split("\n").filter(Boolean).map(sanitizeHistoryLine);
  } catch {
    // Missing or unreadable file — treat as no prior history
    return [];
  }
};

/**
 * Writes input history to disk, trimming to the most recent entries.
 *
 * @remarks
 * Creates the config directory if needed via {@link ensureDirs}. Only
 * the last {@link MAX_HISTORY} lines are kept so the file cannot grow
 * without bound across long-lived installations. Write failures (missing
 * permissions, full disk) are logged and swallowed so exit is not blocked.
 *
 * @param lines - Full in-memory history from the current session; may
 *   exceed {@link MAX_HISTORY} — only the tail is persisted.
 *
 * @example
 * ```ts
 * saveHistory(inputHistoryRef.current);
 * ```
 */
export const saveHistory = (lines: string[]): void => {
  try {
    ensureDirs();
    const trimmed = lines
      .slice(-MAX_HISTORY)
      .map((line) => sanitizeHistoryLine(line));
    fs.writeFileSync(HISTORY_FILE, trimmed.join("\n") + "\n", "utf-8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not save input history: ${detail}`);
  }
};
