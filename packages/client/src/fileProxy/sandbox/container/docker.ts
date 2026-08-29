/**
 * Container-based sandbox backend — Docker or Podman, CLI-compatible so one
 * implementation covers both.
 *
 * @remarks
 * The only strong isolation option on Windows (no native primitive is
 * reachable from Node without a compiled addon); an opt-in stronger
 * boundary on macOS/Linux via `/sandbox container`. Unlike the OS-native
 * backends, this one doesn't need a read-deny list at all — the container
 * filesystem only contains what's explicitly bind-mounted in, so
 * `~/.ssh`, browser credential stores, etc. are never visible in the first
 * place rather than visible-but-denied.
 *
 * Requires an image built from `sandbox/Dockerfile` (default tag
 * `atlas-sandbox:latest`, overridable via the `sandbox.containerImage`
 * config field) — see that file for what's preinstalled. A missing image
 * surfaces as an ordinary failed-command stderr (`Unable to find image`),
 * same as any other command failure.
 */

import type { ContainerRuntime } from "../capability.js";
import type { SandboxProvider } from "../types.js";

export const CONTAINER_DENIAL_PATTERN =
  /permission denied|read-only file system|network is unreachable|could not resolve host/i;

/** Mount point the workspace/cwd is bound to inside the container. */
export const CONTAINER_WORKDIR = "/workspace";

/**
 * Maps each write root to a container mount point. The primary `cwd` always
 * lands at {@link CONTAINER_WORKDIR}; anything else (typically an OS temp
 * dir outside the workspace) gets its own path under `/mnt`, since a
 * container's filesystem doesn't share the host's layout.
 */
const containerMountsFor = (
  cwd: string,
  writeRoots: string[],
): { hostPath: string; containerPath: string }[] => {
  const mounts = [{ hostPath: cwd, containerPath: CONTAINER_WORKDIR }];
  let extraIndex = 0;
  for (const root of writeRoots) {
    if (root === cwd) {
      continue;
    }
    mounts.push({ hostPath: root, containerPath: `/mnt/extra-${extraIndex}` });
    extraIndex += 1;
  }
  return mounts;
};

/**
 * Creates the container {@link SandboxProvider} for `runtime`.
 *
 * @param runtime - `"docker"` or `"podman"` — same CLI surface for the flags used here.
 * @param image - Image to run the command in (see module remarks for the default).
 */
export const createContainerProvider = (
  runtime: ContainerRuntime,
  image: string,
): SandboxProvider => ({
  id: `container-${runtime}`,
  denialPattern: CONTAINER_DENIAL_PATTERN,
  wrapCommand: (command, ctx) => {
    const mounts = containerMountsFor(ctx.cwd, ctx.policy.writeRoots);
    const args: string[] = ["run", "--rm", "-i"];

    for (const mount of mounts) {
      args.push("-v", `${mount.hostPath}:${mount.containerPath}`);
    }

    args.push("-w", CONTAINER_WORKDIR);
    args.push("--network", ctx.policy.network === "deny" ? "none" : "bridge");
    args.push(image, "/bin/sh", "-c", command);

    return { argv: [runtime, ...args] };
  },
});

/** Config default for `sandbox.containerImage` — see module remarks. */
export const DEFAULT_SANDBOX_IMAGE = "atlas-sandbox:latest";
