/**
 * <Summary>
 * What it does:
 *   Seeds user-data files from packaged defaults on first server start (only when
 *   each target file is missing), matching the client default-skills pattern.
 *
 * How it fits in the system:
 *   Called once from packages/server/src/index.ts before accepting connections.
 *
 * Dependencies:
 *   - node:fs/promises, node:path — copy packaged JSON into user-data/.
 *
 * Dependants:
 *   - main in index.ts.
 * </Summary>
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { LANGUAGE_HINTS_FILENAME } from './memory/languageHints.js'

const PACKAGED_DEFAULT_DATA_DIR = path.resolve(
  __dirname,
  '..',
  'default-data',
)

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
 *   @param {string} rootDir — Working directory for server state (typically cwd).
 *
 * Returns:
 *   @returns {Promise<void>} — Completes after copy or no-op.
 *
 * Dependants:
 *   - installUserDataDefaults.
 * </Summary>
 */
const installDefaultLanguageHints = async (rootDir: string): Promise<void> => {
  const userDataDir = path.join(rootDir, 'user-data')
  const dest = path.join(userDataDir, LANGUAGE_HINTS_FILENAME)
  try {
    await fs.access(dest)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw err
    }
  }
  await fs.mkdir(userDataDir, { recursive: true })
  const src = path.join(PACKAGED_DEFAULT_DATA_DIR, LANGUAGE_HINTS_FILENAME)
  try {
    await fs.access(src)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return
    }
    throw err
  }
  await fs.copyFile(src, dest)
}

/**
 * @async
 * <Summary>
 * What it does:
 *   Installs all packaged user-data defaults (currently language-hints.json only).
 *
 * Parameters:
 *   @param {string} [rootDir] — Data root; defaults to process.cwd().
 *
 * Returns:
 *   @returns {Promise<void>} — Completes when seeding finishes.
 *
 * Dependants:
 *   - main in index.ts.
 * </Summary>
 */
export const installUserDataDefaults = async (
  rootDir: string = process.cwd(),
): Promise<void> => {
  await installDefaultLanguageHints(rootDir)
}
