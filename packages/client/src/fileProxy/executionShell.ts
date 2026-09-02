/**
 * Reports which shell dialect `run_command` actually executes under.
 *
 * @remarks
 * Unsandboxed commands use `cmd.exe` on Windows and `/bin/sh` elsewhere
 * (see `shellRunner.ts`). Every sandbox backend wraps commands in `/bin/sh`
 * — including container sandboxes on Windows — so the agent must not infer
 * `cmd.exe` from `process.platform` when a sandbox is active.
 */

import { loadConfig } from "../config/index.js";
import {
  POSIX_EXECUTION_SHELL,
  resolveConfiguredSandbox,
  WINDOWS_EXECUTION_SHELL,
  type SandboxProvider,
} from "./sandbox/index.js";

/** POSIX shell used by unsandboxed Linux/macOS runs and all sandbox backends. */
export { POSIX_EXECUTION_SHELL, WINDOWS_EXECUTION_SHELL } from "./sandbox/types.js";

/**
 * Returns the shell label to report for a resolved sandbox backend, or for
 * direct (unsandboxed) execution when `provider` is `null`.
 */
export const executionShellForProvider = (
  provider: SandboxProvider | null,
): string =>
  provider ? provider.executionShell : process.platform === "win32"
    ? WINDOWS_EXECUTION_SHELL
    : POSIX_EXECUTION_SHELL;

/**
 * Resolves the shell dialect the next `run_command` will use, matching the
 * same sandbox config path as `commandHandlers.ts`.
 */
export const resolveClientExecutionShell = (): string => {
  try {
    const { mode, containerImage } = loadConfig().sandbox;
    return executionShellForProvider(
      resolveConfiguredSandbox(mode, containerImage),
    );
  } catch {
    return executionShellForProvider(null);
  }
};

/** Default shell when config cannot be read — same as unsandboxed fallback. */
export const defaultClientExecutionShell = (): string =>
  executionShellForProvider(null);
