/**
 * Unit tests — TOFU (trust-on-first-use) fingerprint pinning for TLS server
 * certificates.
 *
 * @remarks
 * `config.ts` computes its config directory from `os.homedir()` once at
 * module load, so `HOME` is overridden and `config.js`/`fingerprintStore.js`
 * are imported dynamically inside `beforeAll` — after the override — rather
 * than statically at the top of this file. Vitest isolates each test file's
 * module registry by default, so this doesn't leak into other test files.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("fingerprintStore", () => {
  let checkAndPinFingerprint: typeof import("../../../../packages/client/src/connection/tls/fingerprintStore.js").checkAndPinFingerprint;
  let clearFingerprint: typeof import("../../../../packages/client/src/connection/tls/fingerprintStore.js").clearFingerprint;
  let fingerprintKeyFn: typeof import("../../../../packages/client/src/connection/tls/fingerprintStore.js").fingerprintKey;
  let unlockOrSetupConfigCipher: typeof import("../../../../packages/client/src/config/index.js").unlockOrSetupConfigCipher;
  let originalHome: string | undefined;
  let tempHome: string;

  beforeAll(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "loopy-fingerprint-test-"));
    process.env.HOME = tempHome;

    const fpMod = await import(
      "../../../../packages/client/src/connection/tls/fingerprintStore.js"
    );
    checkAndPinFingerprint = fpMod.checkAndPinFingerprint;
    clearFingerprint = fpMod.clearFingerprint;
    fingerprintKeyFn = fpMod.fingerprintKey;

    const configMod = await import("../../../../packages/client/src/config/index.js");
    unlockOrSetupConfigCipher = configMod.unlockOrSetupConfigCipher;
    // Unlock once for the whole file — a passphrase prompt for fingerprint
    // pinning would be an unrelated, noisy dependency to inject per test.
    await unlockOrSetupConfigCipher(async () => "test-passphrase");
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // Each test uses a distinct host so pins never collide across tests
  // sharing the same on-disk config.json within this file's temp HOME.

  it("builds the host:port lookup key", () => {
    expect(fingerprintKeyFn("example.com", 7000)).toBe("example.com:7000");
  });

  it("trusts and pins on the first connection to a host:port", () => {
    const result = checkAndPinFingerprint("host-a", 1, "AA:BB:CC");
    expect(result).toEqual({ trust: true, firstConnection: true });
  });

  it("trusts a second connection presenting the same fingerprint", () => {
    checkAndPinFingerprint("host-b", 1, "AA:BB:CC");
    const result = checkAndPinFingerprint("host-b", 1, "AA:BB:CC");
    expect(result).toEqual({ trust: true, firstConnection: false });
  });

  it("rejects a changed fingerprint for an already-pinned host:port", () => {
    checkAndPinFingerprint("host-c", 1, "AA:BB:CC");
    const result = checkAndPinFingerprint("host-c", 1, "DD:EE:FF");
    expect(result).toEqual({ trust: false, pinnedFingerprint: "AA:BB:CC" });
  });

  it("never overwrites an existing pin, even after a rejected attempt", () => {
    checkAndPinFingerprint("host-d", 1, "AA:BB:CC");
    checkAndPinFingerprint("host-d", 1, "DD:EE:FF"); // rejected
    const result = checkAndPinFingerprint("host-d", 1, "AA:BB:CC"); // original still trusted
    expect(result).toEqual({ trust: true, firstConnection: false });
  });

  it("keeps pins for different host:port pairs independent", () => {
    checkAndPinFingerprint("host-e", 1, "111");
    checkAndPinFingerprint("host-e", 2, "222");
    expect(checkAndPinFingerprint("host-e", 1, "111")).toEqual({
      trust: true,
      firstConnection: false,
    });
    expect(checkAndPinFingerprint("host-e", 2, "222")).toEqual({
      trust: true,
      firstConnection: false,
    });
    expect(checkAndPinFingerprint("host-e", 1, "999")).toEqual({
      trust: false,
      pinnedFingerprint: "111",
    });
  });

  it("clearFingerprint removes a pin and allows first-use trust again", () => {
    checkAndPinFingerprint("host-f", 1, "AA:BB:CC");
    expect(clearFingerprint("host-f", 1)).toBe(true);
    const result = checkAndPinFingerprint("host-f", 1, "DD:EE:FF");
    expect(result).toEqual({ trust: true, firstConnection: true });
  });

  it("clearFingerprint returns false when nothing was pinned", () => {
    expect(clearFingerprint("host-never-connected", 1)).toBe(false);
  });
});
