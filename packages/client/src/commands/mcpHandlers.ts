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
  HEADER_SECRET_PREFIX,
  listMcpTools,
  namespaceToolName,
  pinHttpTransportKind,
  type HttpTransportKind,
} from "../mcp/mcpRegistry.js";
import { deriveServerId, validateServerId } from "../mcp/mcpServerName.js";
import { isTokenSaveOnPath } from "../mcp/tokenSaveClient.js";
import { syncAllMcpTools } from "./tokenSaveHandlers.js";
import type { McpSyncMutation } from "../mcp/mcpSyncPlan.js";
import { printError, printLine, printSuccess } from "../renderer.js";
import { formatErrorMessage } from "./utils.js";

const USAGE =
  'Usage: /mcp list | add <github|jira|slack|name|url> [--command <cmd> [--args a,b] | --url <url>] [--token <tok>] [--header Name=value]... [--transport http|sse] [--readonly] | remove <name> | enable <name> | disable <name> | tools [name] | check <name> | refresh [name]';

/** Splits `--header Name=value` on the FIRST "=" so values containing "=" (base64, JWTs) survive. */
const parseHeaderFlag = (raw: string): { name: string; value: string } | null => {
  const eqIndex = raw.indexOf("=");
  if (eqIndex <= 0) {
    return null;
  }
  return { name: raw.slice(0, eqIndex), value: raw.slice(eqIndex + 1) };
};

/** Outcome of {@link parseCustomAdd}. */
type CustomAddResult =
  | {
      kind: "parsed";
      name: string;
      config: McpServerConfig;
      secrets: Record<string, string>;
      /** True for an HTTP server added with no `--token`/`--header` — the caller should offer an optional credential prompt. */
      promptForCredential: boolean;
      /** Set only by an explicit `--transport` flag, so the caller can pin the probe result and skip the streamable-HTTP-then-SSE dance on first connect. */
      pinTransportKind?: HttpTransportKind;
    }
  | { kind: "usage" }
  | { kind: "invalid"; reason: string };

/**
 * Parses `/mcp add <name|url> [--command <cmd> [--args a,b] | --url <url>]
 * [--token <tok>] [--header Name=value]... [--transport http|sse] [--readonly]`.
 *
 * @remarks
 * A first token that parses as an `http(s)` URL is treated as `--url`
 * implicitly, with the server name derived from its hostname (see
 * {@link deriveServerId}) — this is what makes `/mcp add <link>` alone work.
 *
 * @param existingNames - Server ids already configured, so a name derived
 *   from a bare URL doesn't collide with one already in use.
 */
const parseCustomAdd = (
  argument: string,
  existingNames: ReadonlySet<string>,
): CustomAddResult => {
  const tokens = argument.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first) {
    return { kind: "usage" };
  }

  const isBareUrl = /^https?:\/\//i.test(first);
  const name = isBareUrl ? deriveServerId(first, existingNames) : first;

  let command: string | undefined;
  let url: string | undefined = isBareUrl ? first : undefined;
  let argsCsv: string | undefined;
  let readOnly = false;
  let token: string | undefined;
  let transportKind: HttpTransportKind | undefined;
  const headerSecrets: Record<string, string> = {};

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--command" && tokens[i + 1]) {
      command = tokens[++i];
    } else if (t === "--url" && tokens[i + 1]) {
      url = tokens[++i];
    } else if (t === "--args" && tokens[i + 1]) {
      argsCsv = tokens[++i];
    } else if (t === "--readonly") {
      readOnly = true;
    } else if (t === "--token" && tokens[i + 1]) {
      token = tokens[++i];
    } else if (t === "--header" && tokens[i + 1]) {
      const raw = tokens[++i]!;
      const header = parseHeaderFlag(raw);
      if (!header) {
        return { kind: "invalid", reason: `--header expects "Name=value", got "${raw}".` };
      }
      headerSecrets[`${HEADER_SECRET_PREFIX}${header.name}`] = header.value;
    } else if (t === "--transport" && tokens[i + 1]) {
      const value = tokens[++i];
      if (value !== "http" && value !== "sse") {
        return {
          kind: "invalid",
          reason: `--transport must be "http" or "sse", got "${value}".`,
        };
      }
      // The user-facing flag says "http"; the internal HttpTransportKind
      // names the concrete SDK transport class ("streamableHttp").
      transportKind = value === "http" ? "streamableHttp" : "sse";
    }
  }

  if (!command && !url) {
    return { kind: "usage" };
  }

  const idCheck = validateServerId(name);
  if (!idCheck.ok) {
    return { kind: "invalid", reason: idCheck.reason };
  }

  const readOnlyField = readOnly ? { readOnly: true as const } : {};
  const secrets: Record<string, string> = { ...headerSecrets };
  if (token) {
    secrets.token = token;
  }

  if (command) {
    return {
      kind: "parsed",
      name,
      config: {
        transport: "stdio",
        command,
        args: argsCsv ? argsCsv.split(",").map((a) => a.trim()) : [],
        ...readOnlyField,
      },
      secrets,
      promptForCredential: false,
    };
  }

  // Validated here purely to fail fast with a clear message — the string
  // form (not a URL instance) is what's persisted to config; mcpRegistry's
  // buildTransport re-parses it at connect time.
  try {
    void new URL(url!);
  } catch {
    return { kind: "invalid", reason: `"${url}" is not a valid URL.` };
  }

  return {
    kind: "parsed",
    name,
    config: { transport: "http", url: url!, ...readOnlyField },
    secrets,
    promptForCredential: Object.keys(secrets).length === 0,
    pinTransportKind: transportKind,
  };
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

  const synced = await syncAllMcpTools(conn, workspaceRoot, {
    op: "add",
    serverId: preset.id,
  });
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
          `  No MCP servers configured. Add one with /mcp add <github|jira|slack|name>, or paste a link: /mcp add <url>.`,
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

      // A bare link (no name) always takes the custom path, same as any of
      // the credential/transport flags — none of these make sense for a
      // built-in preset, whose connection shape is fixed.
      const looksCustom =
        /^https?:\/\//i.test(first) ||
        /--command|--url|--token|--header|--transport/.test(argument);
      if (isMcpPresetId(first) && !looksCustom) {
        await addPreset(first, prompts, conn, workspaceRoot);
        return;
      }

      const config = loadConfig();
      const existingNames = new Set(Object.keys(config.mcpServers));
      const parsed = parseCustomAdd(argument, existingNames);

      if (parsed.kind === "usage") {
        printError(USAGE);
        return;
      }
      if (parsed.kind === "invalid") {
        printError(parsed.reason);
        return;
      }

      let secrets = parsed.secrets;
      if (parsed.promptForCredential) {
        const token = await prompts.question(
          `Optional credential for "${parsed.name}" (bearer token — leave blank if this server handles its own auth): `,
          { masked: true },
        );
        if (token) {
          secrets = { ...secrets, token };
        }
      }

      updateConfig({
        mcpServers: { ...config.mcpServers, [parsed.name]: parsed.config },
        ...(Object.keys(secrets).length > 0
          ? { mcpSecrets: { ...config.mcpSecrets, [parsed.name]: secrets } }
          : {}),
      });
      printSuccess(`Added MCP server "${parsed.name}".`);

      if (parsed.pinTransportKind) {
        pinHttpTransportKind(parsed.name, parsed.pinTransportKind);
      }

      const synced = await syncAllMcpTools(conn, workspaceRoot, {
        op: "add",
        serverId: parsed.name,
      });
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

      await disconnectMcpClient(name, { forgetTransportKind: true });
      printSuccess(`Removed MCP server "${name}".`);

      await syncAllMcpTools(conn, workspaceRoot, { op: "remove", serverId: name });
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

      // Re-sync either way: enabling reuses its cached tools with no
      // spawn when its config hasn't changed and its cache hasn't expired;
      // disabling retains the cache (marked inactive) and tears down the
      // live connection — see `planMcpMutation` in mcpSyncPlan.ts.
      await syncAllMcpTools(conn, workspaceRoot, { op: "toggle", serverId: name });
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

    case "refresh": {
      const name = argument.trim();
      const mutation: McpSyncMutation = name
        ? { op: "refresh", serverId: name }
        : { op: "refresh" };
      const synced = await syncAllMcpTools(conn, workspaceRoot, mutation);
      printSuccess(
        name
          ? `Refreshed "${name}" — ${synced} tool(s) synced.`
          : `Refreshed all MCP servers — ${synced} tool(s) synced.`,
      );
      return;
    }

    default:
      printError(USAGE);
  }
};
