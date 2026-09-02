/**
 * Builds the environment and tool-catalog blocks injected into the unified
 * agent's system prompt.
 *
 * @remarks
 * `run_command` executes on the *client's* machine (relayed over the file
 * proxy), not the server's — so the agent must be told the client's platform
 * explicitly rather than reading `process.platform` locally. Without this,
 * a model defaults to POSIX syntax and produces broken commands (`dir`,
 * `findstr`) on a Windows client running unsandboxed `cmd.exe`.
 *
 * Command examples follow the reported *execution shell* (`cmd.exe` vs
 * POSIX `/bin/sh`), not the host OS alone — a Windows machine using a
 * container sandbox still runs commands through `/bin/sh` inside the image.
 */

import type { ToolSchema } from "../tools/types.js";
import { schemaToPromptLine } from "../tools/promptText.js";
import type { ClientEnv } from "../types.js";

export type { ClientEnv } from "../types.js";

const WINDOWS_SHELL_LABEL = "cmd.exe";
const POSIX_EXAMPLES = [
  "ls -la",
  'grep -rn "foo" src',
  "git log --oneline -5",
  "git show <sha>",
];
const WINDOWS_EXAMPLES = [
  "dir",
  'findstr /s /n "foo" *.ts',
  "git log --oneline -5",
  "git show <sha>",
];

const osLabelForPlatform = (platform: string | undefined): string => {
  if (platform === "win32") {
    return "Windows";
  }
  if (platform === "darwin") {
    return "macOS";
  }
  return "Linux";
};

const defaultShellForPlatform = (platform: string | undefined): string => {
  if (platform === "win32") {
    return WINDOWS_SHELL_LABEL;
  }
  if (platform === "darwin") {
    return "/bin/zsh";
  }
  return "/bin/bash";
};

/** True when the reported shell is Windows `cmd.exe` (unsandboxed Windows). */
const isCmdExecutionShell = (shell: string | undefined): boolean =>
  shell?.trim().toLowerCase() === WINDOWS_SHELL_LABEL;

/**
 * Builds the `[ENVIRONMENT]` prompt block describing the client's OS and
 * shell, so `run_command` calls use the right syntax.
 *
 * @param env - Client-reported platform info, or `undefined` for an older
 *   client that didn't send `clientEnv` (falls back to the Linux/POSIX profile).
 * @returns A short prompt block, ready to join into the system prompt.
 */
export const buildEnvironmentBlock = (env: ClientEnv | undefined): string => {
  const osLabel = osLabelForPlatform(env?.platform);
  const shellLabel = env?.shell?.trim() || defaultShellForPlatform(env?.platform);
  const examples = isCmdExecutionShell(shellLabel)
    ? WINDOWS_EXAMPLES
    : POSIX_EXAMPLES;
  const osDetail = env?.osRelease?.trim();
  const osLine = osDetail
    ? `os: ${osLabel} (${osDetail})`
    : `os: ${osLabel}`;
  return [
    "[ENVIRONMENT]",
    `${osLine}   shell: ${shellLabel}`,
    "run_command executes on the user's machine — use syntax native to this shell.",
    `Examples: ${examples.join(" · ")}`,
  ].join("\n");
};

/**
 * Builds the `[AVAILABLE TOOLS]` prompt block from the live tool registry, so
 * the model always sees exactly the tools it can call — including any
 * TokenSave/MCP tools synced for this connection — described in one place.
 *
 * @remarks
 * Reuses {@link schemaToPromptLine}, the same renderer the legacy text-mode
 * tool block uses, so the description stays consistent whether or not the
 * model supports native tool calling.
 *
 * @param schemas - Tool schemas from the live registry (see `registry.ts`).
 * @returns A short prompt block listing each tool and its arguments.
 */
export const buildToolCatalogBlock = (schemas: ToolSchema[]): string =>
  [
    "[AVAILABLE TOOLS]",
    "You decide which of these to call, if any, based on what the task needs:",
    ...schemas.map(schemaToPromptLine),
  ].join("\n");
