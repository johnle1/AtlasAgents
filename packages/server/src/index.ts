#!/usr/bin/env node

/**
 * =============================================================================
 * LoopyCode server — RSocket TCP entry point
 * =============================================================================
 * This is the main entry point for the LoopyCode server. It handles:
 * - Interactive startup prompts (password and port)
 * - Ollama connectivity verification
 * - Application container initialization
 * - RSocket server startup and client connection management
 * =============================================================================
 */

import * as readline from "node:readline";
import type { RSocket } from "@rsocket/core";
import { AuthMiddleware } from "./auth/middleware.js";
import { ConfigError } from "./config/configManager.js";
import { createContainer } from "./container.js";
import { installUserDataDefaults } from "./installUserDataDefaults.js";
import { RSocketServer } from "./server/rsocket/rsocketServer.js";
import { ensureOllamaRunning } from "./ollama/lifecycle.js";
import { syncAdvisorToolSupport, syncAgentToolSupport } from "./ollama/syncAgentToolSupport.js";
import { cleanupOldSnapshots } from "./workspace/cleanup/snapshotCleanup.js";
import { logger } from "./logger.js";

// ===== CONSTANTS =====
/**
 * Ollama API endpoint for listing available models.
 * Used to verify Ollama connectivity and retrieve model information.
 */
const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";

/**
 * Map of active client connections by requester ID.
 * Stores RSocket connections for each connected client to enable
 * bidirectional communication and connection lifecycle management.
 */
const clientPeers = new Map<string, RSocket>();

/**
 * <Summary>
 * What it does:
 *   Prompts for the server password with masked echo when stdin is a TTY.
 *
 * How it does it (step by step):
 *   1. Check if stdin is a TTY (interactive terminal).
 *   2. If not TTY: use readline for plain text input.
 *   3. If TTY: enable raw mode for character-by-character input.
 *   4. Handle special keys: Enter to submit, Backspace to delete.
 *   5. Display bullet points (•) instead of actual characters.
 *   6. Return the collected password string.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns Password (may be empty for dev mode).
 * </Summary>
 */
const readPasswordAtStartup = (): Promise<string> => {
  // Step 1: Get references to standard input and output streams
  const stdout = process.stdout;
  const stdin = process.stdin;

  // Step 2: Display password prompt
  stdout.write("Enter server password: ");

  // Step 3: Check if stdin is a TTY (interactive terminal)
  if (!stdin.isTTY) {
    // Step 3a: Non-TTY environment (e.g., piped input)
    // Use readline interface for simple line-by-line input
    return new Promise((resolve, reject) => {
      const readlineInterface = readline.createInterface({
        input: stdin,
        output: stdout,
      });
      readlineInterface.question("", (inputLine) => {
        try {
          readlineInterface.close();
          resolve(inputLine.trimEnd());
        } catch (error) {
          readlineInterface.close();
          reject(error);
        }
      });
    });
  }

  // Step 4: TTY environment - use raw mode for character-by-character input
  return new Promise((resolve, reject) => {
    // Step 4a: Enable raw mode for direct character input
    stdin.setRawMode(true);

    // Step 4b: Resume stdin if it was paused
    stdin.resume();

    // Step 4c: Set encoding to UTF-8 for proper character handling
    stdin.setEncoding("utf8");

    // Step 4d: Initialize password accumulator
    let password = "";

    // Step 4e: Define cleanup function to restore TTY state
    const cleanup = () => {
      try {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
      } catch (e) {
        // Ignore cleanup errors to avoid masking original error
      }
    };

    // Step 4f: Define data handler for character input
    const onData = (chunk: string | Buffer) => {
      try {
        // Step 4f-1: Convert chunk to string if it's a Buffer
        const chunkString =
          typeof chunk === "string" ? chunk : chunk.toString("utf8");

        // Step 4f-2: Process each character in the chunk
        for (const character of chunkString) {
          const characterCode = character.charCodeAt(0);

          // Step 4f-3: Check for enter key (newline, carriage return, or Ctrl-D)
          if (character === "\n" || character === "\r" || characterCode === 4) {
            cleanup();
            stdout.write("\n");
            resolve(password);
            return;
          }

          // Step 4f-4: Check for backspace or delete key
          if (characterCode === 127 || character === "\b") {
            // Step 4f-4a: Only handle backspace if password has characters
            if (password.length > 0) {
              // Step 4f-4b: Remove last character from password
              password = password.slice(0, -1);

              // Step 4f-4c: Move cursor back, overwrite with space, move back again
              stdout.write("\b \b");
            }
            continue;
          }

          // Step 4f-5: Regular character - add to password and show bullet point
          password += character;
          stdout.write("•");
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    // Step 4g: Attach data handler to stdin with error handling
    try {
      stdin.on("data", onData);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
};

/**
 * <Summary>
 * What it does:
 *   Prompts for TCP listen port with default 7000 when input is empty or invalid.
 *
 * How it does it (step by step):
 *   1. Ask user for port number via readline interface.
 *   2. Trim whitespace from user input.
 *   3. If empty: return default port 7000.
 *   4. Parse as integer base 10.
 *   5. Validate port is in valid range (1-65535).
 *   6. If invalid: return default port 7000.
 *   7. If valid: return the parsed port number.
 *
 * Parameters:
 *   @param readlineInterface - Readline for one line of input.
 *
 * Returns:
 *   @returns Listen port in valid range.
 * </Summary>
 */
const promptListenPort = (
  readlineInterface: readline.Interface,
): Promise<number> => {
  return new Promise((resolve) => {
    // Step 1: Prompt user for port number with default value shown
    readlineInterface.question("Enter port (default 7000): ", (answer) => {
      // Step 2: Trim whitespace from user input
      const trimmedAnswer = answer.trim();

      // Step 3: If input is empty, use default port 7000
      if (trimmedAnswer.length === 0) {
        resolve(7000);
        return;
      }

      // Step 4: Parse input as integer (base 10)
      const parsedPort = parseInt(trimmedAnswer, 10);

      // Step 5: Validate port is within valid range (1-65535)
      if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
        // Step 5a: Invalid port - use default
        resolve(7000);
        return;
      }

      // Step 6: Valid port - return parsed value
      resolve(parsedPort);
    });
  });
};

/**
 * <Summary>
 * What it does:
 *   Runs password prompt, port prompt, and returns both values for server boot.
 *
 * How it does it (step by step):
 *   1. Prompt for server password using masked input.
 *   2. Create readline interface for port prompt.
 *   3. Prompt for TCP port number.
 *   4. Return both values as configuration object.
 *   5. Ensure readline interface is closed in finally block.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns Startup answers.
 * </Summary>
 */
const runServerStartupPrompts = async (): Promise<{
  password: string;
  port: number;
}> => {
  // Step 1: Prompt for server password with masked input
  const password = await readPasswordAtStartup();

  // Step 2: Create readline interface for port prompt
  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // Step 3: Prompt for TCP port number
    const port = await promptListenPort(readlineInterface);

    // Step 4: Return both configuration values
    return { password, port };
  } finally {
    // Step 5: Ensure readline interface is properly closed
    readlineInterface.close();
  }
};

/**
 * @async
 * <Summary>
 * What it does:
 *   Entry point: optional help, else interactive startup prompts, Ollama check,
 *   then RSocket server bind.
 *
 * How it does it (step by step):
 *   1. Parse command line arguments for help flag or unknown commands.
 *   2. Run interactive prompts for password and port.
 *   3. Install default user data and configuration.
 *   4. Verify Ollama service is running and accessible.
 *   5. Initialize authentication middleware with password.
 *   6. Create application container with all services.
 *   7. Clean up old workspace snapshots.
 *   8. Schedule periodic memory consolidation.
 *   9. Verify Ollama has models installed.
 *   10. Check advisor and agent model configuration.
 *   11. Build request router with all handlers.
 *   12. Create and start RSocket server.
 *   13. Log successful startup and wait for connections.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns Runs until SIGINT or process exit.
 * </Summary>
 */
const main = async (): Promise<void> => {
  // ===== COMMAND LINE ARGUMENT PARSING =====
  // Step 1: Get command line arguments (excluding node executable and script path)
  const commandLineArgs = process.argv.slice(2);

  // Step 2: Check for help flag
  if (
    commandLineArgs[0] === "help" ||
    commandLineArgs[0] === "--help" ||
    commandLineArgs[0] === "-h"
  ) {
    logger.info(`Usage:
  loopy-server [start]     Interactive startup, then listen for RSocket clients`);
    return;
  }

  // Step 3: Validate command is either empty, "start", or undefined
  if (
    commandLineArgs[0] !== undefined &&
    commandLineArgs[0] !== "" &&
    commandLineArgs[0] !== "start"
  ) {
    logger.error(
      `Unknown command: ${commandLineArgs[0]}. Try: loopy-server help`,
    );
    process.exit(1);
  }

  // ===== INTERACTIVE STARTUP PROMPTS =====
  // Step 4: Prompt user for server password and port
  const { password, port } = await runServerStartupPrompts();

  // ===== DATA INITIALIZATION =====
  // Step 5: Install default user data and configuration files
  await installUserDataDefaults(process.cwd());

  // ===== OLLAMA CONNECTIVITY CHECK =====
  // Step 6: Extract Ollama base URL from tags endpoint
  const ollamaBaseUrl = OLLAMA_TAGS_URL.replace(/\/api\/tags$/, "");

  // Step 7: Display connection message
  process.stdout.write(`Connecting to Ollama at ${ollamaBaseUrl}...`);

  try {
    // Step 8: Ensure Ollama service is running
    const ollamaLifecycle = await ensureOllamaRunning(OLLAMA_TAGS_URL);

    // Step 9: Check if server started Ollama (vs. already running)
    if (ollamaLifecycle.startedByServer) {
      process.stdout.write(" started");
    }
  } catch (error) {
    // Step 10: Handle Ollama connection failure
    process.stdout.write("\n");
    logger.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Step 11: Confirm successful Ollama connection
  process.stdout.write(" ✓\n");

  // ===== AUTHENTICATION SETUP =====
  // Step 12: Initialize authentication middleware with user-provided password
  const auth = new AuthMiddleware(password);

  // ===== APPLICATION CONTAINER CREATION =====
  // Step 13: Create application container with all required services
  const app = createContainer({
    dataRoot: process.cwd(),
    workspaceRoot: process.cwd(),
    ollamaBaseUrl: OLLAMA_TAGS_URL.replace(/\/api\/tags$/, ""),
    getClientPeer: (requesterId) => clientPeers.get(requesterId),
  });

  // Step 14: Configure Ollama client timeout from configuration
  app.ollama.setTimeoutMs(await app.config.getTimeout());

  // ===== WORKSPACE CLEANUP =====
  // Step 15: Remove old workspace snapshots (older than 24 hours)
  const removedSnapshotsCount = await cleanupOldSnapshots(process.cwd());
  if (removedSnapshotsCount > 0) {
    logger.info(
      `Cleaned up ${removedSnapshotsCount} snapshot(s) older than 24h`,
    );
  }

  // ===== MEMORY CONSOLIDATION SCHEDULING =====
  // Step 16: Schedule periodic memory consolidation tasks
  app.scheduleConsolidation();

  // ===== OLLAMA MODEL VERIFICATION =====
  // Step 17: List installed Ollama models
  const installedModels = await app.ollama.listModels();

  // Step 18: Ensure at least one model is installed
  if (installedModels.length === 0) {
    logger.error("No models installed. Run: ollama pull <modelname>");
    process.exit(1);
  }

  // ===== ADVISOR MODEL CONFIGURATION CHECK =====
  // Step 19: Verify advisor model is configured
  try {
    const advisorModel = await app.config.getAdvisorModel();
    await syncAdvisorToolSupport(app.ollama, app.config, advisorModel);
  } catch (error) {
    // Step 20: Handle missing advisor model configuration
    if (error instanceof ConfigError) {
      logger.warn(
        "No advisor model configured. Connect a client and run /set advisor",
      );
    } else {
      throw error;
    }
  }

  // ===== AGENT MODEL CONFIGURATION CHECK =====
  // Step 21: Verify agent model is configured
  try {
    const agentModel = await app.config.getAgentModel();
    await syncAgentToolSupport(app.ollama, app.config, agentModel);
  } catch (error) {
    // Step 22: Handle missing agent model configuration
    if (error instanceof ConfigError) {
      logger.warn(
        "No agent model configured. Connect a client and run /set agent",
      );
    } else {
      throw error;
    }
  }

  // ===== ROUTER CREATION =====
  // Step 23: Build request router with all command and stream handlers
  const router = app.buildRouter();

  // ===== RSOCKET SERVER CREATION =====
  // Step 24: Create RSocket server with connection cleanup callback
  const server = new RSocketServer(
    port,
    auth,
    router,
    // Connection cleanup callback
    (requesterId) => {
      // Step 24a: Get per-connection resources for this requester
      const perConnection = app.brokerByRequester.get(requesterId);

      // Step 24b: If connection exists, clean up resources
      if (perConnection) {
        // Step 24b-1: Dispose plan broker resources
        perConnection.planBroker.dispose();

        // Step 24b-2: Dispose workspace manager resources
        perConnection.workspace.dispose();

        // Step 24b-3: Dispose terminal executor resources
        perConnection.terminal.dispose();

        // Step 24b-4: Remove connection from active connections map
        app.brokerByRequester.delete(requesterId);
      }
    },
    clientPeers,
  );

  // ===== SERVER STARTUP =====
  // Step 25: Start the RSocket server
  await server.start();

  // Step 26: Log successful startup
  logger.info(`Server started on port ${port}`);
  logger.info("Waiting for connections...");
};

// ===== ERROR HANDLING =====
// Global error handler for the main function
// Catches any unhandled errors during server startup or operation
// Logs the error and exits with failure code
void main().catch((error) => {
  logger.error(error);
  process.exit(1);
});
