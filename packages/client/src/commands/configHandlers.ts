/**
 * <Summary>
 * What it does:
 *   Provides command handlers for managing LoopyCode configuration settings
 *   including connection parameters, model selection, and agent concurrency.
 *
 * How it fits in the system:
 *   Sits between the CLI command parser (CommandHandler) and the config/storage
 *   layer. Centralises all configuration-related command logic so changes to
 *   config structure only require updates to this module.
 *
 * Dependencies:
 *   - config.js — loadConfig, updateConfig for reading and writing config.
 *   - renderer.js — printError, printSuccess, printConfig for user feedback.
 *   - connection/index.js — Connection class for reloading connections.
 *   - themeManager.js — getTheme for terminal colors.
 *   - utils.js — parsePort for port validation.
 *
 * Dependants:
 *   - CommandHandler.handle — routes /set, /config, and /agent commands here.
 * </Summary>
 */

import { loadConfig, updateConfig } from "../config.js";
import type { PromptPort } from "../ui/promptPort.js";
import type { Connection } from "../connection/index.js";
import { getTheme } from "../theme/themeManager.js";
import { printError, printSuccess } from "../renderer.js";
import { parsePort } from "./utils.js";
import { logger } from "../utils/logger.js";

/**
 * <Summary>
 * What it does:
 *   Handles the "/agent cap" command to set or display the maximum number
 *   of agents that can work on a task simultaneously.
 *
 * How it does it (step by step):
 *   1. Validates that the subcommand is either "cap" or empty string.
 *   2. If subcommand is invalid, prints usage error and returns.
 *   3. Extracts the cap argument from the arg parameter if subcommand is "cap".
 *   4. If no argument provided, loads current config and displays current cap.
 *   5. If argument is "::max", sets cap to unlimited (MAX_SAFE_INTEGER).
 *   6. Otherwise, parses argument as a number and validates it's finite.
 *   7. Ensures cap is at least 1 and floors decimal values.
 *   8. Updates config with new cap value and prints success message.
 *
 * Parameters:
 *   @param {string} sub — The subcommand after "/agent" (e.g., "cap" or empty).
 *   @param {string} arg — The argument value for the cap (number or "::max").
 *
 * Returns:
 *   void — called for side effects only (config update and user feedback).
 *
 * Dependencies:
 *   - loadConfig — reads current agentCap from config.json.
 *   - updateConfig — writes new agentCap to config.json.
 *   - printError — displays error messages to user.
 *   - printSuccess — displays success messages to user.
 *
 * Dependants:
 *   - CommandHandler.handle — routes "/agent cap" commands to this handler.
 * </Summary>
 */
export const handleAgent = (sub: string, arg: string): void => {
  // ===== STEP 1: Validate Subcommand =====
  // Step 1a: Check if subcommand is either "cap" or empty string
  // Step 1b: If subcommand is something else, show usage error
  if (sub !== "cap" && sub.length > 0) {
    printError("Usage: /agent cap [n]  ( default is 3; ::max for no cap)");
    return;
  }

  // ===== STEP 2: Extract Cap Argument =====
  // Step 2a: If subcommand is "cap", use the arg parameter
  // Step 2b: Otherwise, treat as display mode (empty argument)
  const capArgument = sub === "cap" ? arg.trim() : "";

  // ===== STEP 3: Handle Display Mode (No Argument) =====
  // Step 3a: Check if no argument was provided
  if (capArgument.length === 0) {
    // Step 3b: Load current configuration from disk
    const currentConfig = loadConfig();

    // Step 3c: Display current agent cap to user
    printSuccess(`Agent cap: ${currentConfig.agentCap} (use ::max for no cap)`);
    return;
  }

  // ===== STEP 4: Handle Unlimited Cap (::max) =====
  // Step 4a: Check if argument is the special "::max" token
  if (capArgument === "::max") {
    // Step 4b: Set cap to maximum safe integer (effectively unlimited)
    updateConfig({ agentCap: Number.MAX_SAFE_INTEGER });

    // Step 4c: Display success message to user
    printSuccess("Agent cap set to unlimited (::max)");
    return;
  }

  // ===== STEP 5: Parse Numeric Cap Value =====
  // Step 5a: Parse the argument as a base-10 integer
  const parsedCapValue = parseInt(capArgument, 10);

  // Step 5b: Validate that the parsed value is a finite number
  if (!Number.isFinite(parsedCapValue)) {
    printError("Agent cap must be a number.");
    return;
  }

  // ===== STEP 6: Validate and Apply Cap Value =====
  // Step 6a: Ensure cap is at least 1 (minimum of 1 agent required)
  // Step 6b: Floor decimal values to get integer
  const finalCapValue = Math.max(1, Math.floor(parsedCapValue));

  // Step 6c: Update configuration with the validated cap value
  updateConfig({ agentCap: finalCapValue });

  // Step 6d: Display success message showing the new cap
  printSuccess(`Agent cap set to ${finalCapValue}`);
};

/**
 * <Summary>
 * What it does:
 *   Handles the "/set" command to update configuration settings including
 *   password, server address, port number, and model selection for advisor/agent.
 *
 * How it does it (step by step):
 *   1. Validates that a subcommand was provided (password, server, port, advisor, agent).
 *   2. If no subcommand, prints usage error and returns.
 *   3. For password: uses inline argument or prompts with masked input, updates config, reloads connection.
 *   4. For server: uses inline argument or prompts for host, updates config, reloads connection.
 *   5. For port: uses inline argument or prompts for port number, validates, updates config, reloads connection.
 *   6. For advisor/agent: delegates to handleSetModel for interactive model selection.
 *   7. For unknown subcommand: prints error message.
 *
 * Parameters:
 *   @param {string} sub — The subcommand after "/set" (password, server, port, advisor, agent).
 *   @param {string} arg — The argument value for the subcommand (often empty for prompts).
 *   @param {Connection} connection — The RSocket connection instance for reloading.
 *   @param {PromptPort} prompts — The prompt interface for user input.
 *   @param {(role: "advisor" | "agent") => Promise<void>} handleSetModel — Callback to handle model selection.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when configuration update is complete.
 *
 * Dependencies:
 *   - updateConfig — writes new configuration values to config.json.
 *   - Connection.reload — reconnects to server with new configuration.
 *   - parsePort — validates port number is in valid range (1-65535).
 *   - printError, printSuccess — displays feedback to user.
 *   - getTheme — retrieves terminal color theme.
 *   - handleSetModel — handles interactive model selection for advisor/agent.
 *
 * Dependants:
 *   - CommandHandler.handle — routes "/set" commands to this handler.
 * </Summary>
 */
export const handleSet = async (
  sub: string,
  arg: string,
  connection: Connection,
  prompts: PromptPort,
  handleSetModel: (role: "advisor" | "agent") => Promise<void>,
): Promise<void> => {
  // ===== STEP 1: Validate Subcommand =====
  // Step 1a: Check if a subcommand was provided
  if (!sub) {
    // Step 1b: If no subcommand, print usage error and return
    printError(
      "Usage: /set password [value] | /set server [host] | /set port [n] | /set advisor | /set agent",
    );
    return;
  }

  // ===== STEP 2: Route to Subcommand Handler =====
  // Step 2a: Switch on subcommand to determine which setting to update
  switch (sub) {
    // ===== CASE: Password =====
    case "password": {
      // ===== STEP 2a-i: Get Password Value =====
      // Step 2a-i-1: Use inline argument if provided, otherwise start with empty string
      let passwordValue = arg.trim().length > 0 ? arg.trim() : "";

      // Step 2a-i-2: If no inline argument, prompt user for password
      if (!passwordValue) {
        // Step 2a-i-3: Display warning about password visibility in REPL
        logger.info(
          `${getTheme().textSecondary}  Password echo is visible in the REPL (masked input needs no readline).${getTheme().reset}`,
        );

        // Step 2a-i-4: Prompt for password with masked input
        passwordValue = (
          await prompts.question("  New password: ", { masked: true })
        ).trimEnd();
      }

      // ===== STEP 2a-ii: Update Configuration =====
      // Step 2a-ii-1: Update config with new password value
      const updatedConfig = updateConfig({ password: passwordValue });

      // Step 2a-ii-2: Reload connection with new configuration
      await connection.reload(updatedConfig);

      // Step 2a-ii-3: Display success message
      printSuccess("Password updated.");
      break;
    }

    // ===== CASE: Server =====
    case "server": {
      // ===== STEP 2b-i: Get Server Host Value =====
      // Step 2b-i-1: Use inline argument if provided, otherwise start with empty string
      let serverHost = arg.trim();

      // Step 2b-i-2: If no inline argument, prompt user for server address
      if (!serverHost) {
        // Step 2b-i-3: Prompt for server address with default hint
        const userInput = await prompts.question(
          "  Enter server address (default localhost): ",
        );

        // Step 2b-i-4: Use trimmed input or default to localhost
        serverHost = userInput.trim() || "localhost";
      }

      // ===== STEP 2b-ii: Update Configuration =====
      // Step 2b-ii-1: Update config with new server host
      const updatedConfig = updateConfig({ server: serverHost });

      // Step 2b-ii-2: Reload connection with new configuration
      await connection.reload(updatedConfig);

      // Step 2b-ii-3: Display success message with new server
      printSuccess(`Server set to ${serverHost}`);
      break;
    }

    // ===== CASE: Port =====
    case "port": {
      // ===== STEP 2c-i: Get Port Number Value =====
      // Step 2c-i-1: Initialize port number as null (not yet determined)
      let portNumber: number | null = null;

      // Step 2c-i-2: Get inline port argument
      const inlinePortArgument = arg.trim();

      // Step 2c-i-3: If inline argument provided, parse it
      if (inlinePortArgument.length > 0) {
        // Step 2c-i-4: Parse and validate the port number
        portNumber = parsePort(inlinePortArgument);
      } else {
        // Step 2c-i-5: Otherwise, prompt user for port number
        const userInput = await prompts.question(
          "  Enter port (default 7000): ",
        );
        const trimmedInput = userInput.trim();

        // Step 2c-i-6: Use default 7000 if empty, otherwise parse input
        portNumber = trimmedInput.length === 0 ? 7000 : parsePort(trimmedInput);
      }

      // ===== STEP 2c-ii: Validate Port Number =====
      // Step 2c-ii-1: Check if port parsing failed (returned null)
      if (portNumber === null) {
        printError("Port must be an integer between 1 and 65535.");
        return;
      }

      // ===== STEP 2c-iii: Update Configuration =====
      // Step 2c-iii-1: Update config with new port number
      const updatedConfig = updateConfig({ port: portNumber });

      // Step 2c-iii-2: Reload connection with new configuration
      await connection.reload(updatedConfig);

      // Step 2c-iii-3: Display success message with new port
      printSuccess(`Port set to ${portNumber}`);
      break;
    }

    // ===== CASE: Advisor or Agent Model =====
    case "advisor":
    case "agent": {
      // ===== STEP 2d-i: Route to Model Picker =====
      // Step 2d-i-1: Delegate to handleSetModel for interactive model selection
      await handleSetModel(sub);
      break;
    }

    // ===== CASE: Unknown Subcommand =====
    default: {
      // ===== STEP 2e-i: Display Error =====
      // Step 2e-i-1: Print error for unrecognized subcommand
      printError(
        "Unknown /set subcommand. Use: password, server, port, advisor, or agent.",
      );
      break;
    }
  }
};

/**
 * <Summary>
 * What it does:
 *   Handles the "/config" command by loading the current configuration
 *   from disk and displaying it in a formatted table to the user.
 *
 * How it does it (step by step):
 *   1. Loads the configuration object from config.json using loadConfig.
 *   2. Dynamically imports the printConfig function from renderer module.
 *   3. Calls printConfig with the loaded configuration object.
 *   4. The printConfig function formats and displays the config as a table.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   void — called for side effects only (displaying config to user).
 *
 * Dependencies:
 *   - loadConfig — reads the current configuration from config.json file.
 *   - renderer.printConfig — formats and displays configuration in a table.
 *
 * Dependants:
 *   - CommandHandler.handle — routes "/config" commands to this handler.
 * </Summary>
 */
export const handleConfig = async (): Promise<void> => {
  // ===== STEP 1: Load Configuration =====
  // Step 1a: Read current configuration from disk (config.json)
  const currentConfig = loadConfig();

  // ===== STEP 2: Display Configuration =====
  // Step 2a: Dynamically import printConfig function from renderer module
  // (dynamic import to avoid circular dependency issues)
  const { printConfig } = await import("../renderer.js");

  // Step 2b: Format and display configuration as a table to user
  printConfig(currentConfig);
};
