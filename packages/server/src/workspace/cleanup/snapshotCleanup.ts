/**
 * Cleanup utilities for managing snapshot files and temporary data.
 *
 * @remarks
 * This module provides housekeeping functions for removing stale snapshot files
 * that accumulate during normal operation. Snapshots are timestamped backups of
 * workspace state used for recovery and debugging, but they consume disk space
 * and should be cleaned up after they're no longer needed.
 *
 * **Lifecycle:**
 * - Snapshots are written with a leading Unix timestamp in their filename
 *   (e.g., "1234567890-workspace-snapshot.json")
 * - {@link cleanupOldSnapshots} scans the snapshots directory on server startup
 * - Files older than {@link MAX_AGE_MS} (24 hours) are deleted
 * - A count of deleted files is returned for logging/monitoring
 *
 * **Error handling:**
 * - If the snapshots directory doesn't exist, that's not an error (0 files cleaned)
 * - If individual files can't be deleted due to permissions or disk errors, warnings
 *   are logged but the cleanup continues
 * - ENOENT errors on deletion (file already gone) are silently ignored
 *
 * @example
 * ```ts
 * import { cleanupOldSnapshots } from "../../workspace/cleanup/snapshotCleanup.js";
 *
 * const removed = await cleanupOldSnapshots();
 * console.log(`Cleaned up ${removed} old snapshot files`);
 * ```
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "../../logger.js";

/** Directory relative to root where snapshot files are stored. */
const SNAPSHOTS_DIR = "user-data/snapshots";

/** Maximum age in milliseconds before a snapshot is considered stale and eligible for deletion. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Scans the snapshots directory and removes snapshot files older than 24 hours.
 *
 * @remarks
 * This function performs a cleanup operation intended to run on server startup or
 * periodically. It:
 * 1. Reads all files from the snapshots directory
 * 2. Extracts the leading timestamp from each filename (expected format: "{timestamp}-{name}")
 * 3. Compares the timestamp against a 24-hour cutoff
 * 4. Deletes files that exceed the age limit
 * 5. Returns the count of successfully deleted files
 *
 * **Filename format:**
 * Snapshot files must have a leading Unix timestamp (milliseconds), separated by a hyphen.
 * Examples:
 * - "1234567890123-workspace-state.json" → timestamp 1234567890123
 * - "1234567890123-backup.json" → timestamp 1234567890123
 * - "not-a-snapshot.txt" → ignored (no leading timestamp)
 *
 * **Error handling:**
 * - If the snapshots directory doesn't exist (ENOENT), returns 0 (not an error)
 * - If a file can't be deleted (permissions, disk error), logs a warning and continues
 * - If a file is already gone (ENOENT during deletion), silently ignores it (another
 *   cleanup pass or manual delete may have removed it)
 * - Other errors (permissions, I/O) are logged as warnings
 *
 * **Safe to call repeatedly:**
 * Running this multiple times won't cause errors — it's designed for periodic cleanup
 * or startup routines. Concurrent calls are safe because individual file deletions
 * are atomic and ENOENT is handled gracefully.
 *
 * @param rootDir - The root directory path. Snapshots are expected in `{rootDir}/user-data/snapshots/`.
 *   Defaults to `process.cwd()` if not provided.
 * @returns The number of snapshot files successfully deleted. Returns 0 if the
 *   snapshots directory doesn't exist or contains no old files.
 * @throws If an error occurs reading the snapshots directory (other than ENOENT).
 *   Individual file deletion errors are logged as warnings, not thrown.
 *
 * @example
 * ```ts
 * // On server startup
 * const removed = await cleanupOldSnapshots();
 * if (removed > 0) {
 *   console.log(`Cleaned up ${removed} old snapshot files`);
 * }
 *
 * // With custom root directory
 * const removed = await cleanupOldSnapshots("/app/data");
 *
 * // Safe to call multiple times
 * await cleanupOldSnapshots();
 * await cleanupOldSnapshots(); // No error, just returns 0
 * ```
 */
export const cleanupOldSnapshots = async (
  rootDir: string = process.cwd(),
): Promise<number> => {
  // Construct the full path to the snapshots directory.
  const dir = path.join(rootDir, SNAPSHOTS_DIR);
  let entries: string[] = [];

  // Attempt to read the directory contents.
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    // Extract the error code from the exception for granular error handling.
    const code = (err as NodeJS.ErrnoException).code;
    // If the directory doesn't exist, that's not an error — just nothing to clean up.
    // Return 0 and continue normally.
    if (code === "ENOENT") {
      return 0;
    }
    // Other errors (permission denied, disk error, etc.) should bubble up so the
    // caller knows something went wrong during the cleanup attempt.
    throw err;
  }

  // Calculate the cutoff timestamp: any file older than this was created before the
  // 24-hour window and should be deleted. We subtract MAX_AGE_MS from now.
  const cutoff = Date.now() - MAX_AGE_MS;
  let removed = 0;

  // Iterate through all files in the snapshots directory.
  for (const name of entries) {
    // Extract the leading timestamp from the filename using a regex.
    // Expected format: "{timestamp}-{rest of filename}"
    // Example: "1234567890123-workspace-state.json" → match[1] = "1234567890123"
    const match = /^(\d+)-/.exec(name);
    // If the filename doesn't match the expected format (no leading timestamp),
    // skip it. This allows the directory to contain both snapshot files and
    // other data without confusion.
    if (!match) {
      continue;
    }

    // Parse the extracted timestamp string to a number. We use Number.parseInt
    // instead of parseInt to avoid octal parsing bugs.
    const ts = Number.parseInt(match[1] ?? "", 10);
    // Validate that the parsed timestamp is a finite number AND that the file
    // is old enough to delete (ts < cutoff). If the timestamp is invalid or the
    // file is still within the 24-hour window, skip it.
    if (!Number.isFinite(ts) || ts >= cutoff) {
      continue;
    }

    // Attempt to delete this old snapshot file.
    try {
      await fs.unlink(path.join(dir, name));
      // Increment the counter for successfully deleted files.
      removed += 1;
    } catch (err) {
      // Extract the error code for error-specific handling.
      const code = (err as NodeJS.ErrnoException).code;
      // If the file is already gone (ENOENT), that's fine. This can happen if
      // another cleanup process ran concurrently or the file was manually deleted.
      // Silently ignore this and continue cleaning up other files.
      // However, any other error (permissions, disk error, etc.) indicates a real
      // problem that should be logged so the operator can investigate.
      if (code !== "ENOENT") {
        logger.warn({ file: name, err }, "Failed to delete old snapshot");
      }
    }
  }

  // Return the total count of successfully deleted snapshot files.
  return removed;
};
