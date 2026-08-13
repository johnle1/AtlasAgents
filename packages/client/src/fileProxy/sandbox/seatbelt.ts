/**
 * macOS Seatbelt (`sandbox-exec`) backend.
 *
 * @remarks
 * Builds a per-command profile: deny-by-default, allow process/exec/mach,
 * allow file-read except `~/.ssh` / `~/.aws` / `~/.gnupg`, allow file-write
 * under cwd and temp dirs. Network is allowed in v1 (policy is a later
 * shared feature). `sandbox-exec` is deprecated but still ships with macOS.
 */

import * as os from "node:os";
import * as path from "node:path";

import type { SandboxProvider } from "./types.js";

const quoteSeatbeltPath = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * Builds a Seatbelt profile string scoped to `cwd`.
 *
 * @param input - Working directory used as the write allow-subpath.
 * @returns Profile text for `sandbox-exec -p`.
 *
 * @example
 * ```ts
 * const profile = buildSeatbeltProfile({ cwd: "/proj" });
 * profile.includes('(deny default)'); // true
 * ```
 */
export const buildSeatbeltProfile = (input: { cwd: string }): string => {
  const cwd = quoteSeatbeltPath(path.resolve(input.cwd));
  const tmp = quoteSeatbeltPath(os.tmpdir());
  const envTmp = process.env.TMPDIR
    ? quoteSeatbeltPath(path.resolve(process.env.TMPDIR))
    : null;
  const home = os.homedir();
  const denyRead = [".ssh", ".aws", ".gnupg"].map((suffix) =>
    quoteSeatbeltPath(path.join(home, suffix)),
  );

  const writePaths = [cwd, tmp, envTmp].filter(
    (entry): entry is string => Boolean(entry),
  );
  const writeAllows = writePaths
    .map((entry) => `(allow file-write* (subpath "${entry}"))`)
    .join("\n");
  const readDenies = denyRead
    .map((entry) => `(deny file-read* (subpath "${entry}"))`)
    .join("\n");

  return `(version 1)
(deny default)
(allow process*)
(allow mach*)
(allow sysctl-read)
(allow signal)
(allow file-read*)
${readDenies}
${writeAllows}
(allow network*)
`;
};

/**
 * Seatbelt denial signatures in stderr.
 *
 * @remarks
 * `sandbox-exec` prints `sandbox deny …`; some operations surface
 * `Operation not permitted` instead.
 */
export const SEATBELT_DENIAL_PATTERN = /sandbox deny|Operation not permitted/i;

/**
 * Creates the macOS Seatbelt {@link SandboxProvider}.
 *
 * @returns Provider whose `wrapCommand` prefixes `sandbox-exec -p <profile>`.
 */
export const createSeatbeltProvider = (): SandboxProvider => ({
  id: "seatbelt",
  denialPattern: SEATBELT_DENIAL_PATTERN,
  wrapCommand: (command, ctx) => {
    const profile = buildSeatbeltProfile({ cwd: ctx.cwd });
    return {
      argv: ["sandbox-exec", "-p", profile, "/bin/sh", "-c", command],
    };
  },
});
