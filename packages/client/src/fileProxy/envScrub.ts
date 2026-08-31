/**
 * Strips credential-shaped environment variables before a shell command spawns.
 *
 * @remarks
 * `command.run` previously passed no `env` to `spawn`, so a child inherited
 * every variable in the CLI process's own environment — including whatever
 * API keys or cloud credentials the user happened to have exported in the
 * shell they launched `atlas` from. This is independent of, and applies
 * regardless of, whether an OS sandbox backend is active — most users start
 * with none available (no bubblewrap/Docker installed), so this is the one
 * mitigation that reaches all of them. A name-pattern denylist is used
 * rather than an allowlist: dev toolchains rely on an open-ended set of
 * legitimate variables (`GOPATH`, `CARGO_HOME`, `HTTP_PROXY`, `NVM_DIR`,
 * git identity, …) that no fixed allowlist could enumerate without
 * constantly breaking someone's setup.
 */

/**
 * Variable name shapes treated as credential-carrying and stripped.
 *
 * @remarks
 * Matches common suffixes/infixes used for API keys, tokens, passwords, and
 * credential bundles (`GITHUB_TOKEN`, `OPENAI_API_KEY`, `DATABASE_PASSWORD`,
 * `AWS_SECRET_ACCESS_KEY`, …). Heuristic, not exhaustive — defense in depth
 * alongside the sandbox's own file-read denies, not the only safeguard.
 */
const SENSITIVE_ENV_NAME_PATTERN =
  /token|secret|password|passwd|credential|api[-_]?key|private[-_]?key/i;

/**
 * Variable names that match {@link SENSITIVE_ENV_NAME_PATTERN} but are not
 * themselves secrets — the value they hold is a socket path or a terminal
 * device, not credential material — so stripping them would break normal
 * `ssh`/`git`/`gpg` operation for no security benefit.
 */
const ENV_SCRUB_EXCEPTIONS = new Set([
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
  "GPG_TTY",
]);

/**
 * Returns a copy of `env` with every credential-shaped variable removed.
 *
 * @param env - Defaults to `process.env`.
 * @returns A new object safe to pass as `spawn`'s `env` option.
 *
 * @example
 * ```ts
 * scrubEnv({ PATH: "/usr/bin", GITHUB_TOKEN: "ghp_xxx" });
 * // { PATH: "/usr/bin" }
 * ```
 */
export const scrubEnv = (
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (
      ENV_SCRUB_EXCEPTIONS.has(key) ||
      !SENSITIVE_ENV_NAME_PATTERN.test(key)
    ) {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
};
