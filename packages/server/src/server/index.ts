#!/usr/bin/env node

/**
 * LoopyCode server — RSocket TCP entry point.
 *
 * @remarks
 * This is the main entry point for the LoopyCode server. It handles:
 * - Interactive startup prompts (password and port)
 * - Ollama connectivity verification
 * - Application container initialization
 * - RSocket server startup and client connection management
 *
 * Run with: `node dist/index.js` or `loopy-server`
 */

import * as readline from "node:readline";
import type { RSocket } from "@rsocket/core";
import { AuthMiddleware } from "../auth/middleware.js";
import { ConfigError, ConfigManager } from "../config/configManager/index.js";
import { createContainer } from "../container/index.js";
import { installUserDataDefaults } from "../setup/installUserDataDefaults.js";
import { RSocketServer } from "./rsocket/rsocketServer.js";
import {
  certificateExpiry,
  loadOrCreateServerCert,
} from "./tls/certificateStore.js";
import { describeCertExpiry, runCertRegen } from "./tls/certRegen.js";
import { ensureOllamaRunning } from "../ollama/lifecycle.js";
import {
  syncAgentToolSupport,
  syncSubagentToolSupport,
} from "../ollama/syncAgentToolSupport.js";
import { cleanupOldSnapshots } from "../workspace/cleanup/snapshotCleanup.js";
import { logger } from "../utils/logger.js";

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
 * Prompts for a password/passphrase with masked echo when stdin is a TTY.
 *
 * @remarks
 * In TTY environments, enables raw mode for character-by-character input
 * and displays bullet points (•) instead of actual characters for security.
 * In non-TTY environments (e.g., piped input), falls back to plain readline.
 *
 * Handles Enter to submit and Backspace to delete. Returns the password
 * as a plain string (may be empty).
 *
 * Reused for two independent prompts — the RSocket client-auth password and
 * the config-encryption passphrase — hence the configurable `label`; see the
 * module doc for why those two secrets are deliberately not derived from
 * each other.
 *
 * @param label - Prompt text printed before input; defaults to the
 *   client-auth password prompt.
 * @returns Password/passphrase string entered by the user
 */
const readPasswordAtStartup = (
  label = "Enter server password: ",
): Promise<string> => {
  const stdout = process.stdout;
  const stdin = process.stdin;

  stdout.write(label);

  // Non-TTY environment (e.g., piped input) - use plain readline
  if (!stdin.isTTY) {
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

  // TTY environment - use raw mode for character-by-character input with masking
  return new Promise((resolve, reject) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let password = "";

    // Restore TTY state on completion or error
    const cleanup = () => {
      try {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
      } catch (error) {
        // Log cleanup errors to stderr for debugging
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error restoring TTY state: ${errorMessage}\n`);
      }
    };

    const onData = (chunk: string | Buffer) => {
      try {
        const chunkString =
          typeof chunk === "string" ? chunk : chunk.toString("utf8");

        for (const character of chunkString) {
          const characterCode = character.charCodeAt(0);

          // Enter key or Ctrl-D submits the password
          if (character === "\n" || character === "\r" || characterCode === 4) {
            cleanup();
            stdout.write("\n");
            resolve(password);
            return;
          }

          // Backspace or delete removes the last character
          if (characterCode === 127 || character === "\b") {
            if (password.length > 0) {
              password = password.slice(0, -1);
              stdout.write("\b \b"); // Move back, overwrite with space, move back again
            }
            continue;
          }

          // Regular character - add to password and display bullet point
          password += character;
          stdout.write("•");
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    try {
      stdin.on("data", onData);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
};

/**
 * Prompts for TCP listen port with default 7000 when input is empty or invalid.
 *
 * @remarks
 * Validates that the port is within the valid TCP port range (1-65535).
 * If the input is empty, not a number, or out of range, returns the default
 * port 7000. This provides a safe fallback for invalid user input.
 *
 * @param readlineInterface - Readline interface for prompting the user
 * @returns Valid port number in range 1-65535
 */
const promptListenPort = (
  readlineInterface: readline.Interface,
): Promise<number> => {
  return new Promise((resolve) => {
    readlineInterface.question("Enter port (default 7000): ", (answer) => {
      const trimmedAnswer = answer.trim();

      // Empty input uses default port
      if (trimmedAnswer.length === 0) {
        resolve(7000);
        return;
      }

      const parsedPort = parseInt(trimmedAnswer, 10);

      // Validate port is within valid TCP range (1-65535)
      if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
        resolve(7000); // Invalid input falls back to default
        return;
      }

      resolve(parsedPort);
    });
  });
};

/**
 * Runs interactive startup prompts for password and port.
 *
 * @remarks
 * Prompts the user for server password (with masked input) and TCP listen port.
 * Returns both values as a configuration object for server initialization.
 * Ensures the readline interface is properly closed in a finally block.
 *
 * @returns Object containing password and port for server startup
 */
const runServerStartupPrompts = async (): Promise<{
  password: string;
  port: number;
}> => {
  const password = await readPasswordAtStartup();

  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const port = await promptListenPort(readlineInterface);
    return { password, port };
  } finally {
    readlineInterface.close();
  }
};

/**
 * Main entry point for the LoopyCode server.
 *
 * @remarks
 * Orchestrates the complete server startup sequence:
 * 1. Parses command line arguments (help flag)
 * 2. Runs interactive prompts for password and port
 * 3. Installs default user data and configuration
 * 4. Verifies Ollama service is running and accessible
 * 5. Initializes authentication middleware with password
 * 6. Creates application container with all services
 * 7. Cleans up old workspace snapshots
 * 8. Schedules periodic memory consolidation
 * 9. Verifies Ollama has models installed
 * 10. Checks agent and subagent model configuration
 * 11. Builds request router with all handlers
 * 12. Creates and starts RSocket server
 * 13. Logs successful startup and waits for connections
 *
 * The server runs until SIGINT or process exit. Any error during startup
 * is caught and logged before exiting with a failure code.
 */
const main = async (): Promise<void> => {
  // Command line argument parsing
  const commandLineArgs = process.argv.slice(2);

  // Handle help flag
  if (
    commandLineArgs[0] === "help" ||
    commandLineArgs[0] === "--help" ||
    commandLineArgs[0] === "-h"
  ) {
    logger.info(`Usage:
  loopy-server [start]     Interactive startup, then listen for RSocket clients
  loopy-server --regen-cert Rotate the TLS certificate (asks for confirmation)`);
    return;
  }

  // --regen-cert rotates the TLS certificate and exits — no server password
  // prompt, no Ollama check, no listening. Checked by inclusion rather than
  // position so `loopy-server start --regen-cert` also works.
  if (commandLineArgs.includes("--regen-cert")) {
    await runCertRegen(process.cwd());
    return;
  }

  // Validate command argument
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

  // Interactive startup prompts
  const { password, port } = await runServerStartupPrompts();

  // An empty password would let every client authenticate automatically.
  // Every server start requires a real password — no unauthenticated mode.
  if (password.trim().length === 0) {
    logger.error(
      "No password set. The server would accept every client without " +
        "authentication, exposing file and shell access to anyone who can " +
        "reach this port. Restart and set a password.",
    );
    process.exit(1);
  }

  // Install default user data and configuration files
  await installUserDataDefaults(process.cwd());

  // Only bootstrap local Ollama when at least one role is actually configured
  // to use the "ollama" provider — a pure vLLM/Trainium/TPU deployment has no
  // local Ollama to start or connect to.
  const configPreview = new ConfigManager({ rootDir: process.cwd() });

  // Unlock (or set up) the cipher protecting provider API keys at rest.
  // Must happen before ANY ConfigManager read/write — getAgentProvider()
  // right below is the very first such call.
  await configPreview.unlockOrSetupProvidersCipher(readPasswordAtStartup);

  const usesOllamaProvider =
    (await configPreview.getAgentProvider()) === "ollama" ||
    (await configPreview.getSubagentProvider()) === "ollama";

  if (usesOllamaProvider) {
    // Verify Ollama connectivity
    const ollamaBaseUrl = OLLAMA_TAGS_URL.replace(/\/api\/tags$/, "");
    process.stdout.write(`Connecting to Ollama at ${ollamaBaseUrl}...`);

    try {
      const ollamaLifecycle = await ensureOllamaRunning(OLLAMA_TAGS_URL);
      if (ollamaLifecycle.startedByServer) {
        process.stdout.write(" started");
      }
    } catch (error) {
      process.stdout.write("\n");
      logger.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }

    process.stdout.write(" ✓\n");
  } else {
    logger.info(
      "Skipping local Ollama bootstrap — no role is configured to use the 'ollama' provider.",
    );
  }

  // Initialize authentication middleware
  const auth = new AuthMiddleware(password);

  // Create application container with all services
  const app = createContainer({
    dataRoot: process.cwd(),
    workspaceRoot: process.cwd(),
    ollamaBaseUrl: OLLAMA_TAGS_URL.replace(/\/api\/tags$/, ""),
    getClientPeer: (requesterId) => clientPeers.get(requesterId),
  });

  // Configure Ollama client timeout from configuration
  app.ollama.setTimeoutMs(await app.config.getTimeout());

  // Clean up old workspace snapshots (older than 24 hours)
  const removedSnapshotsCount = await cleanupOldSnapshots(process.cwd());
  if (removedSnapshotsCount > 0) {
    logger.info(
      `Cleaned up ${removedSnapshotsCount} snapshot(s) older than 24h`,
    );
  }

  // Schedule periodic memory consolidation
  app.scheduleConsolidation();

  // Verify Ollama has models installed (only when a role actually uses it)
  if (usesOllamaProvider) {
    const installedModels = await app.ollama.listModels();
    if (installedModels.length === 0) {
      logger.error("No models installed. Run: ollama pull <modelname>");
      process.exit(1);
    }
  }

  // Check agent model configuration
  try {
    const agentModel = await app.config.getAgentModel();
    const agentProvider = await app.config.getAgentProvider();
    const agentAdmin = await app.providerRegistry.getAdmin(agentProvider);
    await syncAgentToolSupport(agentAdmin, app.config, agentModel);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.warn(
        "No agent model configured. Connect a client and run /set agent",
      );
    } else {
      throw error;
    }
  }

  // Check subagent model configuration
  try {
    const subagentModel = await app.config.getSubagentModel();
    const subagentProvider = await app.config.getSubagentProvider();
    const subagentAdmin = await app.providerRegistry.getAdmin(subagentProvider);
    await syncSubagentToolSupport(subagentAdmin, app.config, subagentModel);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.warn(
        "No subagent model configured. Connect a client and run /set subagent",
      );
    } else {
      throw error;
    }
  }

  // Build request router with all handlers
  const router = app.buildRouter();

  // Load (or generate, on first run) the server's TLS certificate. Every
  // connection is TLS 1.3; there is no plaintext fallback.
  const cert = await loadOrCreateServerCert(process.cwd());

  // Never auto-rotate on expiry — that would change every client's expected
  // fingerprint without their consent. Warn ahead of time, refuse once truly
  // expired, and point at the explicit `--regen-cert` flow either way.
  const expiry = describeCertExpiry(certificateExpiry(cert));
  if (expiry.status === "expired") {
    logger.error(
      "TLS certificate has expired. Refusing to start.\n" +
        "Run: loopy-server --regen-cert",
    );
    process.exit(1);
  }
  if (expiry.status === "warning") {
    logger.warn(
      `TLS certificate expires in ${expiry.daysRemaining} day(s). Run: loopy-server --regen-cert`,
    );
  }

  // Create RSocket server with connection cleanup callback
  const server = new RSocketServer(
    port,
    auth,
    router,
    // Cleanup per-connection resources when client disconnects
    (requesterId) => {
      const perConnection = app.brokerByRequester.get(requesterId);
      if (perConnection) {
        perConnection.planBroker.dispose();
        perConnection.workspace.dispose();
        perConnection.terminal.dispose();
        app.brokerByRequester.delete(requesterId);
      }
    },
    clientPeers,
    cert,
  );

  // Start the RSocket server
  await server.start();

  logger.info(`Server started on port ${port} (TLS 1.3)`);
  logger.info(`Certificate fingerprint: ${cert.fingerprint256}`);
  logger.info(
    "Share this fingerprint with clients out-of-band so they can verify it on first connect.",
  );
  logger.info("Waiting for connections...");
};

// Global error handler for the main function
// Catches any unhandled errors during server startup or operation
void main().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error(errorMessage);
  process.exit(1);
});
