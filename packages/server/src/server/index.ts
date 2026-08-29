#!/usr/bin/env node

/**
 * AtlasAgents server — RSocket TCP entry point.
 *
 * @remarks
 * This is the main entry point for the AtlasAgents server. It handles:
 * - CLI parsing: interactive `start`, `--regen-cert`, and config-repair
 *   (`--password`/`--port`/`--reset`) modes
 * - Interactive startup prompts — on a normal restart, just the server
 *   config passphrase; password and port are read from the encrypted
 *   `user-data/startup.json` and only prompted for when not yet saved
 * - Ollama connectivity verification
 * - Application container initialization
 * - RSocket server startup and client connection management
 *
 * Run with: `node dist/index.js` or `atlas-server`
 */

import type { RSocket } from "@rsocket/core";
import { AuthMiddleware } from "../auth/middleware.js";
import { parseServerArgs, printServerHelp, isServerLaunchCommand } from "../cli/serverArgs.js";
import { runServerConfigRepair } from "../cli/serverConfigRepair.js";
import { ConfigError, ConfigManager } from "../config/index.js";
import {
  loadStartupSecrets,
  saveStartupSecrets,
  unlockOrSetupStartupCipher,
} from "../config/startupSecrets.js";
import { createContainer } from "../container/index.js";
import { installUserDataDefaults } from "../setup/installUserDataDefaults.js";
import { RSocketServer } from "./rsocket/rsocketServer.js";
import { promptListenPort, readPasswordAtStartup } from "./startupPrompts.js";
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
import { syncAgentThinkingSupport } from "../ollama/syncAgentThinkingSupport.js";
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
 * Main entry point for the AtlasAgents server.
 *
 * @remarks
 * Orchestrates the complete server startup sequence:
 * 1. Parses command line arguments (help / --regen-cert / repair / start)
 * 2. In repair mode (`--password`/`--port`/`--reset`), verifies the server
 *    config passphrase, applies the requested changes, and exits — nothing
 *    below this point runs
 * 3. Installs default user data and configuration
 * 4. Unlocks (or sets up) the server config cipher — the only passphrase
 *    prompt on a normal restart — then loads the saved password/port,
 *    prompting for and persisting whichever one isn't saved yet
 * 5. Verifies Ollama service is running and accessible
 * 6. Initializes authentication middleware with password
 * 7. Creates application container with all services
 * 8. Cleans up old workspace snapshots
 * 9. Schedules periodic memory consolidation
 * 10. Verifies Ollama has models installed
 * 11. Checks agent and subagent model configuration
 * 12. Builds request router with all handlers
 * 13. Creates and starts RSocket server
 * 14. Logs successful startup and waits for connections
 *
 * The server runs until SIGINT or process exit. Any error during startup
 * is caught and logged before exiting with a failure code.
 */
const main = async (): Promise<void> => {
  const parsedArgs = parseServerArgs(process.argv);

  if (parsedArgs.help) {
    logger.info(printServerHelp());
    return;
  }

  // --regen-cert rotates the TLS certificate and exits — no server password
  // prompt, no Ollama check, no listening.
  if (parsedArgs.regenCert) {
    await runCertRegen(process.cwd());
    return;
  }

  // Reject anything other than the implicit/explicit "start"/"run" command.
  // Read from the parsed positional rather than raw argv[0], since a flag
  // appearing first (e.g. `atlas-server --port 8001`) is not itself a
  // command.
  if (!isServerLaunchCommand(parsedArgs.command)) {
    logger.error(
      `Unknown command: ${parsedArgs.command}. Try: atlas-server help`,
    );
    process.exit(1);
  }

  // Install default user data and configuration files
  await installUserDataDefaults(process.cwd());

  // --password / --port / --reset: change the saved auth password and/or
  // port and exit, without starting the server. Gated on the server config
  // passphrase inside runServerConfigRepair — a wrong entry throws before
  // anything is written, and never offers the forgot-passphrase reset menu
  // that `start` does (see cli/serverConfigRepair.ts for why).
  if (parsedArgs.repair) {
    await runServerConfigRepair(
      process.cwd(),
      parsedArgs.repair,
      readPasswordAtStartup,
    );
    return;
  }

  // Unlock (or set up) the cipher protecting the auth password, port, and
  // provider API keys at rest. Must happen before any of those are read —
  // this is the ONLY passphrase prompt on a normal restart.
  await unlockOrSetupStartupCipher(process.cwd(), readPasswordAtStartup);

  const savedSecrets = await loadStartupSecrets(process.cwd());
  let password = savedSecrets.password;
  let port = savedSecrets.port;

  if (password === undefined) {
    password = await readPasswordAtStartup();
  }

  // An empty password would let every client authenticate automatically.
  // Checked before persisting anything and before prompting for the port,
  // so a mistyped empty entry is neither saved nor followed by a pointless
  // second prompt.
  if (password.trim().length === 0) {
    logger.error(
      "No password set. The server would accept every client without " +
        "authentication, exposing file and shell access to anyone who can " +
        "reach this port. Restart and set a password.",
    );
    process.exit(1);
  }

  if (port === undefined) {
    port = await promptListenPort();
  }

  if (savedSecrets.password !== password || savedSecrets.port !== port) {
    await saveStartupSecrets(process.cwd(), { password, port });
  }

  // Only bootstrap local Ollama when at least one role is actually configured
  // to use the "ollama" provider — a pure OpenAI-compatible-only deployment has no
  // local Ollama to start or connect to.
  const configPreview = new ConfigManager({ rootDir: process.cwd() });

  // Unlocks the cipher protecting provider API keys at rest. The cipher is
  // already unlocked (by unlockOrSetupStartupCipher above, sharing the same
  // process-global key/salt) — this finds that and skips its own prompt,
  // running only the legacy-plaintext-providers migration if one is needed.
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
      logger.warn(
        "No Ollama models installed. Pull one with: ollama pull <modelname>",
      );
    }
  }

  // Check agent model configuration
  try {
    const agentModel = await app.config.getAgentModel();
    const agentProvider = await app.config.getAgentProvider();
    const agentAdmin = await app.providerRegistry.getAdmin(agentProvider);
    await syncAgentToolSupport(agentAdmin, app.config, agentModel);
    await syncAgentThinkingSupport(agentAdmin, app.config, agentModel);
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
        "Run: atlas-server --regen-cert",
    );
    process.exit(1);
  }
  if (expiry.status === "warning") {
    logger.warn(
      `TLS certificate expires in ${expiry.daysRemaining} day(s). Run: atlas-server --regen-cert`,
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
      // The placement reporter is a process-lifetime singleton that dedupes
      // by requesterId, so its state has to be released here too — otherwise
      // it grows by an entry per connection for as long as the server runs.
      app.modelPlacementReporter.forgetScope(requesterId);
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
