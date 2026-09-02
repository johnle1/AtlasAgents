/**
 * Synchronous availability probes for sandbox backends.
 *
 * @remarks
 * {@link "./index.js".resolveSandbox} is a sync API — the platform/backend
 * decision must be available before the first command needs to run — so
 * these probes are sync too. The production (no-argument) call memoizes the
 * result, so a probe here runs at most once per process.
 */

import { execFileSync } from "node:child_process";

/** A container runtime whose CLI is Docker-compatible. */
export type ContainerRuntime = "docker" | "podman";

/**
 * True when `bin` resolves on `PATH`, probed via `which`/`where`.
 *
 * @remarks
 * Same probe shape as {@link "../../mcp/tokenSaveClient.js".isTokenSaveOnPath}
 * but synchronous, since {@link "./index.js".resolveSandbox} cannot be async
 * without threading a promise through every command-classification call
 * site that currently calls it synchronously.
 *
 * @param bin - Executable name to look up (no path separators).
 */
export const isBinaryOnPath = (bin: string): boolean => {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(locator, [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/**
 * Detects an available container runtime, preferring Docker over Podman
 * when both are installed (Docker Desktop is the more common default; a
 * user who only has Podman still gets a working sandbox).
 *
 * @returns `"docker"` or `"podman"`, or `null` when neither is on `PATH`.
 */
export const detectContainerRuntime = (): ContainerRuntime | null => {
  if (isBinaryOnPath("docker")) {
    return "docker";
  }
  if (isBinaryOnPath("podman")) {
    return "podman";
  }
  return null;
};
