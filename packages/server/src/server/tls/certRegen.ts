/**
 * Interactive TLS certificate rotation (`atlas-server --regen-cert`) and the
 * startup expiration check that points admins at it.
 *
 * @remarks
 * Rotating the certificate changes the server's identity: every client that
 * TOFU-pinned the previous fingerprint (see the client's
 * `checkAndPinFingerprint`) will refuse to connect until it re-trusts the new
 * one. That consequence is real enough that rotation is never automatic —
 * this module always asks for confirmation first, and startup only ever
 * warns or refuses on an expired certificate, never regenerates on its own.
 */

import * as readline from "node:readline";
import {
  regenerateServerCert,
  type ServerCertificate,
} from "./certificateStore.js";

/** Days before expiry at which startup starts warning. */
export const CERT_EXPIRY_WARNING_DAYS = 30;

/** Result of comparing a certificate's expiry date against now. */
export type CertExpiryDescription = {
  status: "expired" | "warning" | "ok";
  /** Days remaining until expiry; negative once already expired. */
  daysRemaining: number;
};

/**
 * Classifies a certificate's expiry date relative to `now`.
 *
 * @param expiry - The certificate's `notAfter` date (see `certificateExpiry`).
 * @param now - Reference time; defaults to the current time.
 * @returns `"expired"` once past `expiry`, `"warning"` within
 *   {@link CERT_EXPIRY_WARNING_DAYS} of it, otherwise `"ok"`.
 */
export const describeCertExpiry = (
  expiry: Date,
  now: Date = new Date(),
): CertExpiryDescription => {
  const daysRemaining = Math.ceil(
    (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (daysRemaining <= 0) {
    return { status: "expired", daysRemaining };
  }
  if (daysRemaining <= CERT_EXPIRY_WARNING_DAYS) {
    return { status: "warning", daysRemaining };
  }
  return { status: "ok", daysRemaining };
};

/**
 * Prompts a yes/no question on the terminal, defaulting to "no".
 *
 * @param question - The question to print, e.g. `"Continue? (y/N) "`.
 * @returns true only for an explicit `y`/`yes` (case-insensitive) answer.
 */
const readConfirmation = (question: string): Promise<boolean> => {
  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    readlineInterface.question(question, (answer) => {
      readlineInterface.close();
      resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
    });
  });
};

/**
 * Runs the `--regen-cert` flow: warn, confirm, rotate, report the new
 * fingerprint.
 *
 * @remarks
 * Never regenerates without an explicit "yes" — declining leaves the
 * existing certificate (and every client's pinned fingerprint for it)
 * untouched. Does not call `process.exit`; the caller decides the exit code.
 *
 * @param dataRoot - Server data directory passed through to
 *   {@link regenerateServerCert}.
 * @param promptConfirm - Injected confirmation prompt, for testability.
 *   Defaults to the interactive terminal prompt.
 */
export const runCertRegen = async (
  dataRoot: string,
  promptConfirm: (question: string) => Promise<boolean> = readConfirmation,
): Promise<void> => {
  console.log("Regenerating TLS certificate...\n");
  console.log("WARNING:");
  console.log("This changes the server identity.\n");
  console.log(
    "Existing clients that pinned the previous fingerprint\n" +
      "will reject future connections until re-trusted.\n",
  );

  const confirmed = await promptConfirm("Continue? (y/N) ");
  if (!confirmed) {
    console.log("\nAborted — certificate unchanged.");
    return;
  }

  const cert: ServerCertificate = await regenerateServerCert(dataRoot);

  console.log("\n✓ New TLS certificate generated.\n");
  console.log("Fingerprint (SHA-256):");
  console.log(cert.fingerprint256);
  console.log(
    "\nTell your clients to trust this fingerprint — e.g. run " +
      "`atlas --trust-fingerprint` on each client, then verify the " +
      "fingerprint printed on its next connection matches the one above.",
  );
};
