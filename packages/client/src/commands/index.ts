/**
 * Command handler module.
 *
 * This module provides the main CommandHandler class that routes slash commands
 * to specialized handler functions. Each category of commands is split into
 * separate handler modules for better maintainability.
 *
 * Command structure:
 * - Config commands: /set, /config, /agent
 * - Model commands: /models
 * - Skill commands: /skills
 * - Memory commands: /memory
 * - Workspace commands: /workspace, /cwd
 * - Display commands: /spinner, /think
 * - Session commands: /explore, /new, /exit
 * - Theme command: /theme
 */

import type { PromptPort } from "../ui/promptPort.js";
import type { Connection } from "../connection/index.js";
import type { SkillManager } from "../skills.js";
import type { LocalFileProxy } from "../localFileProxy.js";

/**
 * Dependencies required by the CommandHandler class.
 */
export interface CommandHandlerDeps {
  /** Live RSocket client for server-backed commands. */
  conn: Connection;
  /** REPL prompts used for user interaction. */
  prompts: PromptPort;
  /** Optional SkillManager for /skills command. */
  skills?: SkillManager;
  /** Optional file proxy for workspace operations. */
  fileProxy?: LocalFileProxy;
  /** Optional callback for prompt updates. */
  onPromptUpdate?: () => void;
  /** Optional custom exit handler. */
  onExit?: () => void;
}

// Import handler functions from specialized modules
import {
  handleAgent,
  handleSet as handleSetConfig,
  handleConfig,
} from "./configHandlers.js";
import { handleSetModel } from "./modelSelectionHandlers.js";
import { handleModels } from "./modelHandlers.js";
import { handleSkills } from "./skillHandlers.js";
import { handleMemory } from "./memoryHandlers.js";
import { handleWorkspace, handleCwd } from "./workspaceHandlers.js";
import { handleSpinner, handleThink } from "./displayHandlers.js";
import { handleExplore, handleNew, handleExit } from "./sessionHandlers.js";

// Import renderer functions
import { printError } from "../renderer.js";

/**
 * <Summary>
 * What it does:
 *   Parses leading-slash input and runs the matching local command handler without treating it as a task line.
 *
 * How it fits in the system:
 *   Sits between index.ts readline and Connection: slash lines stop here; plain text is sent as tasks from index.
 * </Summary>
 */
export class CommandHandler {
  /** Live RSocket client for server-backed commands. */
  private conn: Connection;
  /** REPL prompts used for user interaction. */
  private prompts: PromptPort;
  /** Optional SkillManager for /skills command. */
  private readonly skills?: SkillManager;
  /** Optional file proxy for workspace operations. */
  private readonly fileProxy?: LocalFileProxy;
  /** Optional callback for prompt updates. */
  private readonly onPromptUpdate?: () => void;
  /** Optional custom exit handler. */
  private readonly onExit?: () => void;
  /**
   * <Summary>
   * What it does:
   *   Captures the RSocket connection, readline instance, and optional SkillManager used by all command handlers.
   *
   * How it does it (step by step):
   *   1. Stores conn, prompts, and optional dependencies on the instance for handler methods.
   *
   * Parameters:
   *   @param deps - Object containing all CommandHandler dependencies.
   *
   * Returns:
   *   void — constructor side effects only.
   *
   *   None (field assignment only).
   * </Summary>
   */
  constructor(deps: CommandHandlerDeps) {
    this.conn = deps.conn;
    this.prompts = deps.prompts;
    this.skills = deps.skills;
    this.fileProxy = deps.fileProxy;
    this.onPromptUpdate = deps.onPromptUpdate;
    this.onExit = deps.onExit;
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Determines if the input is a slash command and routes it to the
   *   appropriate handler, or returns false if it's plain task text.
   *
   * How it does it (step by step):
   *   1. Checks if input starts with "/" — returns false if not.
   *   2. Splits input into command, subcommand, and argument.
   *   3. Routes to the appropriate handler method based on command.
   *   4. Prints error for unknown commands.
   *   5. Returns true if a command was handled.
   *
   * Parameters:
   *   @param input - Raw user input from the readline interface.
   *
   * Returns:
   *   @returns true if command was handled, false if plain text.
   * </Summary>
   */
  handle = async (input: string): Promise<boolean> => {
    // Return false if input doesn't start with "/" (not a command)
    if (!input.startsWith("/")) return false;

    // Parse input into command parts: remove leading slash, split by whitespace
    const parts = input.slice(1).split(/\s+/);
    const command = parts[0]?.toLowerCase() ?? "";
    const subcommand = parts[1]?.toLowerCase() ?? "";
    const argument = parts.slice(2).join(" ");

    // Route to appropriate handler based on command
    switch (command) {
      case "set":
        await handleSetConfig(
          subcommand,
          argument,
          this.conn,
          this.prompts,
          (role) => handleSetModel(role, this.conn, this.prompts),
        );
        break;
      case "agent":
        handleAgent(subcommand, argument);
        break;
      case "config":
        await handleConfig();
        break;
      case "skills":
        await handleSkills(subcommand, argument, this.skills, this.conn);
        break;
      case "memory":
        await handleMemory(subcommand, argument, this.conn);
        break;
      case "models":
        await handleModels(subcommand, argument, this.conn);
        break;
      case "new":
        await handleNew(this.conn);
        break;
      case "explore":
        await handleExplore(this.conn);
        break;
      case "workspace":
        await handleWorkspace(
          subcommand,
          argument,
          this.fileProxy,
          this.onPromptUpdate,
        );
        break;
      case "cwd":
        handleCwd(this.fileProxy);
        break;
      case "think":
        handleThink(subcommand, argument);
        break;
      case "spinner":
        handleSpinner(subcommand, argument);
        break;
      case "theme":
        await this.prompts.pickTheme();
        break;
      case "help":
        printError("Help command removed. Use /config to see configuration.");
        break;
      case "exit":
        handleExit(this.onExit);
        break;
      default:
        printError(
          `Unknown command: /${command}. Use /config to see configuration.`,
        );
        break;
    }

    // Return true to indicate command was handled
    return true;
  };
}
