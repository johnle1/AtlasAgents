/**
 * <Summary>
 * What it does:
 *   Constants for experience recorder configuration and directory paths.
 *
 * How it fits in the system:
 *   Provides configuration values for experience and snapshot directory paths.
 * </Summary>
 */

/** Relative path under rootDir for persisted experience JSON files. */
export const EXPERIENCES_DIR = "user-data/experiences";

/** Relative path under rootDir for rollback snapshot files (cleaned on success). */
export const SNAPSHOTS_DIR = "user-data/snapshots";
