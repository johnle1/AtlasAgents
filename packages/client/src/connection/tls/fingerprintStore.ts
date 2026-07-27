/**
 * Trust-on-first-use (TOFU) storage for server TLS certificate fingerprints.
 *
 * @remarks
 * The server's certificate is self-signed, so there is no CA to validate it
 * against — trust works the way SSH host keys do: the fingerprint presented
 * on the first connection to a given `host:port` is pinned, and every later
 * connection to that same `host:port` must present the identical
 * fingerprint or be refused. This is the actual security boundary once TLS
 * negotiation runs with `rejectUnauthorized: false` (see
 * {@link createTlsClientTransport}) — get this wrong and self-signed TLS is
 * no safer than plaintext.
 */

import { loadConfig, setConfig } from "../../config/index.js";

/** Outcome of checking a freshly-seen certificate fingerprint against the pin store. */
export type FingerprintDecision =
  | { trust: true; firstConnection: boolean }
  | { trust: false; pinnedFingerprint: string };

/** Builds the `serverFingerprints` lookup key for a given host/port pair. */
export const fingerprintKey = (host: string, port: number): string =>
  `${host}:${port}`;

/**
 * Checks a server's certificate fingerprint against the pinned value for
 * `host:port`, pinning it if this is the first connection ever made there.
 *
 * @remarks
 * Never overwrites an existing pin — a changed fingerprint for a
 * `host:port` that already has one is always a mismatch, never silently
 * re-pinned. To trust a legitimate certificate rotation, the pin must be
 * cleared first (see {@link clearFingerprint}).
 *
 * @param host - Server hostname/IP as configured (`Config.server`).
 * @param port - Server port as configured (`Config.port`).
 * @param fingerprint256 - The SHA-256 fingerprint just presented by the peer
 *   (e.g. `socket.getPeerCertificate().fingerprint256`).
 * @returns `{ trust: true }` when this is the first connection (now pinned)
 *   or matches the existing pin; `{ trust: false, pinnedFingerprint }` when
 *   it differs from what was previously pinned.
 */
export const checkAndPinFingerprint = (
  host: string,
  port: number,
  fingerprint256: string,
): FingerprintDecision => {
  const key = fingerprintKey(host, port);
  const config = loadConfig();
  const pinned = config.serverFingerprints[key];

  if (pinned === undefined) {
    setConfig("serverFingerprints", { ...config.serverFingerprints, [key]: fingerprint256 });
    return { trust: true, firstConnection: true };
  }

  if (pinned === fingerprint256) {
    return { trust: true, firstConnection: false };
  }

  return { trust: false, pinnedFingerprint: pinned };
};

/**
 * Removes a pinned fingerprint so the next connection to `host:port` is
 * trusted on first use again.
 *
 * @remarks
 * The deliberate escape hatch for a legitimate certificate rotation (e.g.
 * the operator regenerated `<dataRoot>/tls/`). Exposed via a `/trust reset`
 * style command rather than any automatic path — trust decisions should
 * never be silently made on the user's behalf.
 *
 * @param host - Server hostname/IP.
 * @param port - Server port.
 * @returns `true` if a pin existed and was removed, `false` if there was
 *   nothing pinned for that `host:port`.
 */
export const clearFingerprint = (host: string, port: number): boolean => {
  const key = fingerprintKey(host, port);
  const config = loadConfig();
  if (!(key in config.serverFingerprints)) {
    return false;
  }
  const { [key]: _removed, ...rest } = config.serverFingerprints;
  setConfig("serverFingerprints", rest);
  return true;
};
