/**
 * Configuration constants for experience recording and persistence.
 *
 * @remarks
 * Defines directory paths for persisting experiences and temporary snapshots.
 * Used by {@link ExperienceRecorder} to organize files under `user-data/`.
 */

/** Relative path under rootDir for persisted experience JSON files. */
export const EXPERIENCES_DIR = "user-data/experiences";

/** Relative path under rootDir for rollback snapshot files (cleaned on success). */
export const SNAPSHOTS_DIR = "user-data/snapshots";
