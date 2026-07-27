/**
 * Loads or generates the server's self-signed TLS certificate.
 *
 * @remarks
 * The server has no external PKI to issue a certificate from, so it
 * generates its own self-signed keypair on first run and persists it under
 * `<dataRoot>/tls/`. Clients do not validate this certificate against a CA
 * (there isn't one) — they instead pin its SHA-256 fingerprint on first
 * connect (TOFU, like an SSH host key) and refuse a changed fingerprint
 * afterward. This module only needs to produce a stable, private keypair;
 * the trust decision lives entirely on the client side.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { generate } from "selfsigned";

/** A server TLS keypair plus the SHA-256 fingerprint clients pin against. */
export type ServerCertificate = {
  /** PEM-encoded X.509 certificate. */
  cert: string;
  /** PEM-encoded private key. Never leaves the server process. */
  key: string;
  /** Colon-separated SHA-256 fingerprint of `cert`, e.g. `"AB:CD:...:12"`. */
  fingerprint256: string;
};

const TLS_DIR_NAME = "tls";
const CERT_FILE_NAME = "cert.pem";
const KEY_FILE_NAME = "key.pem";

const fingerprintOf = (certPem: string): string =>
  new X509Certificate(certPem).fingerprint256;

const tryReadExisting = async (
  certPath: string,
  keyPath: string,
): Promise<ServerCertificate | null> => {
  try {
    const [cert, key] = await Promise.all([
      fs.readFile(certPath, "utf-8"),
      fs.readFile(keyPath, "utf-8"),
    ]);
    return { cert, key, fingerprint256: fingerprintOf(cert) };
  } catch {
    return null;
  }
};

/**
 * Generates a fresh self-signed keypair and persists it to `certPath`/`keyPath`.
 *
 * @remarks
 * Unconditional — always writes, regardless of what (if anything) is already
 * on disk at those paths. Shared by {@link loadOrCreateServerCert} (only
 * called when no existing cert was found) and {@link regenerateServerCert}
 * (always called, to force a rotation).
 *
 * Certificate and key files are written with mode `0600` (owner read/write
 * only); the private key must never be group- or world-readable.
 */
const generateAndPersist = async (
  tlsDir: string,
  certPath: string,
  keyPath: string,
  validityYears: number,
): Promise<ServerCertificate> => {
  await fs.mkdir(tlsDir, { recursive: true });

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + validityYears);

  const pems = await generate(
    [{ name: "commonName", value: "loopycode-server" }],
    {
      keySize: 2048,
      algorithm: "sha256",
      notBeforeDate,
      notAfterDate,
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
            { type: 7, ip: "::1" },
          ],
        },
      ],
    },
  );

  await fs.writeFile(certPath, pems.cert, { encoding: "utf-8", mode: 0o600 });
  await fs.writeFile(keyPath, pems.private, { encoding: "utf-8", mode: 0o600 });
  // The mode option above only applies when the file is newly created;
  // chmod explicitly so a pre-existing looser-permission file is corrected.
  await fs.chmod(certPath, 0o600);
  await fs.chmod(keyPath, 0o600);

  return {
    cert: pems.cert,
    key: pems.private,
    fingerprint256: fingerprintOf(pems.cert),
  };
};

/**
 * Returns the server's TLS certificate, generating and persisting one on
 * first call.
 *
 * @remarks
 * Idempotent: subsequent calls with the same `dataRoot` return the same
 * keypair, so the fingerprint clients pinned on a previous connection stays
 * valid across server restarts. Only {@link regenerateServerCert} (or
 * deleting `<dataRoot>/tls/`) produces a new keypair — and every client that
 * pinned the old fingerprint will then correctly refuse to connect until
 * re-trusted.
 *
 * @param dataRoot - Server data directory (same root used for config, e.g.
 *   `process.cwd()`); the certificate lives under `<dataRoot>/tls/`.
 * @param validityYears - Certificate lifetime in years from generation.
 *   Defaults to 2. Only affects a NEWLY generated certificate — an existing
 *   one on disk is reused as-is regardless of this value (see `tryReadExisting`),
 *   so raising or lowering it never disturbs an already-pinned fingerprint.
 * @returns The certificate, private key, and its SHA-256 fingerprint.
 *
 * @example
 * ```ts
 * const cert = await loadOrCreateServerCert(process.cwd());
 * console.log(`Server fingerprint: ${cert.fingerprint256}`);
 * ```
 */
export const loadOrCreateServerCert = async (
  dataRoot: string,
  validityYears = 2,
): Promise<ServerCertificate> => {
  const tlsDir = path.join(dataRoot, TLS_DIR_NAME);
  const certPath = path.join(tlsDir, CERT_FILE_NAME);
  const keyPath = path.join(tlsDir, KEY_FILE_NAME);

  const existing = await tryReadExisting(certPath, keyPath);
  if (existing) {
    return existing;
  }

  return generateAndPersist(tlsDir, certPath, keyPath, validityYears);
};

/**
 * Forces a fresh TLS certificate, unconditionally overwriting any existing
 * `<dataRoot>/tls/cert.pem`/`key.pem`.
 *
 * @remarks
 * The explicit rotation path — unlike {@link loadOrCreateServerCert}, this
 * never reuses what's on disk. Every client that pinned the previous
 * fingerprint will refuse to connect until it re-trusts the new one (see
 * {@link runCertRegen}, which gates this behind an interactive confirmation
 * for exactly that reason).
 *
 * @param dataRoot - Server data directory; the certificate lives under
 *   `<dataRoot>/tls/`.
 * @param validityYears - Certificate lifetime in years from generation.
 *   Defaults to 2.
 * @returns The newly generated certificate, private key, and fingerprint.
 */
export const regenerateServerCert = async (
  dataRoot: string,
  validityYears = 2,
): Promise<ServerCertificate> => {
  const tlsDir = path.join(dataRoot, TLS_DIR_NAME);
  const certPath = path.join(tlsDir, CERT_FILE_NAME);
  const keyPath = path.join(tlsDir, KEY_FILE_NAME);

  return generateAndPersist(tlsDir, certPath, keyPath, validityYears);
};

/**
 * Returns the expiration date of a server certificate.
 *
 * @param cert - A certificate previously returned by
 *   {@link loadOrCreateServerCert} or {@link regenerateServerCert}.
 * @returns The certificate's `notAfter` date.
 */
export const certificateExpiry = (cert: ServerCertificate): Date =>
  new X509Certificate(cert.cert).validToDate;
