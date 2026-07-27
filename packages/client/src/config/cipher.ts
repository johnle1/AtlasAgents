/**
 * Passphrase lifecycle for the encrypted `password`/`server` fields: first-run
 * setup, unlocking an existing encrypted or legacy plaintext file, the
 * forgotten-passphrase reset menu, and passphrase rotation.
 *
 * @remarks
 * The actual encrypt/decrypt calls on every load/save live in `manager.ts` —
 * this file only owns the interactive passphrase flow around them.
 */

import * as fs from "node:fs";
import { readMaskedPassword } from "../utils/maskedPassword.js";
import {
  ConfigDecryptionError,
  initializeCipher,
  rotateKey,
  unlockCipher,
} from "../crypto/configCipher.js";
import type { SecretConfigFields, StoredConfig } from "./types.js";
import {
  CONFIG_FILE,
  MAX_PASSPHRASE_ATTEMPTS,
  NEW_PASSPHRASE_LABEL,
  omitSecretFields,
} from "./types.js";
import { mergeConfigFromDisk } from "./parsing.js";
import { ensureDirs, loadConfig, saveConfig } from "./manager.js";

/**
 * Outcome of {@link offerPassphraseReset}: either the user reset the cipher
 * (now unlocked with a new passphrase) or declined, so the caller should
 * keep prompting for the original passphrase.
 */
type PassphraseRecoveryOutcome = "unlocked" | "retry";

/**
 * Offers a menu to reset the encrypted secrets after repeated wrong
 * passphrase attempts, rather than looping forever with no way out.
 *
 * @remarks
 * Reuses the same injected `promptPassphrase` callback for the menu and
 * confirmation text — no new parameter, so existing call sites/tests are
 * unaffected. "Reset" backs up the current file (so the choice isn't
 * quite as irreversible as the confirmation text says — the encrypted
 * backup survives in case the passphrase is remembered later), strips the
 * `$secrets` envelope, and writes everything else back unchanged.
 *
 * @param promptPassphrase - The injected prompt callback.
 * @param stored - The already-parsed on-disk object; every field except
 *   `$secrets`/`password`/`server` is preserved across a reset.
 * @returns `"unlocked"` if the user reset (cipher is now ready to use with
 *   a fresh passphrase); `"retry"` if the caller should go back to
 *   prompting for the original passphrase (chose "try again", or backed
 *   out of the reset confirmation).
 * @throws {Error} When the user chooses to quit.
 */
const offerPassphraseReset = async (
  promptPassphrase: (label: string) => Promise<string>,
  stored: StoredConfig,
): Promise<PassphraseRecoveryOutcome> => {
  const choice = (
    await promptPassphrase(
      `Wrong passphrase ${MAX_PASSPHRASE_ATTEMPTS} times in a row.\n` +
        "  [r] Reset — discard the encrypted server password & host and set a new passphrase now\n" +
        "  [t] Try again\n" +
        "  [q] Quit\n" +
        "Choose [r/t/q]: ",
    )
  )
    .trim()
    .toLowerCase()
    .charAt(0);

  if (choice === "q") {
    throw new Error("Aborted: config passphrase not entered.");
  }
  if (choice !== "r") {
    return "retry";
  }

  const confirmed =
    (
      await promptPassphrase(
        "This will permanently discard your saved server password and host. " +
          'This cannot be undone.\nType "yes" to confirm, or anything else to cancel: ',
      )
    )
      .trim()
      .toLowerCase() === "yes";
  if (!confirmed) {
    return "retry";
  }

  const backupPath = `${CONFIG_FILE}.bak-${Date.now()}`;
  fs.copyFileSync(CONFIG_FILE, backupPath);
  fs.chmodSync(backupPath, 0o600);

  initializeCipher(await promptPassphrase(NEW_PASSPHRASE_LABEL));
  saveConfig(mergeConfigFromDisk(omitSecretFields(stored)));

  process.stderr.write(
    "Reset. Your server password and host were cleared — reconfigure them via " +
      "the setup wizard or /set password and /set server. Your previous " +
      `encrypted config was backed up to ${backupPath}.\n`,
  );
  return "unlocked";
};

/**
 * Prompts for a passphrase and unlocks the config cipher, migrating a legacy
 * plaintext config.json in place if one is found.
 *
 * @remarks
 * Must be called once, before any other function in this module, at CLI
 * startup. `loadConfig`/`saveConfig` are synchronous (called from many
 * non-async call sites throughout the CLI) and so cannot themselves prompt
 * for a passphrase — this async step resolves the passphrase into the
 * cipher's in-memory key ahead of time. Three cases:
 *
 * 1. **No config.json yet** (first run): prompts to set a new passphrase and
 *    initializes the cipher. `loadConfig()`'s first call creates the
 *    encrypted file.
 * 2. **config.json has a `$secrets` envelope**: prompts for the existing
 *    passphrase and unlocks against it, re-prompting on a wrong entry. After
 *    {@link MAX_PASSPHRASE_ATTEMPTS} consecutive wrong entries, offers a
 *    reset menu (see {@link offerPassphraseReset}) rather than looping
 *    forever with no way out for someone who's forgotten it.
 * 3. **config.json exists but is still the legacy plaintext format**:
 *    prompts to set a passphrase, backs up the old file alongside it, then
 *    immediately re-saves it in the new encrypted format — no user is left
 *    holding a plaintext config across an upgrade.
 *
 * @param promptPassphrase - Injected prompt function, for testability.
 *   Defaults to an interactive masked terminal prompt.
 *
 * @example
 * ```ts
 * // At the very top of the CLI entrypoint, before loadTheme()/loadConfig():
 * await unlockOrSetupConfigCipher();
 * ```
 */
export const unlockOrSetupConfigCipher = async (
  promptPassphrase: (label: string) => Promise<string> = readMaskedPassword,
): Promise<void> => {
  ensureDirs();

  const promptNewPassphrase = () => promptPassphrase(NEW_PASSPHRASE_LABEL);

  if (!fs.existsSync(CONFIG_FILE)) {
    initializeCipher(await promptNewPassphrase());
    return;
  }

  let stored: StoredConfig;
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as StoredConfig;
  } catch {
    // Corrupt file — loadConfig()'s own fallback produces fresh defaults;
    // still need a passphrase for the encrypted file that gets written.
    initializeCipher(await promptNewPassphrase());
    return;
  }

  if (stored.$secrets) {
    const envelope = stored.$secrets;
    let wrongAttempts = 0;
    for (;;) {
      const passphrase = await promptPassphrase(
        "Enter your config passphrase: ",
      );
      try {
        unlockCipher(passphrase, envelope);
        return;
      } catch (error) {
        if (!(error instanceof ConfigDecryptionError)) {
          throw error;
        }
        wrongAttempts += 1;
        if (wrongAttempts < MAX_PASSPHRASE_ATTEMPTS) {
          process.stderr.write("Wrong passphrase. Try again.\n");
          continue;
        }
        if (
          (await offerPassphraseReset(promptPassphrase, stored)) === "unlocked"
        ) {
          return;
        }
        wrongAttempts = 0;
      }
    }
  }

  // Legacy plaintext config: migrate in place.
  process.stderr.write(
    "Your config.json currently stores the server password and host in " +
      "plaintext. Set a passphrase to encrypt them going forward.\n",
  );
  initializeCipher(await promptNewPassphrase());
  const backupPath = `${CONFIG_FILE}.bak-${Date.now()}`;
  fs.copyFileSync(CONFIG_FILE, backupPath);
  fs.chmodSync(backupPath, 0o600);
  saveConfig(loadConfig());
  process.stderr.write(
    `Migrated to encrypted config. Your previous plaintext config was backed up to ${backupPath}.\n`,
  );
};

/**
 * Rotates the passphrase protecting the encrypted server password/host,
 * re-encrypting them under a fresh salt/key without losing the existing
 * values.
 *
 * @remarks
 * Requires `currentPassphrase` explicitly rather than trusting whatever the
 * cipher happens to already be unlocked with for this session — the same
 * discipline as changing a password normally requires re-entering the old
 * one.
 *
 * If saving the re-encrypted config fails (disk full, permissions), the
 * in-memory cipher is rolled back to `currentPassphrase` so it stays
 * consistent with what's actually on disk — otherwise a failed rotation
 * would leave the running CLI holding a key that can no longer decrypt its
 * own config file until restart.
 *
 * @param currentPassphrase - The passphrase currently protecting the
 *   on-disk `$secrets` envelope.
 * @param newPassphrase - The passphrase to rotate to.
 * @throws {Error} When no config file exists yet, or the config has never
 *   been encrypted (nothing to rotate).
 * @throws {ConfigDecryptionError} When `currentPassphrase` is wrong.
 *
 * @example
 * ```ts
 * rotateConfigPassphrase("old-pass", "new-pass");
 * // The server password/host are unchanged; the passphrase to unlock them is not.
 * ```
 */
export const rotateConfigPassphrase = (
  currentPassphrase: string,
  newPassphrase: string,
): void => {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error("No config file exists yet — nothing to rotate.");
  }

  const stored = JSON.parse(
    fs.readFileSync(CONFIG_FILE, "utf-8"),
  ) as StoredConfig;
  if (!stored.$secrets) {
    throw new Error(
      "Config secrets are not encrypted yet — nothing to rotate.",
    );
  }

  const envelope = stored.$secrets;
  // Verifies currentPassphrase against the on-disk envelope, decrypts it,
  // and swaps the cipher's cached key to a fresh derivation of
  // newPassphrase — throws ConfigDecryptionError before any of that swap
  // happens if currentPassphrase is wrong.
  const secretFields = rotateKey<SecretConfigFields>(
    currentPassphrase,
    newPassphrase,
    envelope,
  );

  const mergedConfig = mergeConfigFromDisk({
    ...omitSecretFields(stored),
    ...secretFields,
  });

  try {
    saveConfig(mergedConfig);
  } catch (saveError) {
    // Roll back so the cached key matches what's actually on disk.
    unlockCipher(currentPassphrase, envelope);
    throw saveError;
  }
};
