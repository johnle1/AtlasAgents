/**
 * Unit tests — server TLS certificate store (self-signed cert generation
 * and persistence).
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { X509Certificate } from "node:crypto";
import * as path from "node:path";
import {
  certificateExpiry,
  loadOrCreateServerCert,
  regenerateServerCert,
} from "../../../../packages/server/src/server/tls/certificateStore.js";

const tempRoots: string[] = [];

const makeTempRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-cert-test-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("loadOrCreateServerCert", () => {
  it("generates a cert, key, and fingerprint on first call", async () => {
    const root = await makeTempRoot();
    const cert = await loadOrCreateServerCert(root);
    expect(cert.cert).toContain("BEGIN CERTIFICATE");
    expect(cert.key).toContain("PRIVATE KEY");
    expect(cert.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it("persists cert.pem and key.pem under <dataRoot>/tls/", async () => {
    const root = await makeTempRoot();
    await loadOrCreateServerCert(root);
    const files = await fs.readdir(path.join(root, "tls"));
    expect(files.sort()).toEqual(["cert.pem", "key.pem"]);
  });

  it("writes cert and key with 0600 permissions", async () => {
    const root = await makeTempRoot();
    await loadOrCreateServerCert(root);
    const certStat = await fs.stat(path.join(root, "tls", "cert.pem"));
    const keyStat = await fs.stat(path.join(root, "tls", "key.pem"));
    expect((certStat.mode & 0o777).toString(8)).toBe("600");
    expect((keyStat.mode & 0o777).toString(8)).toBe("600");
  });

  it("returns the same cert and fingerprint on a second call (idempotent)", async () => {
    const root = await makeTempRoot();
    const first = await loadOrCreateServerCert(root);
    const second = await loadOrCreateServerCert(root);
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
    expect(second.fingerprint256).toBe(first.fingerprint256);
  });

  it("generates a different cert for a different dataRoot", async () => {
    const rootA = await makeTempRoot();
    const rootB = await makeTempRoot();
    const certA = await loadOrCreateServerCert(rootA);
    const certB = await loadOrCreateServerCert(rootB);
    expect(certA.fingerprint256).not.toBe(certB.fingerprint256);
  });

  it("reads back an existing cert on disk rather than regenerating it", async () => {
    const root = await makeTempRoot();
    const original = await loadOrCreateServerCert(root);

    // Simulate a fresh process: nothing cached, only the files on disk.
    const reloaded = await loadOrCreateServerCert(root);
    expect(reloaded.fingerprint256).toBe(original.fingerprint256);
  });
});

describe("loadOrCreateServerCert — validity period", () => {
  const yearsBetween = (from: Date, to: Date): number =>
    (to.getTime() - from.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

  it("defaults to a 2-year validity window", async () => {
    const root = await makeTempRoot();
    const { cert } = await loadOrCreateServerCert(root);
    const x509 = new X509Certificate(cert);
    expect(
      yearsBetween(new Date(x509.validFrom), new Date(x509.validTo)),
    ).toBeCloseTo(2, 1);
  });

  it("honors an explicit validityYears override", async () => {
    const root = await makeTempRoot();
    const { cert } = await loadOrCreateServerCert(root, 5);
    const x509 = new X509Certificate(cert);
    expect(
      yearsBetween(new Date(x509.validFrom), new Date(x509.validTo)),
    ).toBeCloseTo(5, 1);
  });

  it("does not change the validity of an already-persisted cert", async () => {
    const root = await makeTempRoot();
    const original = await loadOrCreateServerCert(root, 5);
    // A later call with a different validityYears is ignored — the existing
    // cert on disk is reused as-is, per loadOrCreateServerCert's own doc.
    const reloaded = await loadOrCreateServerCert(root, 1);
    expect(reloaded.cert).toBe(original.cert);
  });
});

describe("regenerateServerCert", () => {
  it("overwrites an existing cert/key with a new fingerprint", async () => {
    const root = await makeTempRoot();
    const original = await loadOrCreateServerCert(root);
    const rotated = await regenerateServerCert(root);
    expect(rotated.fingerprint256).not.toBe(original.fingerprint256);
    expect(rotated.cert).not.toBe(original.cert);
  });

  it("persists the rotated cert so a later load reuses it instead of the original", async () => {
    const root = await makeTempRoot();
    await loadOrCreateServerCert(root);
    const rotated = await regenerateServerCert(root);
    const reloaded = await loadOrCreateServerCert(root);
    expect(reloaded.fingerprint256).toBe(rotated.fingerprint256);
  });

  it("generates a cert from scratch even when none existed before", async () => {
    const root = await makeTempRoot();
    const cert = await regenerateServerCert(root);
    expect(cert.cert).toContain("BEGIN CERTIFICATE");
    const files = await fs.readdir(path.join(root, "tls"));
    expect(files.sort()).toEqual(["cert.pem", "key.pem"]);
  });

  it("writes the rotated cert and key with 0600 permissions", async () => {
    const root = await makeTempRoot();
    await loadOrCreateServerCert(root);
    await regenerateServerCert(root);
    const certStat = await fs.stat(path.join(root, "tls", "cert.pem"));
    const keyStat = await fs.stat(path.join(root, "tls", "key.pem"));
    expect((certStat.mode & 0o777).toString(8)).toBe("600");
    expect((keyStat.mode & 0o777).toString(8)).toBe("600");
  });
});

describe("certificateExpiry", () => {
  it("returns the certificate's notAfter date, ~2 years out by default", async () => {
    const root = await makeTempRoot();
    const cert = await loadOrCreateServerCert(root);
    const expiry = certificateExpiry(cert);
    const yearsUntilExpiry =
      (expiry.getTime() - Date.now()) / (365.25 * 24 * 60 * 60 * 1000);
    expect(yearsUntilExpiry).toBeCloseTo(2, 1);
  });

  it("matches the certificate's own validToDate", async () => {
    const root = await makeTempRoot();
    const cert = await loadOrCreateServerCert(root);
    const expiry = certificateExpiry(cert);
    const x509 = new X509Certificate(cert.cert);
    expect(expiry.getTime()).toBe(new Date(x509.validTo).getTime());
  });
});
