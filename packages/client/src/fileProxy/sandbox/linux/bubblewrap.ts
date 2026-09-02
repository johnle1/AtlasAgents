/**
 * Linux bubblewrap (`bwrap`) sandbox backend.
 *
 * @remarks
 * Unprivileged user-namespace sandboxing (the same primitive Flatpak builds
 * on): the whole filesystem is bind-mounted read-only, `policy.writeRoots`
 * are re-mounted read-write on top (later bind mounts win at the same
 * path), and `policy.readDenies` are hidden with an empty overlay — a
 * `tmpfs` for a directory, `/dev/null` bound over a file, since bubblewrap
 * has no direct "deny read" primitive. A fresh PID/IPC/UTS namespace and
 * `--die-with-parent` keep a sandboxed process from outliving or seeing
 * outside its invocation.
 */

import type { SandboxProvider } from "../types.js";
import { POSIX_EXECUTION_SHELL } from "../types.js";

/**
 * bubblewrap denial signatures in stderr.
 *
 * @remarks
 * `bwrap:` prefixes bubblewrap's own setup errors (e.g. a missing bind
 * source); a denied write inside the sandbox surfaces as an ordinary
 * `Read-only file system` or `Permission denied` from the failing command.
 */
export const BUBBLEWRAP_DENIAL_PATTERN =
  /^bwrap: |Read-only file system|Permission denied/i;

/**
 * Creates the Linux bubblewrap {@link SandboxProvider}.
 *
 * @returns Provider whose `wrapCommand` prefixes a `bwrap` invocation.
 */
export const createBubblewrapProvider = (): SandboxProvider => ({
  id: "bubblewrap",
  executionShell: POSIX_EXECUTION_SHELL,
  denialPattern: BUBBLEWRAP_DENIAL_PATTERN,
  wrapCommand: (command, ctx) => {
    const args: string[] = [
      "--die-with-parent",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--ro-bind",
      "/",
      "/",
    ];

    for (const root of ctx.policy.writeRoots) {
      args.push("--bind", root, root);
    }

    for (const entry of ctx.policy.readDenies) {
      if (entry.kind === "dir") {
        args.push("--tmpfs", entry.path);
      } else {
        args.push("--ro-bind", "/dev/null", entry.path);
      }
    }

    if (ctx.policy.network === "deny") {
      args.push("--unshare-net");
    }

    args.push("--chdir", ctx.cwd);
    args.push("/bin/sh", "-c", command);

    return { argv: ["bwrap", ...args] };
  },
});
