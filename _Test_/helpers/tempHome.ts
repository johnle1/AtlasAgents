/**
 * Redirects `os.homedir()` at a fresh temp directory for the duration of a
 * test file.
 *
 * @remarks
 * `os.homedir()` reads `HOME` on POSIX but `USERPROFILE` on Windows, so both
 * must be set — overriding only `HOME` silently leaves Windows runs pointed
 * at the real user profile, where parallel vitest workers then race to
 * create/decrypt the same `~/.atlasagents/config.json`. That race is what
 * caused the Windows CI matrix to hang printing "Wrong passphrase. Try
 * again." indefinitely: one worker's leftover encrypted file was fed to
 * another worker's constant-answer mock passphrase, which can never unlock
 * it and never terminates the reset-menu retry loop in `cipher.ts`.
 *
 * The `os.homedir()` assertion below is deliberate: it turns any future
 * platform-variable mismatch (a new env var Node starts reading, a
 * misconfigured runner, ...) into an immediate, legible failure instead of a
 * silent write to the real home directory followed by an hours-long hang.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TempHome = {
  /** The temp directory now returned by `os.homedir()`. */
  dir: string;
  /** Restores the original HOME/USERPROFILE and removes the temp directory. */
  restore: () => void;
};

/**
 * @param prefix - Passed to `fs.mkdtempSync` (e.g. `"atlas-config-unlock-test-"`).
 * @throws {Error} If `os.homedir()` doesn't reflect the override — see remarks.
 */
export const createTempHome = (prefix: string): TempHome => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;

  process.env.HOME = dir;
  process.env.USERPROFILE = dir;

  const resolved = os.homedir();
  if (resolved !== dir) {
    throw new Error(
      `createTempHome: os.homedir() returned "${resolved}", expected "${dir}" ` +
        "— HOME/USERPROFILE override did not take effect on this platform.",
    );
  }

  const restore = (): void => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { dir, restore };
};
