/**
 * Sandbox capability probe and denial detection.
 *
 * @remarks
 * v1 ships a macOS Seatbelt backend. Linux bubblewrap and Windows are
 * follow-ups — this module returns `null` there so auto mode degrades to
 * prompting instead of hard-failing.
 */

import { existsSync } from "node:fs";

import { createSeatbeltProvider } from "./seatbelt.js";
import type { SandboxProvider } from "./types.js";
import type { ShellResult } from "../types.js";

export type { SandboxProvider, RunShellOptions } from "./types.js";

let cached: SandboxProvider | null | undefined;

/**
 * Options for {@link resolveSandbox} (tests inject platform / availability).
 */
export type ResolveSandboxOptions = {
  /** Override `process.platform`. */
  platform?: NodeJS.Platform;
  /** Override the seatbelt binary probe. */
  seatbeltAvailable?: boolean;
};

/**
 * Returns the sandbox backend for this machine, or `null` if none.
 *
 * @remarks
 * The no-argument production path is memoized. Passing `options` bypasses
 * the cache so unit tests can exercise every platform without resetting
 * process state.
 *
 * @param options - Optional platform / availability overrides for tests.
 * @returns A provider, or `null` when sandboxing is unavailable.
 *
 * @example
 * ```ts
 * const sandbox = resolveSandbox();
 * if (!sandbox) {
 *   // prompt instead of containing
 * }
 * ```
 */
export const resolveSandbox = (
  options?: ResolveSandboxOptions,
): SandboxProvider | null => {
  if (!options && cached !== undefined) {
    return cached;
  }
  const platform = options?.platform ?? process.platform;
  const seatbeltOk =
    options?.seatbeltAvailable ??
    (platform === "darwin" && existsSync("/usr/bin/sandbox-exec"));
  const result =
    platform === "darwin" && seatbeltOk ? createSeatbeltProvider() : null;
  if (!options) {
    cached = result;
  }
  return result;
};

/**
 * Clears the memoized {@link resolveSandbox} result (tests only).
 */
export const resetSandboxCache = (): void => {
  cached = undefined;
};

/**
 * True when `result` looks like a sandbox denial rather than a normal
 * non-zero exit.
 *
 * @param provider - Backend whose `denialPattern` to apply.
 * @param result - Captured shell result.
 * @returns `false` on exit 0, even if stderr happens to match.
 *
 * @example
 * ```ts
 * detectSandboxDenial(provider, { exitCode: 1, stderr: "sandbox deny", stdout: "" });
 * // true
 * ```
 */
export const detectSandboxDenial = (
  provider: SandboxProvider,
  result: Pick<ShellResult, "exitCode" | "stderr">,
): boolean => {
  if (result.exitCode === 0) {
    return false;
  }
  return provider.denialPattern.test(result.stderr);
};
