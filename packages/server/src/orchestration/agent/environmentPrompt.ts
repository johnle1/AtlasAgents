/**
 * Builds the environment and tool-catalog blocks injected into the unified
 * agent's system prompt.
 *
 * @remarks
 * `run_command` executes on the *client's* machine (relayed over the file
 * proxy), not the server's — so the agent must be told the client's platform
 * explicitly rather than reading `process.platform` locally. Without this,
 * a model defaults to POSIX syntax and produces broken commands (`dir`,
 * `findstr`) on a Windows client.
 */

import type { ToolSchema } from "../tools/types.js";
import { schemaToPromptLine } from "../tools/promptText.js";
import type { ClientEnv } from "../types.js";

export type { ClientEnv } from "../types.js";

type ShellProfile = {
  osLabel: string;
  shellLabel: string;
  examples: string[];
};

const WINDOWS_PROFILE: ShellProfile = {
  osLabel: "Windows",
  shellLabel: "cmd.exe",
  examples: [
    "dir",
    'findstr /s /n "foo" *.ts',
    "git log --oneline -5",
    "git show <sha>",
  ],
};

const MAC_PROFILE: ShellProfile = {
  osLabel: "macOS",
  shellLabel: "/bin/zsh",
  examples: [
    "ls -la",
    'grep -rn "foo" src',
    "git log --oneline -5",
    "git show <sha>",
  ],
};

const LINUX_PROFILE: ShellProfile = {
  osLabel: "Linux",
  shellLabel: "/bin/bash",
  examples: [
    "ls -la",
    'grep -rn "foo" src',
    "git log --oneline -5",
    "git show <sha>",
  ],
};

const profileForPlatform = (platform: string | undefined): ShellProfile => {
  if (platform === "win32") {
    return WINDOWS_PROFILE;
  }
  if (platform === "darwin") {
    return MAC_PROFILE;
  }
  // Default to the POSIX/Linux profile — also covers an absent/unknown
  // platform, since POSIX syntax is the safer guess than cmd.exe.
  return LINUX_PROFILE;
};

/**
 * Builds the `[ENVIRONMENT]` prompt block describing the client's OS and
 * shell, so `run_command` calls use the right syntax.
 *
 * @param env - Client-reported platform info, or `undefined` for an older
 *   client that didn't send `clientEnv` (falls back to the Linux/POSIX profile).
 * @returns A short prompt block, ready to join into the system prompt.
 */
export const buildEnvironmentBlock = (env: ClientEnv | undefined): string => {
  const profile = profileForPlatform(env?.platform);
  const shellLabel = env?.shell?.trim() || profile.shellLabel;
  const osDetail = env?.osRelease?.trim();
  const osLine = osDetail
    ? `os: ${profile.osLabel} (${osDetail})`
    : `os: ${profile.osLabel}`;
  return [
    "[ENVIRONMENT]",
    `${osLine}   shell: ${shellLabel}`,
    "run_command executes on the user's machine — use syntax native to this shell.",
    `Examples: ${profile.examples.join(" · ")}`,
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
