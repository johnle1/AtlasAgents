/**
 * Slash-command router for the LoopyCode CLI REPL.
 *
 * @remarks
 * {@link CommandHandler} sits between user input and task submission: lines that
 * start with `/` are handled here; everything else is treated as a task by the
 * caller. Domain logic lives in sibling modules (`configHandlers`,
 * `modelHandlers`, …) so this file only owns parsing and dispatch.
 *
 * Supported command families:
 * - Config: `/set`, `/config`, `/agent`
 * - Models: `/models`
 * - Skills / memory: `/skills`, `/memory`
 * - Workspace: `/workspace`, `/cwd`
 * - Display: `/spinner`, `/think`, `/theme`
 * - Session: `/explore`, `/new`, `/exit`
 * - TokenSave: `/tokensave`
 *
 * @example
 * ```ts
 * const commands = new CommandHandler({
 *   conn: connection,
 *   prompts,
 *   skills,
 *   fileProxy,
 * });
 *
 * if (await commands.handle("/models list")) {
 *    was a slash command — do not send as a task
 * }
 * ```
 */

import type { PromptPort } from "../ui/promptPort.js";
import type { Connection } from "../connection/index.js";
import type { SkillManager } from "../skills.js";
import type { LocalFileProxy } from "../localFileProxy.js";
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
import { handleTokenSave } from "./tokenSaveHandlers.js";
import { printError } from "../renderer.js";

/**
 * Injected collaborators required to run slash commands.
 *
 * @remarks
 * Optional fields disable related commands gracefully (e.g. missing
 * `fileProxy` still allows most commands; `/workspace` / `/cwd` degrade).
 */
export interface CommandHandlerDeps {
  /** Live RSocket client for server-backed routes (`/models`, `/memory`, …). */
  conn: Connection;

  /** Interactive prompts (password, theme, numbered choices). */
  prompts: PromptPort;

  /** When set, `/skills` prefers SkillManager over module-level helpers. */
  skills?: SkillManager;

  /** Workspace sandbox for `/workspace`, `/cwd`, and `/tokensave`. */
  fileProxy?: LocalFileProxy;

  /** Invoked after workspace changes so the CLI prompt can refresh. */
  onPromptUpdate?: () => void;

  /**
   * Custom process teardown for `/exit`.
   * When omitted, {@link handleExit} prints goodbye and calls `process.exit(0)`.
   */
  onExit?: () => void;
}

/**
 * Parses leading-slash input and dispatches to the matching handler module.
 *
 * @remarks
 * Does **not** submit tasks — callers must check the boolean return and only
 * forward non-command lines to `Connection.sendTask`. Unknown commands print
 * an error but still return `true` so they are not sent as tasks.
 */
export class CommandHandler {
  private conn: Connection;
  private prompts: PromptPort;
  private readonly skills?: SkillManager;
  private readonly fileProxy?: LocalFileProxy;
  private readonly onPromptUpdate?: () => void;
  private readonly onExit?: () => void;

  /**
   * Stores dependencies for all routed handlers.
   *
   * @param deps - Connection, prompts, and optional skills/file-proxy hooks.
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
   * Attempts to handle `input` as a slash command.
   *
   * @remarks
   * Parsing: strip leading `/`, split on whitespace into
   * `command` / `subcommand` / `argument` (argument may contain spaces).
   * `/set advisor|agent` delegates model picking via
   * {@link handleSetModel}. `/help` is intentionally removed (points users to
   * `/config`).
   *
   * @param input - Raw readline / prompt line from the user.
   * @returns `true` if the line started with `/` (handled or unknown command);
   *   `false` if it should be treated as plain task text.
   *
   * @example
   * ```ts
   * await handler.handle("/set port 7000"); // true
   * await handler.handle("refactor auth");  // false
   * ```
   */
  handle = async (input: string): Promise<boolean> => {
    if (!input.startsWith("/")) return false;

    const parts = input.slice(1).split(/\s+/);
    const command = parts[0]?.toLowerCase() ?? "";
    const subcommand = parts[1]?.toLowerCase() ?? "";
    // Join remainder so values like hostnames or skill names may contain spaces.
    const argument = parts.slice(2).join(" ");

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
      case "tokensave":
        await handleTokenSave(subcommand, argument, this.conn, this.fileProxy);
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

    return true;
  };
}
