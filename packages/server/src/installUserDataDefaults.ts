/**
 * Seeds user-data files from packaged defaults on first server start.
 *
 * @remarks
 * Called once from the server entry point before accepting connections.
 * Ensures users have default configuration files without manual setup.
 * Only copies files when the target file is missing, preserving user
 * customizations on subsequent runs.
 *
 * Currently installs language-hints.json. Can be extended to install
 * additional default files in the future.
 */

// ===== FILE SYSTEM IMPORTS =====
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ===== PROJECT IMPORTS =====
import { LANGUAGE_HINTS_FILENAME } from "./memory/context/languageHints.js";

// ===== CONSTANTS =====
/**
 * Directory containing packaged default data files.
 *
 * @remarks
 * Resolves to the default-data folder in the server package distribution.
 * Used as source for copying default configuration files to user data directory.
 */
const PACKAGED_DEFAULT_DATA_DIR = path.resolve(__dirname, "..", "default-data");

/**
 * Copies default language-hints.json into user-data/ when that file does not exist.
 *
 * @remarks
 * Resolves the destination as {rootDir}/user-data/language-hints.json.
 * Returns immediately when the destination file already exists to preserve
 * user customizations. Ensures the user-data directory exists before copying.
 * Silently skips installation if the source file is not present in the
 * packaged defaults (allows graceful degradation).
 *
 * @param rootDir - Working directory for server state (typically cwd)
 *
 * @throws {@link NodeJS.ErrnoException} If directory creation fails or file
 *   copy fails for reasons other than missing source file
 */
const installDefaultLanguageHints = async (rootDir: string): Promise<void> => {
  const userDataDir = path.join(rootDir, "user-data");
  const destinationPath = path.join(userDataDir, LANGUAGE_HINTS_FILENAME);

  // Return early if destination file already exists (preserve user customizations)
  try {
    await fs.access(destinationPath);
    return;
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== "ENOENT") {
      throw error; // Re-throw non-ENOENT errors (permissions, etc.)
    }
  }

  // Ensure user-data directory exists
  await fs.mkdir(userDataDir, { recursive: true });

  // Resolve source path from packaged defaults
  const sourcePath = path.join(
    PACKAGED_DEFAULT_DATA_DIR,
    LANGUAGE_HINTS_FILENAME,
  );

  // Verify source file exists before copying
  try {
    await fs.access(sourcePath);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    // Silently skip if source file is missing (graceful degradation)
    if (errorCode === "ENOENT") {
      return;
    }
    throw error;
  }

  // Copy source to destination
  await fs.copyFile(sourcePath, destinationPath);
};

/**
 * Installs all packaged user-data defaults.
 *
 * @remarks
 * Currently installs language-hints.json only. Can be extended to install
 * additional default files in the future (e.g., default skills, patterns).
 * Each installation function checks if the target file exists before copying
 * to preserve user customizations.
 *
 * @param rootDir - Data root directory; defaults to process.cwd()
 *
 * @example
 * ```ts
 * Install defaults in current working directory
 * await installUserDataDefaults();
 *
 * Install defaults in specific directory
 * await installUserDataDefaults("/custom/data/path");
 * ```
 */
export const installUserDataDefaults = async (
  rootDir: string = process.cwd(),
): Promise<void> => {
  await installDefaultLanguageHints(rootDir);

  // Future extension point for additional default file installations
  // Example:
  // await installDefaultSkills(rootDir);
  // await installDefaultPatterns(rootDir);
};
