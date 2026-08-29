/**
 * Sandbox backend resolution and denial detection.
 *
 * @remarks
 * Picks, per platform, the strongest backend actually available: Seatbelt
 * on macOS, bubblewrap on Linux, falling back to a container runtime
 * (Docker/Podman) on any platform when the OS-native backend is missing —
 * and always on Windows, which has no OS-native backend reachable from
 * Node. Returns `null` when nothing is available so callers degrade to
 * prompting rather than hard-failing.
 */

import { existsSync } from "node:fs";

import {
  detectContainerRuntime,
  isBinaryOnPath,
  type ContainerRuntime,
} from "./capability.js";
import { createContainerProvider, DEFAULT_SANDBOX_IMAGE } from "./container/docker.js";
import { createBubblewrapProvider } from "./linux/bubblewrap.js";
import { createSeatbeltProvider } from "./seatbelt.js";
import type { SandboxProvider } from "./types.js";
import type { ShellResult } from "../types.js";

export type {
  NetworkPolicy,
  ReadDenyEntry,
  SandboxContext,
  SandboxPolicy,
  SandboxProvider,
  RunShellOptions,
} from "./types.js";
export { buildSandboxPolicy, type SandboxPolicyInput } from "./policy.js";
export { DEFAULT_SANDBOX_IMAGE } from "./container/docker.js";
export type { ContainerRuntime } from "./capability.js";

/**
 * `/sandbox` mode, persisted in config (`sandbox.mode`).
 *
 * @remarks
 * `"auto"` picks the strongest available backend per-platform (see module
 * remarks). `"container"` forces the container backend even where an
 * OS-native one exists (a stronger boundary at the cost of image build/pull
 * and per-command startup latency). `"off"` disables sandboxing entirely —
 * commands run unconfined, same as today's default; this is a deliberate
 * escape hatch, not a fallback callers reach automatically.
 */
export type SandboxMode = "auto" | "container" | "off";

const SANDBOX_MODES: readonly SandboxMode[] = ["auto", "container", "off"];

/** True when `value` is a valid {@link SandboxMode} string. */
export const isSandboxMode = (value: unknown): value is SandboxMode =>
  typeof value === "string" &&
  (SANDBOX_MODES as readonly string[]).includes(value);

let cached: SandboxProvider | null | undefined;

/**
 * Options for {@link resolveSandbox} (tests inject platform / availability).
 *
 * @remarks
 * When any field is passed, capability flags left unset default to
 * "unavailable" rather than probing the real machine — a test overriding
 * only `platform` must not get a different answer depending on what happens
 * to be installed on whatever machine runs the suite. Only the true
 * no-argument production call probes for real.
 */
export type ResolveSandboxOptions = {
  /** Override `process.platform`. */
  platform?: NodeJS.Platform;
  /** `/sandbox` mode; defaults to `"auto"`. */
  mode?: SandboxMode;
  /** Override the seatbelt binary probe. */
  seatbeltAvailable?: boolean;
  /** Override the bubblewrap binary probe. */
  bubblewrapAvailable?: boolean;
  /** Override container runtime detection (`null` = none installed). */
  containerRuntime?: ContainerRuntime | null;
  /** Image tag for the container backend; defaults to {@link DEFAULT_SANDBOX_IMAGE}. */
  containerImage?: string;
  /**
   * Internal — set by {@link resolveConfiguredSandbox} to request real
   * capability probing even though `mode`/`containerImage` are also being
   * passed explicitly. Without this, passing *any* options object (the
   * shape a customized user config produces) would default every
   * unspecified capability flag to "unavailable" — correct for tests, which
   * want determinism, but wrong for real config values, which need the
   * actual machine probed. Not meant to be set by callers other than that
   * function.
   */
  probeReal?: boolean;
};

/**
 * Returns the sandbox backend for this machine and mode, or `null` if none
 * is available (or `mode` is `"off"`).
 *
 * @remarks
 * The no-argument production path is memoized. Passing `options` bypasses
 * the cache so unit tests can exercise every platform/mode combination
 * without resetting process state.
 *
 * @param options - Optional platform / mode / availability overrides for tests.
 * @returns A provider, or `null` when sandboxing is unavailable or disabled.
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

  const isProductionProbe = options === undefined || options.probeReal === true;
  const platform = options?.platform ?? process.platform;
  const mode = options?.mode ?? "auto";
  const image = options?.containerImage ?? DEFAULT_SANDBOX_IMAGE;

  const result = ((): SandboxProvider | null => {
    if (mode === "off") {
      return null;
    }

    const containerRuntime =
      options?.containerRuntime !== undefined
        ? options.containerRuntime
        : isProductionProbe
          ? detectContainerRuntime()
          : null;

    if (mode === "container") {
      return containerRuntime
        ? createContainerProvider(containerRuntime, image)
        : null;
    }

    if (platform === "darwin") {
      const seatbeltOk =
        options?.seatbeltAvailable ??
        (isProductionProbe && existsSync("/usr/bin/sandbox-exec"));
      if (seatbeltOk) {
        return createSeatbeltProvider();
      }
    } else if (platform === "linux") {
      const bubblewrapOk =
        options?.bubblewrapAvailable ??
        (isProductionProbe && isBinaryOnPath("bwrap"));
      if (bubblewrapOk) {
        return createBubblewrapProvider();
      }
    }

    // No OS-native backend on this platform (or it's unavailable) — a
    // container runtime is the only remaining option, and the only option
    // at all on Windows.
    return containerRuntime
      ? createContainerProvider(containerRuntime, image)
      : null;
  })();

  if (!options) {
    cached = result;
  }
  return result;
};

let configuredCacheKey: string | undefined;
let configuredCacheResult: SandboxProvider | null | undefined;

/**
 * Resolves the sandbox for the user's persisted `sandbox.mode` /
 * `sandbox.containerImage` config, memoized per distinct `(mode, image)`
 * pair for the life of the process.
 *
 * @remarks
 * `resolveSandbox` itself takes no config — capability probing (`which
 * bwrap`, `which docker`, …) is a synchronous child-process spawn, so
 * re-running it on every single command would add real per-command latency.
 * This wraps it with a small config-keyed cache instead of probing fresh
 * each call; {@link resetSandboxCache} clears it so `/sandbox <mode>` takes
 * effect immediately rather than waiting for a process restart.
 *
 * @param mode - The user's configured `sandbox.mode`.
 * @param containerImage - The user's configured `sandbox.containerImage`.
 */
export const resolveConfiguredSandbox = (
  mode: SandboxMode,
  containerImage: string,
): SandboxProvider | null => {
  const key = `${mode}::${containerImage}`;
  if (configuredCacheKey === key && configuredCacheResult !== undefined) {
    return configuredCacheResult;
  }
  const result =
    mode === "auto" && containerImage === DEFAULT_SANDBOX_IMAGE
      ? resolveSandbox()
      : resolveSandbox({ mode, containerImage, probeReal: true });
  configuredCacheKey = key;
  configuredCacheResult = result;
  return result;
};

/**
 * Clears both the no-argument production cache and the config-keyed
 * {@link resolveConfiguredSandbox} cache.
 *
 * @remarks
 * Tests call this to exercise every platform without resetting process
 * state; `/sandbox <mode>` calls it in production so a mode change takes
 * effect on the very next command rather than requiring a restart.
 */
export const resetSandboxCache = (): void => {
  cached = undefined;
  configuredCacheKey = undefined;
  configuredCacheResult = undefined;
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
