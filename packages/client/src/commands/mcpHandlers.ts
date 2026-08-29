/**
 * Generic MCP server management slash command: `/mcp`.
 *
 * @remarks
 * Manages every MCP server *except* TokenSave, which predates this generic
 * config surface and keeps its own dedicated `/tokensave init|status`
 * command — see `tokenSaveHandlers.ts`. `/mcp list` still shows TokenSave
 * (read-only, informational) alongside configured servers so `/mcp` remains
 * the one place to see everything connected.
 */

import type { Connection } from "../connection/index.js";
import type { LocalFileProxy } from "../localFileProxy.js";
import type { PromptPort } from "../ui/promptPort.js";
import { loadConfig, updateConfig } from "../config/index.js";
import type { McpServerConfig } from "../config/types.js";
import { isMcpPresetId, MCP_PRESETS } from "../mcp/mcpPresets.js";
import {
  disconnectMcpClient,
  listMcpTools,
  namespaceToolName,
} from "../mcp/mcpRegistry.js";
import { isTokenSaveOnPath } from "../mcp/tokenSaveClient.js";
import { syncAllMcpTools } from "./tokenSaveHandlers.js";
import { printError, printLine, printSuccess } from "../renderer.js";
import { formatErrorMessage } from "./utils.js";

const USAGE =
  "Usage: /mcp list | add <github|jira|slack|name> [--command <cmd> [--args a,b] | --url <url>] [--readonly] | remove <name> | enable <name> | disable <name> | tools [name] | check <name>";

/** Parses `/mcp add <name> --command <cmd> [--args a,b] | --url <url> [--readonly]`. */
const parseCustomAdd = (argument: string): { name: string; config: McpServerConfig } | null => {
  const tokens = argument.trim().split(/\s+/).filter(Boolean);
  const name = tokens[0];
  if (!name) {
    return null;
  }

  let command: string | undefined;
  let url: string | undefined;
  let argsCsv: string | undefined;
  let readOnly = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--command" && tokens[i + 1]) {
      command = tokens[++i];
    } else if (token === "--url" && tokens[i + 1]) {
      url = tokens[++i];
    } else if (token === "--args" && tokens[i + 1]) {
      argsCsv = tokens[++i];
    } else if (token === "--readonly") {
      readOnly = true;
    }
  }

  const readOnlyField = readOnly ? { readOnly: true as const } : {};
  if (command) {
    return {
      name,
      config: {
        transport: "stdio",
        command,
        args: argsCsv ? argsCsv.split(",").map((a) => a.trim()) : [],
        ...readOnlyField,
      },
    };
  }
  if (url) {
    return { name, config: { transport: "http", url, ...readOnlyField } };
  }
  return null;
};

const describeServerConfig = (config: McpServerConfig): string =>
  config.transport === "stdio"
    ? `stdio: ${config.command}${config.args?.length ? ` ${config.args.join(" ")}` : ""}`
    : `http: ${config.url}`;

/** Adds a built-in preset, prompting for each secret field it needs. */
const addPreset = async (
  presetId: string,
  prompts: PromptPort,
  conn: Connection,
  workspaceRoot: string,
): Promise<void> => {
  const preset = MCP_PRESETS[presetId];
  if (!preset) {
    return;
  }

  const secrets: Record<string, string> = {};
  for (const field of preset.secretFields) {
    secrets[field.key] = await prompts.question(`${field.prompt}: `, {
      masked: field.mask,
    });
  }

  const config = loadConfig();
  updateConfig({
    mcpServers: { ...config.mcpServers, [preset.id]: preset.config },
    mcpSecrets: { ...config.mcpSecrets, [preset.id]: secrets },
  });
  printSuccess(`Added MCP server "${preset.id}" (${preset.label}).`);

  const synced = await syncAllMcpTools(conn, workspaceRoot);
  if (synced > 0) {
    printSuccess(`Synced ${synced} tool(s) to server.`);
  }
};

/**
 * Routes `/mcp list | add | remove | enable | disable | tools | check`.
 *
 * @param sub - Subcommand after `/mcp`.
 * @param argument - Remaining raw argument text.
 * @param conn - Live RSocket connection, for syncing tools after add/remove/enable/disable.
 * @param fileProxy - Optional proxy for resolving the workspace root.
 * @param prompts - Used by `/mcp add <preset>` to collect credentials.
 */
export const handleMcp = async (
  sub: string,
  argument: string,
  conn: Connection,
  fileProxy: LocalFileProxy | undefined,
  prompts: PromptPort,
): Promise<void> => {
  const workspaceRoot = fileProxy?.getWorkspaceRoot() ?? process.cwd();

  switch (sub) {
    case "":
    case "list": {
      const config = loadConfig();
      const names = Object.keys(config.mcpServers);
      const hasTokenSave = await isTokenSaveOnPath();

      if (names.length === 0 && !hasTokenSave) {
        printLine(
          `  No MCP servers configured. Add one with /mcp add <github|jira|slack|name>.`,
        );
        return;
      }

      if (hasTokenSave) {
        printLine("  tokensave (built-in — manage with /tokensave)");
      }
      for (const name of names) {
        const serverConfig = config.mcpServers[name]!;
        const disabledLabel = serverConfig.enabled === false ? " [disabled]" : "";
        printLine(`  ${name} (${describeServerConfig(serverConfig)})${disabledLabel}`);
      }
      return;
    }

    case "add": {
      const [first] = argument.trim().split(/\s+/);
      if (!first) {
        printError(USAGE);
        return;
      }

      const restLooksCustom = /--command|--url/.test(argument);
      if (isMcpPresetId(first) && !restLooksCustom) {
        await addPreset(first, prompts, conn, workspaceRoot);
        return;
      }

      const parsed = parseCustomAdd(argument);
      if (!parsed) {
        printError(USAGE);
        return;
      }

      const config = loadConfig();
      updateConfig({
        mcpServers: { ...config.mcpServers, [parsed.name]: parsed.config },
      });
      printSuccess(`Added MCP server "${parsed.name}".`);

      const synced = await syncAllMcpTools(conn, workspaceRoot);
      if (synced > 0) {
        printSuccess(`Synced ${synced} tool(s) to server.`);
      }
      return;
    }

    case "remove": {
      const name = argument.trim();
      if (!name) {
        printError("Usage: /mcp remove <name>");
        return;
      }

      const config = loadConfig();
      if (!(name in config.mcpServers)) {
        printError(`No MCP server named "${name}".`);
        return;
      }

      const remainingServers = { ...config.mcpServers };
      delete remainingServers[name];
      const remainingSecrets = { ...config.mcpSecrets };
      delete remainingSecrets[name];
      updateConfig({ mcpServers: remainingServers, mcpSecrets: remainingSecrets });

      await disconnectMcpClient(name);
      printSuccess(`Removed MCP server "${name}".`);

      await syncAllMcpTools(conn, workspaceRoot);
      return;
    }

    case "enable":
    case "disable": {
      const name = argument.trim();
      if (!name) {
        printError(`Usage: /mcp ${sub} <name>`);
        return;
      }

      const config = loadConfig();
      const serverConfig = config.mcpServers[name];
      if (!serverConfig) {
        printError(`No MCP server named "${name}".`);
        return;
      }

      const enabled = sub === "enable";
      updateConfig({
        mcpServers: {
          ...config.mcpServers,
          [name]: { ...serverConfig, enabled },
        },
      });
      printSuccess(`${enabled ? "Enabled" : "Disabled"} MCP server "${name}".`);

      // Re-sync either way: enabling should pick its tools back up
      // immediately, disabling should drop them and tear down the
      // connection — see the `enabled === false` skip in syncAllMcpTools.
      await syncAllMcpTools(conn, workspaceRoot);
      return;
    }

    case "tools": {
      const filterName = argument.trim();
      const config = loadConfig();
      const serverIds = filterName
        ? [filterName]
        : Object.keys(config.mcpServers).filter(
            (id) => config.mcpServers[id]!.enabled !== false,
          );

      if (serverIds.length === 0) {
        printLine("  No MCP servers configured.");
        return;
      }

      for (const serverId of serverIds) {
        const serverConfig = config.mcpServers[serverId];
        if (!serverConfig) {
          printError(`No MCP server named "${serverId}".`);
          continue;
        }
        try {
          const secrets = config.mcpSecrets[serverId] ?? {};
          const tools = await listMcpTools(serverId, serverConfig, secrets);
          printLine(`  ${serverId}:`);
          for (const tool of tools) {
            const roLabel = tool.readOnly ? " (read-only)" : "";
            printLine(`    ${namespaceToolName(serverId, tool.name)}${roLabel}`);
          }
          if (tools.length === 0) {
            printLine("    (no tools advertised)");
          }
        } catch (error) {
          printError(`  ${serverId}: failed to connect — ${formatErrorMessage(error)}`);
        }
      }
      return;
    }

    case "check": {
      const name = argument.trim();
      if (!name) {
        printError("Usage: /mcp check <name>");
        return;
      }
      const config = loadConfig();
      const serverConfig = config.mcpServers[name];
      if (!serverConfig) {
        printError(`No MCP server named "${name}".`);
        return;
      }
      try {
        const secrets = config.mcpSecrets[name] ?? {};
        const tools = await listMcpTools(name, serverConfig, secrets);
        printSuccess(`Connected to "${name}" — ${tools.length} tool(s) available.`);
      } catch (error) {
        printError(`Failed to connect to "${name}": ${formatErrorMessage(error)}`);
      }
      return;
    }

    default:
      printError(USAGE);
  }
};
