/**
 * Unit tests — server TLS certificate rotation (`loopy-server --regen-cert`)
 * and the startup expiration check that points admins at it.
 *
 * @remarks
 * The properties that matter: rotation never happens without an explicit
 * "yes" from the confirmation prompt, and `describeCertExpiry` classifies
 * dates correctly at and around the warning boundary — since a wrong
 * boundary would either nag admins early or silently stop warning right
 * before a certificate actually expires.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadOrCreateServerCert } from "../../../../packages/server/src/server/tls/certificateStore.js";
import {
  CERT_EXPIRY_WARNING_DAYS,
  describeCertExpiry,
  runCertRegen,
} from "../../../../packages/server/src/server/tls/certRegen.js";

const tempRoots: string[] = [];

const makeTempRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-cert-regen-test-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("describeCertExpiry", () => {
  const daysFromNow = (now: Date, days: number): Date =>
    new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  it("reports 'expired' once the expiry date is in the past", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const result = describeCertExpiry(daysFromNow(now, -1), now);
    expect(result.status).toBe("expired");
    expect(result.daysRemaining).toBeLessThanOrEqual(0);
  });

  it("reports 'expired' at the exact expiry instant", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const result = describeCertExpiry(now, now);
    expect(result.status).toBe("expired");
  });

  it("reports 'warning' inside the warning window", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const result = describeCertExpiry(
      daysFromNow(now, CERT_EXPIRY_WARNING_DAYS - 1),
      now,
    );
    expect(result.status).toBe("warning");
    expect(result.daysRemaining).toBeGreaterThan(0);
  });

  it("reports 'warning' exactly at the boundary", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const result = describeCertExpiry(
      daysFromNow(now, CERT_EXPIRY_WARNING_DAYS),
      now,
    );
    expect(result.status).toBe("warning");
  });

  it("reports 'ok' just outside the warning window", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const result = describeCertExpiry(
      daysFromNow(now, CERT_EXPIRY_WARNING_DAYS + 1),
      now,
    );
    expect(result.status).toBe("ok");
  });

  it("reports 'ok' far in the future", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const result = describeCertExpiry(daysFromNow(now, 700), now);
    expect(result.status).toBe("ok");
  });
});

describe("runCertRegen", () => {
  it("does not regenerate the certificate when the user declines", async () => {
    const root = await makeTempRoot();
    const original = await loadOrCreateServerCert(root);

    await runCertRegen(root, async () => false);

    const reloaded = await loadOrCreateServerCert(root);
    expect(reloaded.fingerprint256).toBe(original.fingerprint256);
    expect(reloaded.cert).toBe(original.cert);
  });

  it("regenerates the certificate when the user confirms", async () => {
    const root = await makeTempRoot();
    const original = await loadOrCreateServerCert(root);

    await runCertRegen(root, async () => true);

    const reloaded = await loadOrCreateServerCert(root);
    expect(reloaded.fingerprint256).not.toBe(original.fingerprint256);
  });

  it("generates a fresh certificate on first use even with nothing on disk yet", async () => {
    const root = await makeTempRoot();

    await runCertRegen(root, async () => true);

    const files = await fs.readdir(path.join(root, "tls"));
    expect(files.sort()).toEqual(["cert.pem", "key.pem"]);
  });

  it("asks for confirmation exactly once per run", async () => {
    const root = await makeTempRoot();
    let callCount = 0;

    await runCertRegen(root, async () => {
      callCount += 1;
      return true;
    });

    expect(callCount).toBe(1);
  });
});
