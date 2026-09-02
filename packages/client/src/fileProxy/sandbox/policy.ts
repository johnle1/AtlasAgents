/**
 * Derives the {@link SandboxPolicy} enforced for one command.
 *
 * @remarks
 * Two inputs decide the policy: the working directory (scopes writes) and
 * the network mode (deny-by-default in `auto` approval mode, allow
 * otherwise — see `commandHandlers.ts`). The credential-store deny list is
 * shared by every backend so the boundary doesn't quietly narrow depending
 * on which OS resolved it.
 */

import * as os from "node:os";
import * as path from "node:path";

import type { NetworkPolicy, ReadDenyEntry, SandboxPolicy } from "./types.js";

/**
 * Credential stores denied for reads, relative to the home directory.
 *
 * @remarks
 * Broader than just SSH/cloud keys — `.npmrc`/`.netrc`/`.git-credentials`
 * commonly hold registry or host tokens in plaintext, and `.config/gh` /
 * `.config/gcloud` / `.kube` / `.docker` hold CLI-managed credentials or
 * kubeconfig files with embedded tokens. This list is read-only defense in
 * depth — it does not need to be exhaustive to be worth enforcing, since
 * the write-confinement and network-deny axes are the primary boundary.
 */
const HOME_RELATIVE_READ_DENIES: ReadDenyEntry[] = [
  { path: ".ssh", kind: "dir" },
  { path: ".aws", kind: "dir" },
  { path: ".gnupg", kind: "dir" },
  { path: ".azure", kind: "dir" },
  { path: path.join(".config", "gh"), kind: "dir" },
  { path: path.join(".config", "gcloud"), kind: "dir" },
  { path: ".kube", kind: "dir" },
  { path: ".docker", kind: "dir" },
  { path: ".npmrc", kind: "file" },
  { path: ".netrc", kind: "file" },
  { path: ".git-credentials", kind: "file" },
];

/** macOS-only: the system credential store backing Keychain Access. */
const DARWIN_ONLY_READ_DENIES: ReadDenyEntry[] = [
  { path: path.join("Library", "Keychains"), kind: "dir" },
];

/**
 * Builds the full, absolute read-deny list for `platform`.
 *
 * @param platform - Defaults to `process.platform`; overridable for tests.
 */
export const buildReadDenies = (
  platform: NodeJS.Platform = process.platform,
): ReadDenyEntry[] => {
  const home = os.homedir();
  const entries =
    platform === "darwin"
      ? [...HOME_RELATIVE_READ_DENIES, ...DARWIN_ONLY_READ_DENIES]
      : HOME_RELATIVE_READ_DENIES;
  return entries.map((entry) => ({
    path: path.join(home, entry.path),
    kind: entry.kind,
  }));
};

/** Input to {@link buildSandboxPolicy}. */
export type SandboxPolicyInput = {
  /** Working directory the command will run in. */
  cwd: string;
  /** `"deny"` in `auto` approval mode; `"allow"` when a human reviews each command. */
  network: NetworkPolicy;
  /** Defaults to `process.platform`; overridable for tests. */
  platform?: NodeJS.Platform;
};

/**
 * Derives the {@link SandboxPolicy} for one command execution.
 *
 * @remarks
 * `writeRoots` is `cwd` plus the OS temp directory (and `$TMPDIR` when it
 * differs) — mirrors what the Seatbelt profile always allowed, now shared
 * by every backend rather than duplicated per-provider.
 *
 * @example
 * ```ts
 * buildSandboxPolicy({ cwd: "/proj", network: "deny" });
 * ```
 */
export const buildSandboxPolicy = (
  input: SandboxPolicyInput,
): SandboxPolicy => {
  const cwd = path.resolve(input.cwd);
  const tmp = os.tmpdir();
  const envTmp = process.env.TMPDIR
    ? path.resolve(process.env.TMPDIR)
    : null;
  const writeRoots = [cwd, tmp, envTmp].filter(
    (entry): entry is string => Boolean(entry),
  );

  return {
    writeRoots,
    readDenies: buildReadDenies(input.platform),
    network: input.network,
  };
};
