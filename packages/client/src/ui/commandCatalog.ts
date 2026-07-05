/**
 * <Summary>
 * What it does:
 *   Provides a single source of truth for slash-command autocomplete suggestions and descriptions.
 *
 * How it fits in the system:
 *   Central command catalog that the CLI autocomplete system uses to suggest commands,
 *   display help text, and validate command syntax. This ensures all command information
 *   is consistent and maintained in one place.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Defines the structure of a command entry in the command catalog.
 *
 * Used by:
 *   - COMMAND_CATALOG — provides the structure for all command entries.
 *   - Command autocomplete functions — create objects of this shape.
 *
 * Produced by:
 *   - COMMAND_CATALOG — contains entries implementing this interface.
 * </Summary>
 */
export type CommandEntry = {
  /** The command string that gets inserted on Tab and matched while typing. */
  command: string;

  /**
   * The menu label displayed in autocomplete suggestions.
   * If not provided, defaults to the command value.
   * Can include placeholder syntax to indicate required arguments (e.g., "/set password [value]").
   */
  label?: string;

  /** Human-readable description of what the command does. */
  description: string;

  /**
   * Indicates whether the command requires arguments to function properly.
   * When true, the command will prompt for missing arguments if omitted.
   */
  requiresArgs?: boolean;
};

/**
 * <Summary>
 * What it does:
 *   The complete catalog of all available slash commands with their metadata.
 *
 * How it fits in the system:
 *   Serves as the central registry for all slash commands that users can execute.
 *   Includes configuration commands, skill management, model operations, memory management,
 *   and system controls. This is the single source of truth for command information.
 * </Summary>
 */
export const COMMAND_CATALOG: CommandEntry[] = [
  /**
   * <Summary>
   * What it does:
   *   Sets the server password for authentication.
   *
   * Usage:
   *   - Sets the password used to authenticate with the LoopyCode server.
   *   - If no value is provided, prompts the user to enter the password securely.
   *
   * Arguments:
   *   - value — The password to set (optional, prompts if omitted).
   * </Summary>
   */
  {
    command: "/set password",
    label: "/set password [value]",
    description: "Set server password (prompt if omitted)",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Sets the server host for connection.
   *
   * Usage:
   *   - Sets the host address for the LoopyCode server.
   *   - If no value is provided, prompts the user to enter the host.
   *
   * Arguments:
   *   - host — The server host address (optional, prompts if omitted).
   * </Summary>
   */
  {
    command: "/set server",
    label: "/set server [host]",
    description: "Set server host (prompt if omitted)",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Sets the server port for connection.
   *
   * Usage:
   *   - Sets the port number for the LoopyCode server.
   *   - If no value is provided, prompts the user to enter the port.
   *
   * Arguments:
   *   - n — The port number (optional, prompts if omitted).
   * </Summary>
   */
  {
    command: "/set port",
    label: "/set port [n]",
    description: "Set server port (prompt if omitted)",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Opens the advisor model selection interface.
   *
   * Usage:
   *   - Allows the user to choose the model used for planning and advising.
   *   - Displays a selection menu of available advisor models.
   * </Summary>
   */
  {
    command: "/set advisor",
    description: "Choose advisor model",
  },

  /**
   * <Summary>
   * What it does:
   *   Opens the agent model selection interface.
   *
   * Usage:
   *   - Allows the user to choose the model used for task execution.
   *   - Displays a selection menu of available agent models.
   * </Summary>
   */
  {
    command: "/set agent",
    description: "Choose agent model",
  },

  /**
   * <Summary>
   * What it does:
   *   Sets the agent message cap limit for task execution.
   *
   *   - Default is 3 messages per task
   *   - Special modes: ::focus (1 message), ::collab (no limit), ::max (no limit)
   * Usage:
   *   - Controls how many messages the agent can exchange per task.
   *   - Higher caps allow for longer tasks but may increase cost.
   *   - Use ::max to remove the cap entirely (unlimited messages).
   *
   * Arguments:
   *   - n — The cap value or special mode (optional, prompts if omitted).
   * </Summary>
   */
  {
    command: "/agent cap",
    label: "/agent cap [n]",
    description:
      "Default agent cap is 3; ::focus/::collab/::max override per task",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Displays the current configuration settings.
   *
   * Usage:
   *   - Shows the current server, port, theme, and model settings.
   *   - Displays password as asterisks for security.
   *   - Shows advisor and agent model configurations.
   *   - Displays UI settings (theme, spinner, think output).
   * </Summary>
   */
  {
    command: "/config",
    description: "Show current configuration",
  },

  /**
   * <Summary>
   * What it does:
   *   Opens the theme selection interface.
   *
   * Usage:
   *   - Allows the user to choose from available terminal color themes.
   *   - Displays a selection menu of available themes (default, ocean, forest, etc.).
   *   - Includes VS Code and GitHub themes for consistency with popular editors.
   * </Summary>
   */
  {
    command: "/theme",
    description: "Choose terminal color theme",
  },

  /**
   * <Summary>
   * What it does:
   *   Lists all local skill files in the workspace.
   *
   * Usage:
   *   - Displays a list of skill files in the .devin/skills/ directory.
   *   - Helps users discover and manage available skills.
   * </Summary>
   */
  {
    command: "/skills list",
    description: "List local skill files",
  },

  /**
   * <Summary>
   * What it does:
   *   *   Creates a new skill file in the workspace.
   *
   * Usage:
   *   - Creates a new skill file with a specified name in the .devin/skills/ directory.
   *   - Provides a template for defining custom behavior for the agent.
   *
   * Arguments:
   *   - name — The name for the new skill file.
   * </Summary>
   */
  {
    command: "/skills add",
    label: "/skills add <name>",
    description: "Create a new skill file",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Syncs local skill files to the server.
   *
   * Usage:
   *   - Uploads local skill files to the server for use by the agent.
   *   - Makes custom skills available across different sessions and environments.
   * </Summary>
   */
  {
    command: "/skills sync",
    description: "Sync skills to server",
  },

  /**
   * <Summary>
   * What it does:
   *   Displays all stored preferences and memory entries.
   *
   * Usage:
   *   - Shows all topics and their associated rules stored in memory.
   *   - Helps users understand what preferences the agent has learned.
   * </Summary>
   */
  {
    command: "/memory show",
    description: "Show stored preferences",
  },

  /**
   * <Summary>
   * What it does:
   *   Forgets a specific memory topic and its rules.
   *
   * Usage:
   *   - Removes a topic and all its associated rules from agent memory.
   *   - Allows the agent to "unlearn" specific preferences or corrections.
   *
   * Arguments:
   *   - topic — The memory topic to forget.
   * </Summary>
   */
  {
    command: "/memory forget",
    label: "/memory forget <topic>",
    description: "Forget a topic",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Clears all stored preferences and memory entries.
   *
   * Usage:
   *   - Removes all topics and rules from agent memory.
   *   - Resets the agent to its default behavior.
   *   - Useful for starting fresh when preferences become incorrect.
   * </Summary>
   */
  {
    command: "/memory clear",
    description: "Clear all memories",
  },

  /**
   * <Summary>
   * What it does:
   *   Lists all models currently installed on the system.
   *
   * Usage:
   *   - Displays model names, sizes, and modification dates.
   *   - Shows which models are available for agent task execution.
   * </Summary>
   */
  {
    command: "/models list",
    description: "List installed models",
  },

  /**
   * <Summary>
   * What it does:
   *   Searches for a model by name in the local installation.
   *
   * Usage:
   *   - Searches the installed models for a match to the provided name.
   *   - Displays model details if found, or suggests available alternatives if not.
   *
   * Arguments:
   *   - name — The model name to search for.
   * </Summary>
   */
  {
    command: "/models find",
    label: "/models find <name>",
    description: "Find a local model by name",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Downloads and installs a model from the Ollama registry.
   *
   * Usage:
   *   - Connects to Ollama to download the specified model.
   *   - Shows download progress during the pull operation.
   *   - Makes the model available for agent task execution.
   *
   * Arguments:
   *   - name — The Ollama model name to pull (e.g., "llama3", "mistral").
   * </Summary>
   */
  {
    command: "/models pull",
    label: "/models pull <name>",
    description: "Pull a model from Ollama",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Deletes an installed model from the system.
   *
   * Usage:
   *   - Removes the specified model from the Ollama installation.
   *   - Frees up disk space used by the model.
   *
   * Arguments:
   *   - name — The model name to delete (e.g., "llama3", "mistral").
   * </Summary>
   */
  {
    command: "/models delete",
    label: "/models delete <name>",
    description: "Delete a model",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Shows detailed information about a specific model.
   *
   * Usage:
   *   - Displays model name, size, modification date, and metadata.
   *   - Shows parameter size, quantization level, and family information.
   *   - Helps users understand model characteristics before use.
   *
   * Arguments:
   *   - name — The model name to show details for.
   * </Summary>
   */
  {
    command: "/models show",
    label: "/models show <name>",
    description: "Show model details",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Lists all models currently running in Ollama.
   *
   * Usage:
   *   - Shows model names that are actively running and consuming resources.
   *   - Helps users identify which models to stop to free up memory.
   * </Summary>
   */
  {
    command: "/models running",
    description: "List running models",
  },

  /**
   * <Summary>
   * What it does:
   *   Starts a new server session with the current workspace.
   *
   * Usage:
   *   - Clears the server session state for a fresh start.
   *   - Useful when the session state becomes corrupted or inconsistent.
   *   - Maintains the current workspace root directory.
   * </Summary>
   */
  {
    command: "/new",
    description: "Clear server session",
  },

  /**
   * <Summary>
   * What it does:
   *   Changes the local workspace root directory.
   *
   * Usage:
   *   - Sets a new directory as the workspace root for file operations.
   *   - All file operations will be scoped to this directory.
   *   - Useful for switching between different projects.
   *
   * Arguments:
   *   - path — The directory path to set as workspace root.
   * </Summary>
   */
  {
    command: "/workspace set",
    label: "/workspace set <path>",
    description: "Set local workspace root",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Displays the current working directory in the workspace.
   *
   * Usage:
   *   - Shows the current directory path within the workspace root.
   *   - Helps users understand their current location in the project structure.
   * </Summary>
   */
  {
    command: "/cwd",
    description: "Print current directory",
  },

  /**
   * <Summary>
   * What it does:
   *   Toggles verbose logging for agent and file-proxy operations.
   *
   * Usage:
   *   - Enables or disables detailed debug output from the agent and file proxy.
   *   - Useful for troubleshooting connection issues or command execution problems.
   *   - When enabled, shows detailed logs for all operations.
   *
   * Arguments:
   *   - mode — Either "on" to enable or "off" to disable debug logging.
   * </Summary>
   */
  {
    command: "/debug",
    label: "/debug on|off",
    description: "Verbose agent and file-proxy logs",
    requiresArgs: true,
  },

  /**
   * <Summary>
   * What it does:
   *   Toggles the display of advisor/agent think boxes in the terminal.
   *
   * Usage:
   *   - Enables or disables the display of think blocks showing agent reasoning.
   *   - Useful for users who want a cleaner output without internal processing details.
   *   - Disabled by default to reduce output verbosity.
   *
   * Arguments:
   *   - mode — Either "on" to enable or "off" to disable think boxes.
   * </Summary>
   */
  {
    command: "/think",
    label: "/think on/off",
    description: "Show advisor/agent think boxes in terminal",
    requiresArgs: true,
  },

  /**
   *   <Summary>
   * What it does:
   *   Toggles the animated spinner display for long-running operations.
   *
   * Usage:
   *   - Enables or disables the animated spinner shown during file operations.
   *   - Useful for users who prefer static output or have performance issues with animations.
   *   - Enabled by default to provide visual feedback.
   *
   * Arguments:
   *   - mode — Either "on" to enable or "off" to disable the spinner.
   * </Summary>
   */
  {
    command: "/spinner",
    description: "Toggle spinner display",
    requiresArgs: true,
  },

  /**
   * <Summary>
 * What it does:
   *   Refreshes the codebase snapshot for the current session.
   *
 * Usage:
   *   - Refreshes the codebase snapshot that the agent uses for context.
   *   - Updates the agent's knowledge of recent code changes.
   *   - Useful after making significant changes to the codebase.
   </Summary>
   */
  {
    command: "/explore",
    description: "Refresh codebase snapshot for this session",
  },

  /**
   * <Summary>
   * What it does:
   *   *   Displays help information about available commands.
   *
   * Usage:
   *   - Shows a list of all available slash commands.
   *   - Displays brief descriptions for each command.
   *   - Provides quick reference for users learning the CLI commands.
   * </Summary>
   */
  {
    command: "/help",
    description: "Show command help",
  },

  /**
   * <Summary>
   * What it does:
   *   Exits the application cleanly.
   *
   * Usage:
   *   - Terminates the CLI session and closes the connection to the server.
   * - Alternative: Press Ctrl+C when the agent is idle.
   *   - Alternative: Press Ctrl+L to force exit.
   * </Summary>
   */
  {
    command: "/exit",
    description: "Quit (Ctrl+C when idle; Ctrl+L when stuck)",
  },
];

/**
 * <Summary>
 * What it does:
 *   Provides efficient command lookup by command string using a Map.
 *
 * Used by:
 *   - All command lookup functions — use this for O(1) command retrieval.
 *
 * Produced by:
 *   - None (initialized from COMMAND_CATALOG).
 * </Summary>
 */
const catalogByCommand = new Map(
  COMMAND_CATALOG.map((commandEntry) => [commandEntry.command, commandEntry]),
);

/**
 * <Summary>
 * What it does:
 *   Filters the command catalog to find matching command suggestions.
 *
 * How it does it (step by step):
 *   1. Check if the input starts with "/" (slash command prefix).
 *   2. If not a slash command, return empty array (no suggestions).
 *   *   Filter the command catalog for entries whose command starts with the input.
 *   3. Return the matching command entries.
 *
 * Parameters:
 * @param input - The user's current input string to match against commands.
 *
 * Returns:
 * @returns Array of command entries that start with the input string.
 * </Summary>
 */
export const getCommandSuggestions = (input: string): CommandEntry[] => {
  // ===== STEP 1: Validate slash command input =====
  // Step 1a: Check if the input starts with "/" (slash command prefix)
  // Step 1b: If not a slash command, return empty array as there are no suggestions
  if (!input.startsWith("/")) {
    return [];
  }

  // ===== STEP 2: Filter for matching commands =====
  // Step 2a: Filter the command catalog for entries whose command starts with the input
  // Step 2b: This provides prefix-based autocomplete suggestions as the user types
  return COMMAND_CATALOG.filter((commandEntry) =>
    commandEntry.command.startsWith(input),
  );
};

/**
 * <Summary>
 * What it does:
 *   Returns the display label for a given command string.
 *
 * How it does it (step by step):
 *   1. Look up the command entry in the command-by-command Map.
 *   2. If found, return the label field (or command if label not specified).
 *   3. If not found, return the input command string as fallback.
 *
 * Parameters:
 * @param command - The command string to get the label for.
 *
 * Returns:
 * @returns The display label for the command, or the command string if not found.
 * </Summary>
 */
export const getCommandLabel = (command: string): string =>
  catalogByCommand.get(command)?.label ?? command;

/**
 * <Summary>
 * What it does:
 *   Returns the description for a given command string.
 *
 * How it does it (step by step):
 *   1. Look up the command entry in the command-by-command Map.
 *   2. If found, return the description field.
 *   3. If not found, return empty string as fallback.
 *
 * Parameters:
 * @param command - The command string to get the description for.
 *
 * Returns:
 * @returns The description of the command, or empty string if not found.
 * </Summary>
 */
export const getCommandDescription = (command: string): string =>
  catalogByCommand.get(command)?.description ?? "";

/**
 * <Summary>
 * What it does:
 *   Determines whether a command requires arguments to function properly.
 *
 * How it does it (step by step):
 *   1. Look up the command entry in the command-by-command Map.
 *   2. If found, check the requiresArgs field.
 *   3. Return true if requiresArgs is true, false otherwise.
 *
 * Parameters:
 * @param command - The command string to check for argument requirements.
 *
 * Returns:
 * @returns True if the command requires arguments, false otherwise.
 * </Summary>
 */
export const commandRequiresArgs = (command: string): boolean =>
  catalogByCommand.get(command)?.requiresArgs === true;
