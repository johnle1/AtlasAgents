/**
 * <Summary>
 * What it does:
 *   Seeds user-data files from packaged defaults on first server start (only when
 *   each target file is missing), matching the client default-skills pattern.
 *
 * How it fits in the system:
 *   Called once from packages/server/src/index.ts before accepting connections.
 *   Ensures users have default configuration files without manual setup.
 * </Summary>
 */

// ===== FILE SYSTEM IMPORTS =====
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ===== PROJECT IMPORTS =====
import { LANGUAGE_HINTS_FILENAME } from "./memory/context/languageHints.js";

// ===== CONSTANTS =====
/**
 * Directory containing packaged default data files.
 * Resolves to the default-data folder in the server package distribution.
 * Used as source for copying default configuration files to user data directory.
 */
const PACKAGED_DEFAULT_DATA_DIR = path.resolve(__dirname, "..", "default-data");

/**
 * @async
 * <Summary>
 * What it does:
 *   Copies default-data/language-hints.json into user-data/ when that file does not exist.
 *
 * How it does it (step by step):
 *   1. Resolves destination as {rootDir}/user-data/language-hints.json.
 *   2. Returns immediately when the destination file already exists.
 *   3. Ensures user-data/ exists.
 *   4. Copies from packaged default-data when the source file is present.
 *
 * Parameters:
 *   @param rootDir - Working directory for server state (typically cwd).
 *
 * Returns:
 *   @returns Completes after copy or no-op.
 * </Summary>
 */
const installDefaultLanguageHints = async (rootDir: string): Promise<void> => {
  // ===== STEP 1: RESOLVE DESTINATION PATH =====
  // Step 1a: Construct user-data directory path
  // Combines root directory with user-data subdirectory
  const userDataDir = path.join(rootDir, "user-data");

  // Step 1b: Construct full destination path for language hints file
  // Combines user-data directory with the language hints filename
  const destinationPath = path.join(userDataDir, LANGUAGE_HINTS_FILENAME);

  // ===== STEP 2: CHECK IF DESTINATION FILE ALREADY EXISTS =====
  try {
    // Step 2a: Attempt to access the destination file
    // This checks if the file already exists and is readable
    await fs.access(destinationPath);

    // Step 2b: File exists - no need to copy, return immediately
    return;
  } catch (error) {
    // Step 2c: Handle file access errors
    const errorCode = (error as NodeJS.ErrnoException).code;

    // Step 2d: If error is "file not found", continue with installation
    if (errorCode !== "ENOENT") {
      // Step 2e: For other errors (permissions, etc.), re-throw
      throw error;
    }
  }

  // ===== STEP 3: ENSURE USER-DATA DIRECTORY EXISTS =====
  // Step 3a: Create user-data directory if it doesn't exist
  // recursive: true ensures parent directories are created if needed
  await fs.mkdir(userDataDir, { recursive: true });

  // ===== STEP 4: RESOLVE SOURCE PATH =====
  // Step 4a: Construct full source path from packaged default data
  const sourcePath = path.join(
    PACKAGED_DEFAULT_DATA_DIR,
    LANGUAGE_HINTS_FILENAME,
  );

  // ===== STEP 5: VERIFY SOURCE FILE EXISTS =====
  try {
    // Step 5a: Attempt to access the source file
    await fs.access(sourcePath);
  } catch (error) {
    // Step 5b: Handle source file access errors
    const errorCode = (error as NodeJS.ErrnoException).code;

    // Step 5c: If source file doesn't exist, silently skip installation
    // This allows graceful handling if default data is not packaged
    if (errorCode === "ENOENT") {
      return;
    }

    // Step 5d: For other errors, re-throw
    throw error;
  }

  // ===== STEP 6: COPY SOURCE TO DESTINATION =====
  // Step 6a: Copy the default language hints file to user data directory
  await fs.copyFile(sourcePath, destinationPath);
};

/**
 * @async
 * <Summary>
 * What it does:
 *   Installs all packaged user-data defaults (currently language-hints.json only).
 *
 * How it does it (step by step):
 *   1. Accepts root directory parameter with default to current working directory.
 *   2. Calls installDefaultLanguageHints to seed language hints configuration.
 *   3. Future: Can be extended to install additional default files.
 *
 * Parameters:
 *   @param {string} [rootDir] — Data root; defaults to process.cwd().
 *
 * Returns:
 *   @returns Completes when seeding finishes.
 * </Summary>
 */
export const installUserDataDefaults = async (
  rootDir: string = process.cwd(),
): Promise<void> => {
  // ===== STEP 1: INSTALL LANGUAGE HINTS DEFAULTS =====
  // Step 1a: Call the language hints installation function
  // This copies default language hints from packaged data to user directory
  await installDefaultLanguageHints(rootDir);

  // ===== FUTURE EXTENSION POINT =====
  // Additional default file installations can be added here
  // Example:
  // await installDefaultSkills(rootDir);
  // await installDefaultPatterns(rootDir);
};
