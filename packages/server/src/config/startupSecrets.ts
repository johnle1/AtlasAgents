/**
 * Persists the server's auth password and TCP listen port, encrypted under
 * the same passphrase-derived key that protects `providers` in
 * `user-data/config.json`.
 *
 * @remarks
 * Lives in its own file (`user-data/startup.json`) rather than as fields on
 * `ServerConfig`, for two reasons:
 *
 * 1. `ServerConfig` is shipped to every connected client (minus provider
 *    secrets — see `createGetConfigHandler` in `routing/routerBuilder.ts`).
 *    A `password` field there would broadcast the server's auth password to
 *    anyone who can authenticate with it.
 * 2. `_saveRaw` in `configManager.ts` rebuilds `config.json` from a fixed
 *    set of known fields on every write; an extra top-level key would be
 *    silently dropped on the next `/set`.
 *
 * The two files share one process-global cipher key/salt (see
 * `@atlasagents/shared`'s `configCipher.ts`) — `initializeCipher` picks a
 * fresh salt, so whichever of `unlockOrSetupStartupCipher` (this module) or
 * `ConfigManager.unlockOrSetupProvidersCipher` runs first determines the
 * salt for *both* files. The startup sequence in `server/index.ts` always
 * unlocks this module's cipher first, so `ConfigManager` finds it already
 * unlocked (`isUnlocked() === true`) and skips its own prompt. Because the
 * salt is shared, resetting one envelope without the other would leave the
 * un-reset file undecryptable under the new key — {@link offerStartupPassphraseReset}
 * clears both.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ConfigDecryptionError,
  decryptSecrets,
  encryptSecrets,
  initializeCipher,
  unlockCipher,
  type SecretsEnvelope,
} from "@atlasagents/shared";
import { atomicWriteJson } from "../utils/atomicWriteJson.js";
import {
  CONFIG_REL_PATH,
  EXISTING_PASSPHRASE_LABEL,
  MAX_PASSPHRASE_ATTEMPTS,
  NEW_PASSPHRASE_LABEL,
} from "./types.js";

/** Relative path to the encrypted startup-secrets file, under the server data root. */
export const STARTUP_REL_PATH = "user-data/startup.json";

/** Decrypted contents of the `$startupSecrets` envelope. Both fields optional — an empty object is the post-`--reset` state. */
export type StartupSecrets = {
  password?: string;
  port?: number;
};

/**
 * Reads one named envelope field out of a JSON file, tolerating a missing
 * file, invalid JSON, or a non-object root — all of which mean "no envelope
 * here yet" rather than an error worth surfacing.
 */
const readEnvelopeField = async (
  filePath: string,
  field: string,
): Promise<SecretsEnvelope | undefined> => {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const envelope = (parsed as Record<string, unknown>)[field];
  return envelope ? (envelope as SecretsEnvelope) : undefined;
};

/**
 * Locates the envelope that should gate this passphrase: `startup.json`'s
 * own envelope if present, otherwise `config.json`'s `$providersSecrets` —
 * so an install that predates this file keeps its existing passphrase
 * instead of being treated as first-run.
 *
 * @param rootDir - Server data root (the directory `atlas-server` was launched from).
 */
export const findExistingEnvelope = async (
  rootDir: string,
): Promise<SecretsEnvelope | undefined> => {
  const startupEnvelope = await readEnvelopeField(
    path.join(rootDir, STARTUP_REL_PATH),
    "$startupSecrets",
  );
  if (startupEnvelope) {
    return startupEnvelope;
  }
  return readEnvelopeField(
    path.join(rootDir, CONFIG_REL_PATH),
    "$providersSecrets",
  );
};

/**
 * Reads and decrypts the saved password/port. Requires the cipher to already
 * be unlocked (via {@link unlockOrSetupStartupCipher} or
 * {@link unlockExistingStartupCipher}).
 *
 * @param rootDir - Server data root.
 * @returns `{}` when `startup.json` doesn't exist or has no envelope yet —
 *   the caller should prompt for whatever's missing.
 * @throws {ConfigCipherLockedError} When the cipher hasn't been unlocked.
 */
export const loadStartupSecrets = async (
  rootDir: string,
): Promise<StartupSecrets> => {
  const envelope = await readEnvelopeField(
    path.join(rootDir, STARTUP_REL_PATH),
    "$startupSecrets",
  );
  if (!envelope) {
    return {};
  }
  return decryptSecrets<StartupSecrets>(envelope);
};

/**
 * Encrypts and atomically persists the password/port.
 *
 * @param rootDir - Server data root.
 * @param secrets - The full startup-secrets object to save (not a patch —
 *   callers merge with {@link loadStartupSecrets} first).
 * @throws {ConfigCipherLockedError} When the cipher hasn't been unlocked.
 */
export const saveStartupSecrets = async (
  rootDir: string,
  secrets: StartupSecrets,
): Promise<void> => {
  const envelope = encryptSecrets(secrets);
  await atomicWriteJson(
    path.join(rootDir, STARTUP_REL_PATH),
    { $startupSecrets: envelope },
    "startup",
  );
};

/**
 * Copies `filePath` to `backupPath` if it exists, chmod'd 0600. A no-op when
 * the source is missing — callers back up two files that don't necessarily
 * both exist (e.g. `startup.json` predates `config.json`'s providers).
 */
const backupIfExists = async (
  filePath: string,
  backupPath: string,
): Promise<void> => {
  try {
    await fs.copyFile(filePath, backupPath);
    await fs.chmod(backupPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

/**
 * Runs up to `maxAttempts` passphrase prompts against `envelope`, unlocking
 * the shared cipher on a correct entry.
 *
 * @remarks
 * Shared by both {@link unlockOrSetupStartupCipher} (which offers a reset
 * menu after exhaustion) and {@link unlockExistingStartupCipher} (which
 * simply throws) — factored out so the two call sites can't drift apart in
 * how they count attempts or classify a decryption failure vs. a real error.
 *
 * @throws Rethrows immediately on any error that isn't
 *   {@link ConfigDecryptionError} — a real error (disk, corruption) should
 *   never be swallowed into a "wrong passphrase" retry.
 */
const runUnlockAttempts = async (
  envelope: SecretsEnvelope,
  promptPassphrase: (label: string) => Promise<string>,
  maxAttempts: number,
): Promise<"unlocked" | "exhausted"> => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const passphrase = await promptPassphrase(EXISTING_PASSPHRASE_LABEL);
    try {
      unlockCipher(passphrase, envelope);
      return "unlocked";
    } catch (error) {
      if (!(error instanceof ConfigDecryptionError)) {
        throw error;
      }
      if (attempt < maxAttempts - 1) {
        process.stderr.write("Wrong passphrase. Try again.\n");
      }
    }
  }
  return "exhausted";
};

/**
 * The forgot-passphrase escape hatch, reachable only from
 * {@link unlockOrSetupStartupCipher} (i.e. only from `atlas-server start` —
 * never from repair mode; see that module's doc comment for why).
 *
 * @remarks
 * Because the two files share one salt, a reset must clear the encrypted
 * envelope in **both** `startup.json` and `config.json` — leaving either one
 * behind would make it undecryptable once the cipher re-initializes with a
 * fresh salt under the new passphrase. Everything in `config.json` other
 * than `$providersSecrets`/`providers` (models, temps, timeouts, ...) is
 * preserved.
 *
 * @returns `"unlocked"` once a new passphrase has been set; `"retry"` if the
 *   user chose to try again or backed out of the reset confirmation.
 * @throws {Error} When the user chooses to quit.
 */
const offerStartupPassphraseReset = async (
  rootDir: string,
  promptPassphrase: (label: string) => Promise<string>,
): Promise<"unlocked" | "retry"> => {
  const choice = (
    await promptPassphrase(
      `Wrong passphrase ${MAX_PASSPHRASE_ATTEMPTS} times in a row.\n` +
        "  [r] Reset — discard your saved server password, port, and provider API keys, and set a new passphrase now\n" +
        "  [t] Try again\n" +
        "  [q] Quit\n" +
        "Choose [r/t/q]: ",
    )
  )
    .trim()
    .toLowerCase()
    .charAt(0);

  if (choice === "q") {
    throw new Error("Aborted: server config passphrase not entered.");
  }
  if (choice !== "r") {
    return "retry";
  }

  const confirmed =
    (
      await promptPassphrase(
        "This will permanently discard your saved server password, port, and " +
          'provider API keys. This cannot be undone.\nType "yes" to confirm, or anything else to cancel: ',
      )
    )
      .trim()
      .toLowerCase() === "yes";
  if (!confirmed) {
    return "retry";
  }

  const startupPath = path.join(rootDir, STARTUP_REL_PATH);
  const configPath = path.join(rootDir, CONFIG_REL_PATH);
  const timestamp = Date.now();

  await backupIfExists(startupPath, `${startupPath}.bak-${timestamp}`);
  await backupIfExists(configPath, `${configPath}.bak-${timestamp}`);

  // startup.json's entire content is the envelope — just remove the file.
  await fs.rm(startupPath, { force: true });

  // config.json carries other, non-secret fields too — strip only the
  // envelope (and any stray plaintext providers) and keep the rest.
  let configStored: Record<string, unknown> = {};
  try {
    configStored = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (Object.keys(configStored).length > 0) {
    const { $providersSecrets: _oldSecrets, providers: _oldProviders, ...rest } =
      configStored;
    await atomicWriteJson(configPath, rest, "config");
  }

  initializeCipher(await promptPassphrase(NEW_PASSPHRASE_LABEL));

  process.stderr.write(
    "Reset. Your saved server password, port, and provider API keys were cleared " +
      "— you'll be prompted for a password and port on the next start, and can re-add " +
      "provider API keys with /providers add. Your previous encrypted files were backed " +
      `up alongside them (.bak-${timestamp}).\n`,
  );
  return "unlocked";
};

/**
 * Unlocks (or sets up) the shared cipher, for `atlas-server start` only.
 *
 * @remarks
 * Three cases:
 *
 * 1. **No envelope anywhere** (first run): prompts to set a new passphrase
 *    and initializes the cipher. The first {@link saveStartupSecrets} call
 *    creates the encrypted file.
 * 2. **An envelope exists** (in `startup.json`, or in `config.json` for an
 *    install that predates this file): prompts for the existing passphrase,
 *    up to {@link MAX_PASSPHRASE_ATTEMPTS} times.
 * 3. **Exhausted attempts**: offers the `[r]/[t]/[q]` reset menu — this is
 *    the *only* place that menu is reachable. `--password`/`--port`/`--reset`
 *    repair mode uses {@link unlockExistingStartupCipher} instead, which has
 *    no such escape hatch (see that function's doc comment for why).
 *
 * @param rootDir - Server data root.
 * @param promptPassphrase - Injected prompt function (the server's masked
 *   startup prompt in production; a scripted stub in tests).
 * @throws {Error} When the user quits out of the reset menu.
 */
export const unlockOrSetupStartupCipher = async (
  rootDir: string,
  promptPassphrase: (label: string) => Promise<string>,
): Promise<void> => {
  const envelope = await findExistingEnvelope(rootDir);
  if (!envelope) {
    initializeCipher(await promptPassphrase(NEW_PASSPHRASE_LABEL));
    return;
  }

  for (;;) {
    const result = await runUnlockAttempts(
      envelope,
      promptPassphrase,
      MAX_PASSPHRASE_ATTEMPTS,
    );
    if (result === "unlocked") {
      return;
    }
    if (
      (await offerStartupPassphraseReset(rootDir, promptPassphrase)) ===
      "unlocked"
    ) {
      return;
    }
    // "retry" — loop back and prompt against the same (still-encrypted,
    // not-yet-reset) envelope again.
  }
};

/**
 * Unlocks the shared cipher against an *existing* envelope only — for
 * `--password`/`--port`/`--reset` repair mode. Never sets up a fresh cipher
 * and never offers the reset menu.
 *
 * @remarks
 * The `[r]` reset choice in {@link offerStartupPassphraseReset} lets the
 * caller pick a **brand-new passphrase of their own choosing** after too
 * many wrong entries — appropriate as a forgot-passphrase escape hatch on
 * `start`, but a straight authentication bypass if reachable from a flag
 * that changes the server's auth password. So repair mode gets a strictly
 * fail-closed gate instead: a wrong passphrase (or no saved config to check
 * against yet) throws, and nothing is written.
 *
 * @param rootDir - Server data root.
 * @param promptPassphrase - Injected prompt function.
 * @throws {Error} When there is no saved server config yet (nothing to
 *   verify the passphrase against — see the `start` command instead), or
 *   when {@link MAX_PASSPHRASE_ATTEMPTS} consecutive entries are wrong.
 */
export const unlockExistingStartupCipher = async (
  rootDir: string,
  promptPassphrase: (label: string) => Promise<string>,
): Promise<void> => {
  const envelope = await findExistingEnvelope(rootDir);
  if (!envelope) {
    throw new Error(
      "No saved server config yet — run `atlas-server start` first.",
    );
  }

  const result = await runUnlockAttempts(
    envelope,
    promptPassphrase,
    MAX_PASSPHRASE_ATTEMPTS,
  );
  if (result === "exhausted") {
    throw new Error("Wrong passphrase — nothing was changed.");
  }
};
