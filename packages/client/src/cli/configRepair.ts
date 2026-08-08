/**
 * Offline config repair: changes the saved server address, port, and password
 * without needing a working connection to that server.
 *
 * @remarks
 * This is the escape hatch for the bootstrap deadlock. The in-app commands that
 * change connection settings (`/set server`, `/set port`, `/set password`) only
 * exist once the CLI has connected, so when an operator changes the server's
 * password, port, or IP, the client can neither connect nor be corrected — and
 * `config.json` cannot be hand-edited either, because those fields live inside
 * an encrypted `$secrets` envelope.
 *
 * Everything here runs before Ink mounts and never constructs a `Connection`.
 * The only gate is the config passphrase, which is exactly the gate that
 * already protects those fields at rest.
 */

import {
  getDefaultConfig,
  updateConfig,
  unlockOrSetupConfigCipher,
  type Config,
} from "../config/index.js";
import { readMaskedPassword } from "../utils/maskedPassword.js";
import { clearFingerprint } from "../connection/tls/fingerprintStore.js";
import type { ConfigRepairRequest } from "./types.js";

/**
 * Describes a password change without revealing the password itself.
 *
 * @remarks
 * Only ever returns a description — the value is never returned, logged, or
 * otherwise echoed. The character count is included so the user can tell a
 * successful entry from a stray empty one.
 *
 * @param password - The value about to be written to config.
 * @returns A summary such as `set (12 characters)` or `cleared`.
 */
const describePassword = (password: string): string =>
  password.length > 0 ? `set (${password.length} characters)` : "cleared";

/**
 * Builds the config patch for a repair request.
 *
 * @remarks
 * Assembled as a single patch, applied with one {@link updateConfig} call, so a
 * mid-way failure cannot leave the address updated but the password not.
 *
 * `--reset` is applied first and the explicit flags layer on top, which makes
 * `loopycode --reset --address 10.0.0.7 --password` mean "forget everything about
 * the old server, then point at this one" in a single command.
 *
 * @param request - The parsed repair request.
 * @param newPassword - The password collected from the prompt, or undefined
 *   when `--password` was not requested.
 * @returns The patch to hand to {@link updateConfig}.
 */
const buildRepairPatch = (
  request: ConfigRepairRequest,
  newPassword: string | undefined,
): Partial<Config> => {
  const patch: Partial<Config> = {};

  if (request.reset) {
    const defaults = getDefaultConfig();
    patch.password = "";
    patch.server = defaults.server;
    patch.port = defaults.port;
    // Pinned certificates are cleared wholesale rather than per host:port. A
    // reset is precisely the case where the old pins are the problem: a
    // rebuilt or re-addressed server presents a certificate that no longer
    // matches its pin, and the TOFU check would refuse the connection with no
    // obvious way to clear it.
    patch.serverFingerprints = {};
  }

  if (request.server !== undefined) {
    patch.server = request.server;
  }
  if (request.port !== undefined) {
    patch.port = request.port;
  }
  if (newPassword !== undefined) {
    patch.password = newPassword;
  }

  return patch;
};

/**
 * Runs the config-repair flow: unlock, apply the requested changes, then report.
 *
 * @remarks
 * Passphrase handling is delegated wholesale to
 * {@link unlockOrSetupConfigCipher}, which already owns the retry loop and —
 * after three consecutive wrong entries — the reset menu that backs up
 * `config.json` and lets someone who has genuinely forgotten the passphrase set
 * a new one. A repair run therefore inherits a way out even when the passphrase
 * itself is lost, and no second passphrase loop exists to drift out of sync.
 *
 * Nothing is written unless the cipher unlocks first: a wrong passphrase throws
 * out of `unlockOrSetupConfigCipher` before {@link buildRepairPatch} is reached,
 * leaving `config.json` untouched.
 *
 * The new password is never echoed — only {@link describePassword}'s summary of
 * it reaches stdout.
 *
 * @param request - The parsed repair request from `parseCliArgs`.
 * @param promptPassphrase - Injected prompt function, for testability. Defaults
 *   to the interactive masked terminal prompt. Safe to share with the
 *   passphrase prompt because repair mode runs entirely before Ink starts, so
 *   nothing else owns stdin.
 * @throws {Error} When the user aborts at the passphrase prompt.
 *
 * @example
 * ```ts
 * // loopycode --address 10.0.0.7 --port 8001 --password
 * await runConfigRepair({
 *   reset: false,
 *   password: true,
 *   server: "10.0.0.7",
 *   port: 8001,
 * });
 * ```
 */
export const runConfigRepair = async (
  request: ConfigRepairRequest,
  promptPassphrase: (label: string) => Promise<string> = readMaskedPassword,
): Promise<void> => {
  // Gates the whole flow: without the correct passphrase the secrets cannot be
  // decrypted, and re-saving them would destroy the values we cannot read.
  await unlockOrSetupConfigCipher(promptPassphrase);

  const newPassword = request.password
    ? await promptPassphrase("New server password: ")
    : undefined;

  const updated = updateConfig(buildRepairPatch(request, newPassword));

  const changes: string[] = [];
  if (request.reset) {
    changes.push(
      "Cleared the saved password, address, port, and pinned TLS certificates.",
    );
  }
  if (request.server !== undefined) {
    changes.push(`Address: ${updated.server}`);
  }
  if (request.port !== undefined) {
    changes.push(`Port: ${updated.port}`);
  }
  if (newPassword !== undefined) {
    changes.push(`Password: ${describePassword(newPassword)}`);
  }
  if (request.trustFingerprint && !request.reset) {
    // --reset already wipes serverFingerprints wholesale; avoid a redundant
    // (and potentially misleading) second message here.
    const hadPin = clearFingerprint(updated.server, updated.port);
    changes.push(
      hadPin
        ? `Cleared pinned TLS fingerprint for ${updated.server}:${updated.port}.`
        : `No TLS fingerprint was pinned for ${updated.server}:${updated.port}.`,
    );
  }

  console.log(`\nSaved to config.json.\n  ${changes.join("\n  ")}`);
  console.log(
    `\nCurrent target: ${updated.server}:${updated.port} ` +
      `(password ${describePassword(updated.password)})`,
  );
  console.log(
    updated.password.length > 0
      ? "Run `loopycode` to connect."
      : "Run `loopycode` to finish setup.",
  );
};
