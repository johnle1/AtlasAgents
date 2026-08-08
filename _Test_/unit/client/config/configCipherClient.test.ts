/**
 * Unit tests — client config cipher (AES-256-GCM envelope encryption for
 * the CLI's server password/host).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  ConfigCipherLockedError,
  ConfigDecryptionError,
  decryptSecrets,
  encryptSecrets,
  initializeCipher,
  isUnlocked,
  lockCipher,
  rotateKey,
  unlockCipher,
  type SecretsEnvelope,
} from "@loopycode/shared";

beforeEach(() => {
  lockCipher();
});

describe("configCipher (client) — lock state", () => {
  it("starts locked", () => {
    expect(isUnlocked()).toBe(false);
  });

  it("reports unlocked after initializeCipher", () => {
    initializeCipher("hunter2");
    expect(isUnlocked()).toBe(true);
  });

  it("ConfigCipherLockedError extends Error via super", () => {
    expect(() => encryptSecrets({ a: 1 })).toThrow(ConfigCipherLockedError);
  });

  it("throws ConfigCipherLockedError from decryptSecrets when locked", () => {
    const envelope: SecretsEnvelope = { v: 1, salt: "", iv: "", tag: "", data: "" };
    expect(() => decryptSecrets(envelope)).toThrow(ConfigCipherLockedError);
  });

  it("ConfigDecryptionError extends Error via super", () => {
    initializeCipher("hunter2");
    const envelope: SecretsEnvelope = { v: 1, salt: "x", iv: "y", tag: "z", data: "bad" };
    expect(() => decryptSecrets(envelope)).toThrow(ConfigDecryptionError);
  });
});

describe("configCipher (client) — round trip", () => {
  it("decrypts what it encrypted, in the same session", () => {
    initializeCipher("hunter2");
    const envelope = encryptSecrets({ password: "s3cret", server: "10.0.0.5" });
    expect(decryptSecrets(envelope)).toEqual({ password: "s3cret", server: "10.0.0.5" });
  });

  it("never contains the plaintext secret in the envelope", () => {
    initializeCipher("hunter2");
    const envelope = encryptSecrets({ password: "very-unique-secret-token", server: "x" });
    expect(JSON.stringify(envelope)).not.toContain("very-unique-secret-token");
  });

  it("produces a fresh IV on every encryption, reusing the same salt", () => {
    initializeCipher("hunter2");
    const first = encryptSecrets({ password: "a", server: "b" });
    const second = encryptSecrets({ password: "a", server: "b" });
    expect(first.iv).not.toBe(second.iv);
    expect(first.salt).toBe(second.salt);
  });

  it("unlockCipher against an existing envelope decrypts correctly with the right passphrase", () => {
    initializeCipher("hunter2");
    const envelope = encryptSecrets({ password: "s3cret", server: "10.0.0.5" });
    lockCipher();
    unlockCipher("hunter2", envelope);
    expect(decryptSecrets(envelope)).toEqual({ password: "s3cret", server: "10.0.0.5" });
  });
});

describe("configCipher (client) — wrong passphrase / tampered data", () => {
  it("unlockCipher throws ConfigDecryptionError on wrong passphrase", () => {
    initializeCipher("hunter2");
    const envelope = encryptSecrets({ password: "s3cret", server: "10.0.0.5" });
    lockCipher();
    expect(() => unlockCipher("wrong-passphrase", envelope)).toThrow(ConfigDecryptionError);
  });

  it("does not unlock (stays locked) after a failed unlock attempt", () => {
    initializeCipher("hunter2");
    const envelope = encryptSecrets({ password: "s3cret", server: "10.0.0.5" });
    lockCipher();
    try {
      unlockCipher("wrong-passphrase", envelope);
    } catch {
      // expected
    }
    expect(isUnlocked()).toBe(false);
  });

  it("throws ConfigDecryptionError when the ciphertext is tampered with", () => {
    initializeCipher("hunter2");
    const envelope = encryptSecrets({ password: "s3cret", server: "10.0.0.5" });
    const tampered: SecretsEnvelope = { ...envelope, data: envelope.data.slice(0, -4) + "abcd" };
    expect(() => decryptSecrets(tampered)).toThrow(ConfigDecryptionError);
  });

  it("throws ConfigDecryptionError when the auth tag is tampered with", () => {
    initializeCipher("hunter2");
    const envelope = encryptSecrets({ password: "s3cret", server: "10.0.0.5" });
    const tampered: SecretsEnvelope = { ...envelope, tag: envelope.tag.slice(0, -4) + "abcd" };
    expect(() => decryptSecrets(tampered)).toThrow(ConfigDecryptionError);
  });
});

describe("configCipher (client) — rotateKey", () => {
  it("recovers the plaintext and re-encrypts it decryptable under the new passphrase", () => {
    initializeCipher("old-hunter2");
    const secrets = { password: "s3cret", server: "10.0.0.5" };
    const envelope = encryptSecrets(secrets);
    lockCipher();

    const recovered = rotateKey<typeof secrets>("old-hunter2", "new-hunter3", envelope);
    expect(recovered).toEqual(secrets);

    const rotatedEnvelope = encryptSecrets(secrets);
    expect(decryptSecrets(rotatedEnvelope)).toEqual(secrets);
  });

  it("the old passphrase no longer unlocks anything encrypted after rotation", () => {
    initializeCipher("old-hunter2");
    const secrets = { password: "s3cret", server: "10.0.0.5" };
    const envelope = encryptSecrets(secrets);
    lockCipher();

    rotateKey("old-hunter2", "new-hunter3", envelope);
    const rotatedEnvelope = encryptSecrets(secrets);
    lockCipher();

    expect(() => unlockCipher("old-hunter2", rotatedEnvelope)).toThrow(
      ConfigDecryptionError,
    );
    unlockCipher("new-hunter3", rotatedEnvelope);
    expect(decryptSecrets(rotatedEnvelope)).toEqual(secrets);
  });

  it("leaves the currently-unlocked key untouched when currentPassphrase is wrong", () => {
    initializeCipher("unrelated-session-pass");
    const sessionSecret = { password: "s3cret", server: "10.0.0.5" };
    const sessionEnvelope = encryptSecrets(sessionSecret);

    const otherEnvelope = encryptSecrets({ password: "other", server: "y" });
    expect(() =>
      rotateKey("wrong-pass", "new-pass", otherEnvelope),
    ).toThrow(ConfigDecryptionError);

    expect(isUnlocked()).toBe(true);
    expect(decryptSecrets(sessionEnvelope)).toEqual(sessionSecret);
  });
});
