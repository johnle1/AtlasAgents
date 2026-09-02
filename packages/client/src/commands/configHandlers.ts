/**
 * Handlers for configuration slash commands: `/agent`, `/set`, and `/config`.
 *
 * @remarks
 * This module manages user-facing configuration updates in the AtlasAgents CLI.
 * All slash commands synchronously load and update the persistent config file,
 * then print feedback to the user.
 *
 * **Connection reloading:** Transport settings (`password`, `server`, `port`)
 * trigger {@link Connection.reload} to reconnect the RSocket client with the
 * new endpoint. This ensures the live session picks up changes immediately
 * without requiring a CLI restart.
 *
 * **Model selection delegation:** Subagent model picking (`/set subagent`)
 * is delegated to {@link handleSetModel}, which may prompt interactively
 * if model choices need clarification. The primary agent's model is picked
 * via the separate top-level `/model` command (`commands/index.ts`).
 *
 * @see {@link Connection} for reconnection semantics
 * @see {@link config} for the persistent configuration structure
 */

import { loadConfig, updateConfig } from "../config/index.js";
import type { PromptPort } from "../ui/promptPort.js";
import type { Connection } from "../connection/index.js";
import { getTheme } from "../theme/themeManager.js";
import { printConfig, printError, printSuccess } from "../renderer.js";
import { parsePort } from "./utils.js";
import { logger } from "../utils/logger.js";

/**
 * Handles the `/agent cap [n|::max]` command — sets or displays the
 * maximum number of agents that can run in parallel.
 *
 * @remarks
 * The agent concurrency cap controls resource usage when multiple agents
 * spawn in a single task. Higher caps enable more parallelism but consume
 * more CPU/memory; lower caps serialize work but stay lean.
 *
 * **Invocation modes:**
 * - `/agent` or `/agent cap` (no value) → display current `subagentCap`
 * - `/agent cap 4` → set cap to 4
 * - `/agent cap ::max` → set cap to `Number.MAX_SAFE_INTEGER` (unbounded)
 * - `/agent <anything-else>` → print usage and return
 *
 * **Parsing:** Non-`::max` values are parsed as integers, floored (so `3.9` becomes 3),
 * and clamped to at least 1. Invalid input prints an error and returns early.
 *
 * @param sub - Subcommand after `/agent`. Should be `"cap"` for setting, or empty
 *   to display. Any other value triggers an error.
 * @param arg - The value to set when `sub === "cap"`. Ignored if `sub` is empty
 *   or unrecognized.
 *
 * @example
 * ```ts
 * handleAgent("", "");          // prints "Agent cap: 3"
 * handleAgent("cap", "");       // prints "Agent cap: 3"
 * handleAgent("cap", "8");      // sets to 8, prints "Agent cap set to 8"
 * handleAgent("cap", "::max");  // unbounded, prints "Agent cap set to unlimited"
 * handleAgent("invalid", "");   // prints usage error
 * ```
 */
export const handleAgent = (sub: string, arg: string): void => {
  // Reject unknown subcommands — only "cap" is valid, or empty (display mode).
  if (sub !== "cap" && sub.length > 0) {
    printError("Usage: /agent cap [n]  ( default is 3; ::max for no cap)");
    return;
  }

  // Extract the cap value: present only when sub === "cap", otherwise display mode.
  const capArgument = sub === "cap" ? arg.trim() : "";

  // Display mode: no value provided, show the current cap.
  if (capArgument.length === 0) {
    const currentConfig = loadConfig();
    printSuccess(`Agent cap: ${currentConfig.subagentCap} (use ::max for no cap)`);
    return;
  }

  // Handle the unbounded-cap sentinel before numeric parsing.
  if (capArgument === "::max") {
    updateConfig({ subagentCap: Number.MAX_SAFE_INTEGER });
    printSuccess("Agent cap set to unlimited (::max)");
    return;
  }

  // Try to parse as an integer. parseInt doesn't distinguish "not a number"
  // from parse failures, so we check isFinite to catch NaN.
  const parsedCapValue = parseInt(capArgument, 10);
  if (!Number.isFinite(parsedCapValue)) {
    printError("Agent cap must be a number.");
    return;
  }

  // Enforce a minimum of 1 agent and floor fractional inputs. This ensures
  // the cap never drops to 0 (deadlock) and treats "3.9" as 3 rather than
  // truncating inconsistently later in the agent dispatcher.
  const finalCapValue = Math.max(1, Math.floor(parsedCapValue));
  updateConfig({ subagentCap: finalCapValue });
  printSuccess(`Agent cap set to ${finalCapValue}`);
};

/**
 * Runtime dependencies that {@link handleSet} requires to complete its work.
 *
 * @remarks
 * These are passed as a single object to keep the function signature stable
 * as features grow. The connection and prompt port are tightly coupled to
 * the REPL environment, while `handleSetModel` is plugged in by the command
 * router to avoid circular dependencies.
 */
export type HandleSetDeps = {
  /**
   * Live RSocket connection to the AtlasAgents agent server.
   *
   * @remarks
   * When password, server, or port settings change, this connection is
   * reloaded to establish a new client session with the updated endpoint
   * or credentials. Reloading happens synchronously after the config is
   * persisted, so the next command uses the new transport settings.
   *
   * @see {@link Connection.reload}
   */
  connection: Connection;

  /**
   * Interactive prompt port for asking users for input.
   *
   * @remarks
   * Used when `/set` is invoked without inline arguments. The port
   * supports masking for password input (though it warns that masking
   * may be limited in REPL mode). All prompts show a leading `  ` indent
   * for visual consistency in the CLI.
   */
  prompts: PromptPort;

  /**
   * Callback to handle model selection for the agent or subagent role.
   *
   * @remarks
   * Called when the user runs `/set subagent` (the agent role instead goes
   * through the top-level `/model` command, bypassing `handleSet` entirely).
   * Responsibility for the interactive flow (menu, validation, persistence)
   * is delegated here to avoid circular imports and keep model-picking logic
   * centralized in the model handlers module.
   *
   * @param role - Either `"agent"` or `"subagent"`, determining which config
   *   field gets updated.
   *
   * @see {@link handleSetModel} in `modelSelectionHandlers.ts`
   */
  handleSetModel: (role: "agent" | "subagent") => Promise<void>;
};

/**
 * Handles the `/set` command — persists configuration changes and reloads
 * the connection if transport settings were modified.
 *
 * @remarks
 * The `/set` command supports connection credentials (`password`, `server`,
 * `port`) and subagent model selection (`subagent`) — the primary agent's
 * model is picked via the top-level `/model` command instead. Transport
 * settings trigger an immediate {@link Connection.reload} to reconnect with the
 * new endpoint or credentials, ensuring the next command sees the updated config.
 * Model settings are delegated to {@link handleSetModel} for interactive selection.
 *
 * **Input modes:** Inline arguments are preferred (e.g., `/set port 7000`).
 * If omitted, the user is prompted with defaults. Password input uses a masked
 * prompt when available, though masking is limited in a REPL environment
 * (a warning is displayed).
 *
 * **Validation:** Port values are validated via {@link parsePort} to ensure
 * they are integers in the valid range (1–65535). Invalid input prints an
 * error and returns without persisting.
 *
 * @param sub - Setting name. Must be one of:
 *   - `"password"` — agent server auth token
 *   - `"server"` — RSocket endpoint hostname (default: localhost)
 *   - `"port"` — RSocket endpoint port (default: 7000)
 *   - `"subagent"` — subagent model selector (agent role: use `/model`)
 *   Pass empty string to show usage.
 * @param arg - Optional inline value for the setting. Ignored if the setting
 *   does not accept arguments (e.g., `subagent`).
 * @param deps - Runtime dependencies: connection, prompt helpers, and the
 *   model-selection callback.
 *
 * @example
 * ```ts
 * // Inline argument
 * await handleSet("port", "7000", deps);
 *
 * // Prompted (empty arg)
 * await handleSet("server", "", deps);
 *
 * // Model selection (no arg used)
 * await handleSet("subagent", "", deps);
 * ```
 */
export const handleSet = async (
  sub: string,
  arg: string,
  deps: HandleSetDeps,
): Promise<void> => {
  const { connection, prompts, handleSetModel } = deps;

  // Validate that a setting name was provided.
  if (!sub) {
    printError(
      "Usage: /set password [value] | /set server [host] | /set port [n] | /set subagent",
    );
    return;
  }

  switch (sub) {
    case "password": {
      // Try to use the inline value if present, otherwise prompt.
      let passwordValue = arg.trim().length > 0 ? arg.trim() : "";

      if (!passwordValue) {
        // Warn the user that password echo may be visible in REPL mode,
        // since the prompts library's masking works better with real terminals
        // than with readline-based REPL input.
        logger.info(
          `${getTheme().textSecondary}  Password echo is visible in the REPL (masked input needs no readline).${getTheme().reset}`,
        );
        passwordValue = (
          await prompts.question("  New password: ", { masked: true })
        ).trimEnd();
      }

      // Persist the password and reload the connection to authenticate
      // with the new credentials on the next request.
      const updatedConfig = updateConfig({ password: passwordValue });
      await connection.reload(updatedConfig);
      printSuccess("Password updated.");
      break;
    }

    case "server": {
      // Extract the inline value or prompt if empty.
      let serverHost = arg.trim();

      if (!serverHost) {
        const userInput = await prompts.question(
          "  Enter server address (default localhost): ",
        );
        // Default to localhost if the user enters nothing.
        serverHost = userInput.trim() || "localhost";
      }

      // Persist and reconnect with the new server address.
      const updatedConfig = updateConfig({ server: serverHost });
      await connection.reload(updatedConfig);
      printSuccess(`Server set to ${serverHost}`);
      break;
    }

    case "port": {
      let portNumber: number | null = null;
      const inlinePortArgument = arg.trim();

      if (inlinePortArgument.length > 0) {
        // Validate the inline port string using parsePort, which checks bounds.
        portNumber = parsePort(inlinePortArgument);
      } else {
        // Prompt the user, defaulting to 7000 if they enter nothing.
        const userInput = await prompts.question(
          "  Enter port (default 7000): ",
        );
        const trimmedInput = userInput.trim();
        // 7000 is the conventional AtlasAgents agent server port; use it as default.
        portNumber = trimmedInput.length === 0 ? 7000 : parsePort(trimmedInput);
      }

      // Reject invalid ports (out of range, non-integer, etc.).
      if (portNumber === null) {
        printError("Port must be an integer between 1 and 65535.");
        return;
      }

      // Persist and reconnect with the new port.
      const updatedConfig = updateConfig({ port: portNumber });
      await connection.reload(updatedConfig);
      printSuccess(`Port set to ${portNumber}`);
      break;
    }

    case "subagent": {
      // Delegate the interactive model-selection flow to the model handlers,
      // which own the logic for prompting and validating model choices.
      await handleSetModel(sub);
      break;
    }

    default: {
      // Reject unknown settings and remind the user of valid options.
      printError(
        "Unknown /set subcommand. Use: password, server, port, or subagent.",
      );
      break;
    }
  }
};

/**
 * Handles the `/config` command — displays the current configuration state
 * in a formatted table.
 *
 * @remarks
 * This is a read-only operation that loads the persistent configuration
 * from disk and renders it in a human-readable format. Use this to inspect
 * the current settings (model choices, port, server, password mask, etc.)
 * without making changes. To modify any setting, use `/set`.
 *
 * @example
 * ```ts
 * await handleConfig();
 * prints a table like:
 *  ┌─ AtlasAgents Config ──────────────────────┐
 *  │ agent: gemma4                           │
 *  │ port: 7000                              │
 *  │ ...                                     │
 *  └─────────────────────────────────────────┘
 * ```
 *
 * @see {@link handleSet} to update any of these values
 */
export const handleConfig = async (): Promise<void> => {
  // Load the persistent config from disk (no live connection changes needed here).
  const currentConfig = loadConfig();
  // Render the config as a formatted table.
  printConfig(currentConfig);
};
