/**
 * macOS Seatbelt (`sandbox-exec`) backend.
 *
 * @remarks
 * Builds a per-command profile: deny-by-default, allow process/exec/mach,
 * allow file-read except the credential stores in `policy.readDenies`,
 * allow file-write only under `policy.writeRoots`, and gate network on
 * `policy.network`. `sandbox-exec` is deprecated but still ships with macOS.
 */

import type { SandboxContext, SandboxProvider } from "./types.js";
import { POSIX_EXECUTION_SHELL } from "./types.js";

const quoteSeatbeltPath = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * Builds a Seatbelt profile string enforcing `ctx.policy`.
 *
 * @param ctx - Working directory (informational here — write scope comes
 *   from `ctx.policy.writeRoots`) and the policy to enforce.
 * @returns Profile text for `sandbox-exec -p`.
 *
 * @example
 * ```ts
 * const profile = buildSeatbeltProfile({ cwd: "/proj", policy });
 * profile.includes('(deny default)'); // true
 * ```
 */
export const buildSeatbeltProfile = (ctx: SandboxContext): string => {
  const writeAllows = ctx.policy.writeRoots
    .map((entry) => `(allow file-write* (subpath "${quoteSeatbeltPath(entry)}"))`)
    .join("\n");
  const readDenies = ctx.policy.readDenies
    .map((entry) => `(deny file-read* (subpath "${quoteSeatbeltPath(entry.path)}"))`)
    .join("\n");
  const networkRule =
    ctx.policy.network === "deny" ? "(deny network*)" : "(allow network*)";

  return `(version 1)
(deny default)
(allow process*)
(allow mach*)
(allow sysctl-read)
(allow signal)
(allow file-read*)
${readDenies}
${writeAllows}
${networkRule}
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
  executionShell: POSIX_EXECUTION_SHELL,
  denialPattern: SEATBELT_DENIAL_PATTERN,
  wrapCommand: (command, ctx) => {
    const profile = buildSeatbeltProfile(ctx);
    return {
      argv: ["sandbox-exec", "-p", profile, "/bin/sh", "-c", command],
    };
  },
});
