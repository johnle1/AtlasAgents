/**
 * Cross-platform sandbox capability a caller may opt into for shell commands.
 *
 * @remarks
 * Sandboxing is a **capability, not a gate**. {@link "./index.js".resolveSandbox}
 * returns `null` when no backend is available; callers must fall back to
 * prompting rather than refusing to run. Platform detection happens once,
 * there — do not scatter `process.platform` checks through command handlers.
 */

/** Whether a sandboxed command may reach the network at all. */
export type NetworkPolicy = "allow" | "deny";

/**
 * One path denied for reads, with enough type information for backends
 * (like bubblewrap) whose "hide this path" primitive differs for a file vs
 * a directory.
 */
export type ReadDenyEntry = {
  /** Absolute host path. */
  path: string;
  kind: "file" | "dir";
};

/**
 * The concrete confinement a {@link SandboxProvider} must enforce for one
 * command, derived by {@link "./policy.js".buildSandboxPolicy} from the
 * workspace root and the current approval mode.
 *
 * @remarks
 * `writeRoots` and `readDenies` are defense-in-depth even for the container
 * backend, whose bind-mount boundary already makes everything outside
 * `writeRoots` invisible — cheap to also assert and keeps the three backends
 * describable by the same policy shape.
 */
export type SandboxPolicy = {
  /** Absolute paths the command may write under (workspace root, temp dirs). */
  writeRoots: string[];
  /** Absolute paths (credential stores) denied for reads. */
  readDenies: ReadDenyEntry[];
  /** `"deny"` cuts network access entirely; see `/sandbox` and `sandbox.network` config. */
  network: NetworkPolicy;
};

/** Everything a {@link SandboxProvider} needs to wrap one command. */
export type SandboxContext = {
  /** Working directory used to scope write allowances and mounts. */
  cwd: string;
  /** Confinement to enforce for this invocation. */
  policy: SandboxPolicy;
};

/** POSIX shell dialect used inside every sandbox backend. */
export const POSIX_EXECUTION_SHELL = "/bin/sh";

/** Shell dialect used for unsandboxed commands on Windows. */
export const WINDOWS_EXECUTION_SHELL = "cmd.exe";

/**
 * One OS sandbox backend.
 *
 * @remarks
 * `wrapCommand` must return an argv array (no shell-string interpolation).
 * `denialPattern` matches stderr of a command the sandbox blocked.
 */
export type SandboxProvider = {
  /** Stable id (`"seatbelt"`, `"bubblewrap"`, `"container-docker"`, …). */
  id: string;
  /**
   * Shell dialect commands run under inside this backend — always
   * {@link POSIX_EXECUTION_SHELL} today (Seatbelt/bwrap/container all
   * invoke `/bin/sh -c`).
   */
  executionShell: string;
  /**
   * Wraps `command` so the child runs inside this backend.
   *
   * @param command - Shell command line (already CWD-wrapped if applicable).
   * @param ctx - Working directory and policy to enforce.
   * @returns `{ argv }` for `spawn(argv[0], argv.slice(1))`, and an optional
   *   `env` override (the container backend runs a separate process with
   *   its own environment, so it has none to override; kept for backends
   *   that do).
   */
  wrapCommand: (
    command: string,
    ctx: SandboxContext,
  ) => { argv: string[]; env?: NodeJS.ProcessEnv };
  /** Matches sandbox-denial text in stderr. */
  denialPattern: RegExp;
};

/**
 * Optional extras for {@link "../shellRunner.js".runShell}.
 */
export type RunShellOptions = {
  /** When set, spawn through this provider instead of the bare shell. */
  sandbox?: SandboxProvider;
  /** Required alongside `sandbox` — the policy to wrap the command with. */
  policy?: SandboxPolicy;
};
