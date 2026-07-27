/**
 * AES-256-GCM envelope encryption for sensitive `Config` fields (the server
 * password and host), keyed by a passphrase the user enters once at CLI
 * startup.
 *
 * @remarks
 * The key is derived with `scrypt` (deliberately slow/memory-hard, so
 * brute-forcing a stolen `config.json` is expensive) and held in memory only
 * for the life of the process — it is never written to disk, and neither is
 * the passphrase. `config.ts`'s `loadConfig`/`saveConfig` must stay
 * synchronous (they're called from many non-async call sites), so the
 * passphrase must be resolved into a cached key exactly once, at startup,
 * before either is called — see {@link initializeCipher}/{@link unlockCipher}.
 *
 * One envelope covers all sensitive fields together (not per-field), so a
 * salt/IV/tag triple isn't duplicated per field. Every {@link encryptSecrets}
 * call reuses the cached key with a **fresh random IV** — reusing a key
 * across many ciphertexts is safe under AES-GCM as long as each encryption
 * gets its own IV, which is what makes it cheap to re-encrypt on every
 * `saveConfig` without re-running `scrypt` each time.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/** AES-256 key length, in bytes. */
const KEY_LENGTH = 32;
/** scrypt CPU/memory cost parameter. Higher = slower to brute-force, slower to derive. */
const SCRYPT_COST = 2 ** 15;
/**
 * Node's `scryptSync` default `maxmem` (32 MiB) sits exactly at the memory
 * requirement for `SCRYPT_COST` at the default block size, and Node's bound
 * check rejects params sitting exactly on that line — so it must be raised
 * explicitly rather than relying on the default.
 */
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;
/** Salt length for the scrypt KDF, in bytes. */
const SALT_LENGTH = 16;
/** IV length for AES-GCM, in bytes (the standard recommendation is 12). */
const IV_LENGTH = 12;
const ENVELOPE_VERSION = 1;

/** On-disk shape of the encrypted secrets blob (base64-encoded binary fields). */
export type SecretsEnvelope = {
  v: 1;
  /** scrypt salt, base64. Fixed for the life of a given config file. */
  salt: string;
  /** AES-GCM IV, base64. Fresh on every encryption. */
  iv: string;
  /** AES-GCM authentication tag, base64. */
  tag: string;
  /** AES-GCM ciphertext, base64. */
  data: string;
};

/** Thrown when encrypt/decrypt is attempted before the cipher has been unlocked. */
export class ConfigCipherLockedError extends Error {
  constructor() {
    super(
      "Config cipher is locked. Call initializeCipher() or unlockCipher() " +
        "before loading or saving config.",
    );
    this.name = "ConfigCipherLockedError";
  }
}

/** Thrown when decryption fails — wrong passphrase, or corrupted/tampered data. */
export class ConfigDecryptionError extends Error {
  constructor() {
    super(
      "Failed to decrypt config secrets. This means either the passphrase " +
        "is wrong or config.json has been corrupted or tampered with.",
    );
    this.name = "ConfigDecryptionError";
  }
}

let cachedKey: Buffer | null = null;
let cachedSalt: Buffer | null = null;

/** Whether the cipher currently has a key cached (unlocked). */
export const isUnlocked = (): boolean => cachedKey !== null;

/** Drops the cached key. Exposed for tests; the CLI never needs to re-lock mid-session. */
export const lockCipher = (): void => {
  cachedKey = null;
  cachedSalt = null;
};

const deriveKey = (passphrase: string, salt: Buffer): Buffer =>
  scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    maxmem: SCRYPT_MAX_MEM,
  });

const decryptWithKey = <T>(envelope: SecretsEnvelope, key: Buffer): T => {
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported config secrets envelope version: ${envelope.v}`);
  }
  // The whole block — including setAuthTag, which throws synchronously on a
  // malformed (wrong-length) tag rather than surfacing through update/final
  // — must be inside the try. A caller-visible raw TypeError here would slip
  // past callers that specifically catch ConfigDecryptionError (e.g. the
  // wrong-passphrase retry loop in config.ts's unlockOrSetupConfigCipher).
  try {
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const data = Buffer.from(envelope.data, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plaintext.toString("utf-8")) as T;
  } catch {
    // GCM tag verification failed (or JSON was somehow invalid) — wrong
    // passphrase or tampered/malformed ciphertext. Never fall back to
    // defaults here; that would look indistinguishable from "config was
    // silently reset".
    throw new ConfigDecryptionError();
  }
};

/**
 * Unlocks the cipher for a config file that has no existing secrets envelope
 * — first run, or migrating a legacy plaintext config.
 *
 * @remarks
 * Generates a fresh salt and derives the key from `passphrase`. The salt is
 * returned as part of every subsequent {@link encryptSecrets} envelope and
 * must be reused for the life of that config file — do not call this again
 * for a file that already has an envelope; use {@link unlockCipher} instead,
 * which derives against the *existing* salt so previously-encrypted data
 * stays decryptable.
 *
 * @param passphrase - The passphrase the user just chose.
 */
export const initializeCipher = (passphrase: string): void => {
  cachedSalt = randomBytes(SALT_LENGTH);
  cachedKey = deriveKey(passphrase, cachedSalt);
};

/**
 * Unlocks the cipher against an existing secrets envelope, verifying the
 * passphrase by attempting a real decrypt.
 *
 * @param passphrase - The passphrase the user just entered.
 * @param envelope - The `$secrets` envelope currently on disk, whose `salt`
 *   is reused so the derived key matches the one that encrypted it.
 * @throws {ConfigDecryptionError} When `passphrase` is wrong (the envelope's
 *   GCM tag fails to verify against the derived key).
 */
export const unlockCipher = (
  passphrase: string,
  envelope: SecretsEnvelope,
): void => {
  const salt = Buffer.from(envelope.salt, "base64");
  const key = deriveKey(passphrase, salt);
  decryptWithKey(envelope, key); // throws ConfigDecryptionError on wrong passphrase
  cachedSalt = salt;
  cachedKey = key;
};

/**
 * Encrypts `plaintext` into a new secrets envelope using the cached key.
 *
 * @param plaintext - Any JSON-serializable value (in practice, the
 *   sensitive `Config` fields as an object).
 * @returns A new envelope with a fresh IV; `salt` matches every other
 *   envelope produced for this process (see {@link initializeCipher}).
 * @throws {ConfigCipherLockedError} When the cipher hasn't been unlocked yet.
 */
export const encryptSecrets = <T>(plaintext: T): SecretsEnvelope => {
  if (!cachedKey || !cachedSalt) {
    throw new ConfigCipherLockedError();
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", cachedKey, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    salt: cachedSalt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };
};

/**
 * Decrypts a secrets envelope using the cached key.
 *
 * @param envelope - An envelope previously produced by {@link encryptSecrets}
 *   (or read back from disk).
 * @throws {ConfigCipherLockedError} When the cipher hasn't been unlocked yet.
 * @throws {ConfigDecryptionError} When the envelope doesn't match the cached
 *   key (wrong passphrase was used to unlock, or data is corrupted).
 */
export const decryptSecrets = <T>(envelope: SecretsEnvelope): T => {
  if (!cachedKey) {
    throw new ConfigCipherLockedError();
  }
  return decryptWithKey<T>(envelope, cachedKey);
};

/**
 * Rotates to a new passphrase: verifies `currentPassphrase` against the
 * existing envelope, decrypts it, then switches the cached key to a freshly
 * salted derivation of `newPassphrase`.
 *
 * @remarks
 * Does not touch disk — the caller must re-encrypt the returned plaintext
 * with {@link encryptSecrets} (now using the new key) and persist the result
 * itself, since this module has no knowledge of where the envelope is
 * stored. Re-derives `currentPassphrase` explicitly against `envelope`
 * rather than trusting whatever key happens to already be cached, so this
 * is safe to call even if the caller's belief about the current passphrase
 * and the module's cached state have somehow diverged.
 *
 * @param currentPassphrase - The passphrase currently protecting `envelope`.
 * @param newPassphrase - The passphrase to rotate to.
 * @param envelope - The existing envelope; used only to verify
 *   `currentPassphrase` and recover the plaintext to re-encrypt.
 * @returns The plaintext `envelope` protected, for the caller to re-encrypt.
 * @throws {ConfigDecryptionError} When `currentPassphrase` doesn't match `envelope`.
 *
 * @example
 * ```ts
 * const secrets = rotateKey<SecretConfigFields>("old-pass", "new-pass", envelope);
 * const rotatedEnvelope = encryptSecrets(secrets); // now under the new key
 * ```
 */
export const rotateKey = <T>(
  currentPassphrase: string,
  newPassphrase: string,
  envelope: SecretsEnvelope,
): T => {
  const currentSalt = Buffer.from(envelope.salt, "base64");
  const currentKey = deriveKey(currentPassphrase, currentSalt);
  const plaintext = decryptWithKey<T>(envelope, currentKey); // throws ConfigDecryptionError on wrong passphrase

  cachedSalt = randomBytes(SALT_LENGTH);
  cachedKey = deriveKey(newPassphrase, cachedSalt);

  return plaintext;
};
