/**
 * Single source of truth for CLI slash-commands, suggestions, and parameter configurations.
 */

/**
 * Metadata configuration for an autocomplete command entry.
 */
export type CommandEntry = {
  /** The raw command string matched against user input. */
  command: string;

  /** Optional display label showing parameter placeholder hints. */
  label?: string;

  /** Descriptive text shown next to the command suggestion. */
  description: string;

  /** True if arguments are required and must be prompted for if omitted. */
  requiresArgs?: boolean;
};

/**
 * Registry catalog of all available slash commands.
 */
export const COMMAND_CATALOG: CommandEntry[] = [
  {
    command: "/set password",
    label: "/set password [value]",
    description: "Set server password (prompt if omitted)",
    requiresArgs: true,
  },
  {
    command: "/set server",
    label: "/set server [host]",
    description: "Set server host (prompt if omitted)",
    requiresArgs: true,
  },
  {
    command: "/set port",
    label: "/set port [n]",
    description: "Set server port (prompt if omitted)",
    requiresArgs: true,
  },
  {
    command: "/providers list",
    description: "List configured providers and their role assignment",
  },
  {
    command: "/providers remove",
    label: "/providers remove <name>",
    description: "Remove a configured provider",
    requiresArgs: true,
  },
  {
    command: "/agent cap",
    label: "/agent cap [n]",
    description:
      "Default agent cap is 3; ::focus/::collab/::max override per task",
    requiresArgs: true,
  },
  {
    command: "/config",
    description: "Show current configuration",
  },
  {
    command: "/theme",
    description: "Choose terminal color theme",
  },
  {
    command: "/model",
    description:
      "Choose agent model (from any configured provider) — same model as subagent is fine",
  },
  {
    command: "/effort",
    description:
      "Choose how much the agent re-deliberates before acting (low/medium/high/extra-high/max)",
  },
  {
    command: "/skills list",
    description: "List local skill files",
  },
  {
    command: "/skills add",
    label: "/skills add <name>",
    description: "Create a new skill file",
    requiresArgs: true,
  },
  {
    command: "/skills sync",
    label: "/skills sync [path]",
    description: "Sync skills to server, optionally from a custom path",
  },
  {
    command: "/memory show",
    description: "Show stored preferences",
  },
  {
    command: "/memory forget",
    label: "/memory forget <topic>",
    description: "Forget a topic",
    requiresArgs: true,
  },
  {
    command: "/memory clear",
    description: "Clear all memories",
  },
  {
    command: "/models list",
    description: "List installed models",
  },
  {
    command: "/models find",
    label: "/models find <name>",
    description: "Find a local model by name",
    requiresArgs: true,
  },
  {
    command: "/models pull",
    label: "/models pull <name>",
    description: "Pull a model from Ollama",
    requiresArgs: true,
  },
  {
    command: "/models delete",
    label: "/models delete <name>",
    description: "Delete a model",
    requiresArgs: true,
  },
  {
    command: "/models show",
    label: "/models show <name>",
    description: "Show model details",
    requiresArgs: true,
  },
  {
    command: "/models running",
    description: "List running models",
  },
  {
    command: "/models storage",
    description: "Show real on-disk usage — shared blobs, orphaned pull files",
  },
  {
    command: "/new",
    description: "Clear server session",
  },
  {
    command: "/workspace set",
    label: "/workspace set <path>",
    description: "Set local workspace root",
    requiresArgs: true,
  },
  {
    command: "/cwd",
    description: "Print current directory",
  },
  {
    command: "/sandbox",
    description: "Show sandbox mode and active backend",
  },
  {
    command: "/sandbox auto",
    description: "Use the strongest sandbox backend available on this machine",
  },
  {
    command: "/sandbox container",
    description: "Always sandbox commands in a container (Docker/Podman)",
  },
  {
    command: "/sandbox off",
    description: "Disable command sandboxing",
  },
  {
    command: "/mcp list",
    description: "List configured MCP servers",
  },
  {
    command: "/mcp add",
    label: "/mcp add <github|jira|slack|name> [--command <cmd> | --url <url>]",
    description: "Add a built-in preset or a custom MCP server",
    requiresArgs: true,
  },
  {
    command: "/mcp remove",
    label: "/mcp remove <name>",
    description: "Remove a configured MCP server",
    requiresArgs: true,
  },
  {
    command: "/mcp enable",
    label: "/mcp enable <name>",
    description: "Re-enable a disabled MCP server",
    requiresArgs: true,
  },
  {
    command: "/mcp disable",
    label: "/mcp disable <name>",
    description: "Turn off an MCP server without deleting its config",
    requiresArgs: true,
  },
  {
    command: "/mcp tools",
    label: "/mcp tools [name]",
    description: "List tools discovered from one or all MCP servers",
  },
  {
    command: "/mcp check",
    label: "/mcp check <name>",
    description: "Connect to an MCP server and report its tool count",
    requiresArgs: true,
  },
  {
    command: "/tokensave init",
    description: "Initialize the TokenSave code index for this workspace",
  },
  {
    command: "/tokensave status",
    description: "Show TokenSave index status",
  },
  {
    command: "/debug",
    label: "/debug on|off",
    description: "Verbose agent and file-proxy logs",
    requiresArgs: true,
  },
  {
    command: "/think",
    label: "/think on/off",
    description: "Show agent/subagent think boxes in terminal",
    requiresArgs: true,
  },
  {
    command: "/spinner",
    label: "/spinner on|off",
    description: "Toggle spinner display",
    requiresArgs: true,
  },
  {
    command: "/notify",
    label: "/notify on|off",
    description: "Toggle desktop notifications (opt-in, default off)",
    requiresArgs: true,
  },
  {
    command: "/explore",
    description: "Refresh codebase snapshot for this session",
  },
  {
    command: "/help",
    description: "Show command help",
  },
  {
    command: "/clear",
    description: "Clear the screen (Ctrl+L)",
  },
  {
    command: "/exit",
    description: "Quit (Ctrl+C on empty input)",
  },
];

/** Index map for efficient lookup of command configurations. */
const catalogByCommand = new Map(
  COMMAND_CATALOG.map((commandEntry) => [commandEntry.command, commandEntry]),
);

/**
 * Resolves all command autocomplete suggestions matching the user's input prefix.
 *
 * @param input - The current raw input line.
 * @returns A filtered array of command entries matching the typed prefix.
 */
export const getCommandSuggestions = (input: string): CommandEntry[] => {
  if (!input.startsWith("/")) {
    return [];
  }

  return COMMAND_CATALOG.filter((commandEntry) =>
    commandEntry.command.startsWith(input),
  );
};

/**
 * Resolves the display label containing option placeholders for a specific command name.
 *
 * @param command - The command string key.
 * @returns The matching display label, falling back to the command name if not found.
 */
export const getCommandLabel = (command: string): string =>
  catalogByCommand.get(command)?.label ?? command;

/**
 * Resolves the description text for a specific command name.
 *
 * @param command - The command string key.
 * @returns Description text, or an empty string.
 */
export const getCommandDescription = (command: string): string =>
  catalogByCommand.get(command)?.description ?? "";

/**
 * Verifies if a command requires parameter arguments to function.
 *
 * @param command - The command string key.
 * @returns True if arguments are required, false otherwise.
 */
export const commandRequiresArgs = (command: string): boolean =>
  catalogByCommand.get(command)?.requiresArgs === true;
