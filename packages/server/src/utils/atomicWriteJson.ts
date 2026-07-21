/**
 * Atomic JSON file writes: write to a sibling temp file, then rename over the
 * destination so readers never observe a partially-written file.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Serializes `data` as pretty-printed JSON and atomically writes it to `destinationPath`.
 *
 * @remarks
 * Creates the destination directory if missing, writes to a
 * `.{tempPrefix}-<uuid>.tmp` file in the same directory, then renames it over
 * `destinationPath`. On POSIX, `fs.rename` is atomic, so a reader never sees a
 * half-written file — a crash mid-write leaves the stale temp file behind but
 * never corrupts the real one.
 *
 * @param destinationPath - Final file path to write.
 * @param data - JSON-serializable value to persist.
 * @param tempPrefix - Short label used in the temp filename (e.g. `"config"`),
 *   for easier identification of stray temp files if a write is interrupted.
 *
 * @example
 * ```ts
 * await atomicWriteJson(configPath, config, "config");
 * ```
 */
export const atomicWriteJson = async (
  destinationPath: string,
  data: unknown,
  tempPrefix: string,
): Promise<void> => {
  const directory = path.dirname(destinationPath);
  await fs.mkdir(directory, { recursive: true });

  const tempPath = path.join(directory, `.${tempPrefix}-${randomUUID()}.tmp`);
  const jsonPayload = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tempPath, jsonPayload, "utf-8");
  await fs.rename(tempPath, destinationPath);
};
