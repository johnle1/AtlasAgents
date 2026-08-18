/**
 * Config repair for `atlas-server`: changes the saved auth password and/or
 * TCP port without starting the server, gated by the server config
 * passphrase.
 *
 * @remarks
 * Mirrors the client's `cli/configRepair.ts`. The key difference is the
 * gate: this module calls {@link unlockExistingStartupCipher}, never
 * {@link unlockOrSetupStartupCipher} — a wrong passphrase here must throw
 * and leave `startup.json` untouched, not fall through to the
 * forgot-passphrase `[r]/[t]/[q]` reset menu that `start` offers. Reaching
 * that menu from here would let anyone who can run this command set a brand
 * new server password after three guesses, without ever knowing the real
 * passphrase — see `config/startupSecrets.ts` for the full reasoning.
 */

import {
  loadStartupSecrets,
  saveStartupSecrets,
  unlockExistingStartupCipher,
  type StartupSecrets,
} from "../config/startupSecrets.js";
import { promptListenPort } from "../server/startupPrompts.js";
import type { ServerRepairRequest } from "./serverArgs.js";

/**
 * Describes a password change without revealing the password itself.
 *
 * @param password - The value about to be written to `startup.json`.
 * @returns A summary such as `set (12 characters)` or `cleared`.
 */
const describePassword = (password: string | undefined): string =>
  password && password.length > 0 ? `set (${password.length} characters)` : "cleared";

/**
 * Prompts for a non-empty server auth password.
 *
 * @param promptPassphrase - Masked prompt (shared with the passphrase gate).
 * @returns The new password.
 * @throws {Error} When the entered value is empty/whitespace.
 */
const promptNewPassword = async (
  promptPassphrase: (label: string) => Promise<string>,
): Promise<string> => {
  const newPassword = await promptPassphrase("New server password: ");
  if (newPassword.trim().length === 0) {
    throw new Error(
      "Refusing to save an empty password — every client would authenticate automatically.",
    );
  }
  return newPassword;
};

/**
 * Runs the server config-repair flow: unlock, apply the requested changes,
 * save, and report — never starting the server.
 *
 * @remarks
 * Step 0, {@link unlockExistingStartupCipher}, is the whole gate: nothing
 * below it runs, and no file is touched, unless the passphrase was correct.
 *
 * New values are collected before anything is written. `--reset` always
 * prompts for a new password and port (unless `--port <n>` supplies the
 * port), then replaces the old ones in one save — so a cancelled or failed
 * prompt leaves `startup.json` unchanged. Explicit `--password`/`--port`
 * without `--reset` still update only that field.
 *
 * The new password is never echoed or logged — only {@link describePassword}'s
 * character-count summary reaches stdout.
 *
 * @param rootDir - Server data root (the directory `atlas-server` was launched from).
 * @param request - The parsed repair request from `parseServerArgs`.
 * @param promptPassphrase - Injected prompt function — used both for the
 *   passphrase gate and, when a new password is needed, for the password
 *   itself (safe to share: repair mode never has two prompts in flight at
 *   once).
 * @throws {Error} When the passphrase is wrong, nothing has been saved yet,
 *   or a password prompt resolves to an empty string.
 */
export const runServerConfigRepair = async (
  rootDir: string,
  request: ServerRepairRequest,
  promptPassphrase: (label: string) => Promise<string>,
): Promise<void> => {
  // The gate. Throws before any prompt for a new value, and before any file
  // is read or written, on a wrong passphrase or an unconfigured server.
  await unlockExistingStartupCipher(rootDir, promptPassphrase);

  // Collect replacements first — only then build and save `next`, so a
  // cancelled/empty prompt never clears the old password or port on disk.
  let newPort: number | undefined;
  if (request.reset) {
    newPort =
      typeof request.port === "number"
        ? request.port
        : await promptListenPort();
  } else if (request.port !== undefined) {
    newPort =
      request.port === "prompt" ? await promptListenPort() : request.port;
  }

  let newPassword: string | undefined;
  if (request.reset || request.password) {
    newPassword = await promptNewPassword(promptPassphrase);
  }

  const current = await loadStartupSecrets(rootDir);
  const next: StartupSecrets = request.reset ? {} : { ...current };
  if (newPort !== undefined) {
    next.port = newPort;
  }
  if (newPassword !== undefined) {
    next.password = newPassword;
  }

  await saveStartupSecrets(rootDir, next);

  const changes: string[] = [];
  if (request.reset) {
    changes.push("Replaced the old password and port with the new values.");
  }
  if (newPort !== undefined) {
    changes.push(`Port: ${newPort}`);
  }
  if (newPassword !== undefined) {
    changes.push(`Password: ${describePassword(newPassword)}`);
  }

  console.log(`\nSaved to user-data/startup.json.\n  ${changes.join("\n  ")}`);
  console.log(
    `\nCurrent: port ${next.port ?? "(not set — will prompt on next start)"}, ` +
      `password ${describePassword(next.password)}`,
  );
  console.log("Run `atlas-server start` to launch.");
};
