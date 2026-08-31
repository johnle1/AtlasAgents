/**
 * Built-in `/mcp add <preset>` connection templates for common services.
 *
 * @remarks
 * Each preset is a connection shape (never a hardcoded credential) plus the
 * list of secret fields `/mcp add` should prompt for, stored into
 * `mcpSecrets[serverId]` on submission. Kept as a small, flat data table
 * specifically so updating a stale endpoint or package name later is a
 * one-line change, not a code change — these are the fastest-moving part of
 * this feature, since they track third-party services this project doesn't
 * control.
 *
 * **Verify before relying on these in production**: MCP support across
 * GitHub/Atlassian/Slack is an actively moving target. The `jira` preset in
 * particular delegates to `mcp-remote`, which handles OAuth interactively on
 * first connect rather than taking a static token.
 */

import type { McpServerConfig } from "../config/types.js";

/** One secret field a preset needs, prompted for and stored under this key in `mcpSecrets[serverId]`. */
export type McpPresetSecretField = {
  /** Key under `mcpSecrets[serverId]` this value is stored as. */
  key: string;
  /** Prompt shown to the user when collecting this value. */
  prompt: string;
  /** Hide input while typing (e.g. for tokens/passwords). */
  mask?: boolean;
};

/** One built-in `/mcp add` preset. */
export type McpPresetDefinition = {
  id: string;
  /** Display name shown in `/mcp add` output and `/mcp list`. */
  label: string;
  /** Connection shape written to `mcpServers[id]` verbatim. */
  config: McpServerConfig;
  /** Secret fields to prompt for; empty when the server handles its own auth (e.g. interactive OAuth). */
  secretFields: McpPresetSecretField[];
};

export const MCP_PRESETS: Record<string, McpPresetDefinition> = {
  github: {
    id: "github",
    label: "GitHub",
    config: {
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
    },
    secretFields: [
      {
        key: "token",
        prompt: "GitHub personal access token",
        mask: true,
      },
    ],
  },
  jira: {
    id: "jira",
    label: "Jira / Atlassian",
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/mcp/authv2"],
    },
    // mcp-remote opens a browser for OAuth on first connect — no static
    // token to collect up front.
    secretFields: [],
  },
  slack: {
    id: "slack",
    label: "Slack",
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
    },
    secretFields: [
      {
        key: "SLACK_BOT_TOKEN",
        prompt: "Slack bot token (xoxb-...)",
        mask: true,
      },
      { key: "SLACK_TEAM_ID", prompt: "Slack team/workspace ID" },
    ],
  },
};

/** True when `id` names a built-in preset. */
export const isMcpPresetId = (id: string): boolean => id in MCP_PRESETS;

/** Preset ids in display order, for `/mcp add` usage text. */
export const MCP_PRESET_IDS: readonly string[] = Object.keys(MCP_PRESETS);
