/**
 * Cross-platform sandbox capability used by auto-mode shell commands.
 *
 * @remarks
 * Sandboxing is a **capability, not a gate**. {@link resolveSandbox} returns
 * `null` on platforms without a backend; callers must fall back to prompting
 * rather than refusing to run. Platform detection happens once, here — do not
 * scatter `process.platform` checks through command handlers.
 */

/**
 * One OS sandbox backend.
 *
 * @remarks
 * `wrapCommand` must return an argv array (no shell-string interpolation).
 * `denialPattern` matches stderr of a command the sandbox blocked.
 */
export type SandboxProvider = {
  /** Stable id (`"seatbelt"`, `"bubblewrap"`, …). */
  id: string;
  /**
   * Wraps `command` so the child runs inside this backend.
   *
   * @param command - Shell command line (already CWD-wrapped if applicable).
   * @param ctx - Working directory used to scope write allowances.
   * @returns `{ argv }` for `spawn(argv[0], argv.slice(1))`.
   */
  wrapCommand: (
    command: string,
    ctx: { cwd: string },
  ) => { argv: string[] };
  /** Matches sandbox-denial text in stderr. */
  denialPattern: RegExp;
};

/**
 * Optional extras for {@link runShell}.
 */
export type RunShellOptions = {
  /** When set, spawn through this provider instead of the bare shell. */
  sandbox?: SandboxProvider;
};
