/**
 * Unit tests — server config cipher (AES-256-GCM envelope encryption for
 * the `providers` config field's API keys).
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

describe("configCipher (server) — lock state", () => {
  it("starts locked", () => {
    expect(isUnlocked()).toBe(false);
  });

  it("reports unlocked after initializeCipher", () => {
    initializeCipher("serverpass");
    expect(isUnlocked()).toBe(true);
  });

  it("throws ConfigCipherLockedError from encryptSecrets when locked", () => {
    expect(() => encryptSecrets({ a: 1 })).toThrow(ConfigCipherLockedError);
  });
});

describe("configCipher (server) — round trip", () => {
  it("decrypts a providers map it just encrypted", () => {
    initializeCipher("serverpass");
    const providers = { openai: { baseUrl: "https://api.openai.com", apiKey: "sk-abc" } };
    const envelope = encryptSecrets(providers);
    expect(decryptSecrets(envelope)).toEqual(providers);
  });

  it("never contains the plaintext apiKey in the envelope", () => {
    initializeCipher("serverpass");
    const envelope = encryptSecrets({
      openai: { baseUrl: "https://api.openai.com", apiKey: "sk-very-unique-key-value" },
    });
    expect(JSON.stringify(envelope)).not.toContain("sk-very-unique-key-value");
  });

  it("unlockCipher against an existing envelope decrypts correctly with the right passphrase", () => {
    initializeCipher("serverpass");
    const providers = { vllm: { baseUrl: "http://10.0.0.9:8000" } };
    const envelope = encryptSecrets(providers);
    lockCipher();
    unlockCipher("serverpass", envelope);
    expect(decryptSecrets(envelope)).toEqual(providers);
  });
});

describe("configCipher (server) — wrong passphrase / tampered data", () => {
  it("unlockCipher throws ConfigDecryptionError on wrong passphrase", () => {
    initializeCipher("serverpass");
    const envelope = encryptSecrets({ openai: { baseUrl: "https://api.openai.com" } });
    lockCipher();
    expect(() => unlockCipher("wrong", envelope)).toThrow(ConfigDecryptionError);
  });

  it("throws ConfigDecryptionError when the ciphertext is tampered with", () => {
    initializeCipher("serverpass");
    const envelope = encryptSecrets({ openai: { baseUrl: "https://api.openai.com" } });
    const tampered: SecretsEnvelope = { ...envelope, data: envelope.data.slice(0, -4) + "abcd" };
    expect(() => decryptSecrets(tampered)).toThrow(ConfigDecryptionError);
  });
});

describe("configCipher (server) — rotateKey", () => {
  it("recovers the plaintext and re-encrypts it decryptable under the new passphrase", () => {
    initializeCipher("old-pass");
    const providers = { openai: { baseUrl: "https://api.openai.com", apiKey: "sk-abc" } };
    const envelope = encryptSecrets(providers);
    lockCipher();

    const recovered = rotateKey<typeof providers>("old-pass", "new-pass", envelope);
    expect(recovered).toEqual(providers);

    // The cached key is now the NEW one — encrypting fresh data uses it.
    const rotatedEnvelope = encryptSecrets(providers);
    expect(decryptSecrets(rotatedEnvelope)).toEqual(providers);
  });

  it("the old passphrase no longer unlocks anything encrypted after rotation", () => {
    initializeCipher("old-pass");
    const providers = { vllm: { baseUrl: "http://10.0.0.9:8000" } };
    const envelope = encryptSecrets(providers);
    lockCipher();

    rotateKey("old-pass", "new-pass", envelope);
    const rotatedEnvelope = encryptSecrets(providers);
    lockCipher();

    expect(() => unlockCipher("old-pass", rotatedEnvelope)).toThrow(
      ConfigDecryptionError,
    );
    unlockCipher("new-pass", rotatedEnvelope);
    expect(decryptSecrets(rotatedEnvelope)).toEqual(providers);
  });

  it("leaves the currently-unlocked key untouched when currentPassphrase is wrong", () => {
    // Unlocked with an UNRELATED key first — this is what a running process
    // actually looks like when an operator attempts a rotation. The
    // assertion below only means something if we start unlocked: proving
    // this key survives a failed rotation attempt (rather than merely
    // confirming an already-locked cipher stays locked).
    initializeCipher("unrelated-session-pass");
    const sessionSecret = { openai: { baseUrl: "https://api.openai.com" } };
    const sessionEnvelope = encryptSecrets(sessionSecret);

    const otherEnvelope = encryptSecrets({ vllm: { baseUrl: "http://10.0.0.9:8000" } });
    expect(() =>
      rotateKey("wrong-pass", "new-pass", otherEnvelope),
    ).toThrow(ConfigDecryptionError);

    // The key that was already unlocked must still work exactly as before —
    // a failed rotation must not partially swap or clear the cached key.
    expect(isUnlocked()).toBe(true);
    expect(decryptSecrets(sessionEnvelope)).toEqual(sessionSecret);
  });
});
