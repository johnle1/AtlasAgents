#!/usr/bin/env node

/**
 * Entry point for the LoopyCode CLI application.
 *
 * @remarks
 * This is the minimal entry point that handles only:
 * - CLI argument parsing and help display
 * - Offline config repair (--reset/--password/--address), which exits before
 *   the TUI starts and never contacts the server
 * - Theme and syntax highlighter initialization
 * - Config directory creation
 * - Delegation to the bootstrap module for all other initialization
 *
 * The bootstrap module handles:
 * - First-run setup (if needed)
 * - Configuration loading
 * - Server connection
 * - File proxy setup
 * - Skill synchronization
 * - Ink TUI launch
 *
 * This file is the entry point and is not used by other modules.
 */

import {
  ensureDirs,
  isConnectionConfigured,
  loadConfig,
  unlockOrSetupConfigCipher,
} from "./config/index.js";
import { initShiki } from "./diff/shikiHighlighter.js";
import { loadTheme } from "./theme/themeManager.js";
import { parseCliArgs, printCliHelp } from "./cli/cliArgs.js";
import { runConfigRepair } from "./cli/configRepair.js";
import { runInkApp } from "./ui/bootstrap/index.js";

/**
 * Main entry point that parses CLI arguments, initializes UI components,
 * and delegates to the bootstrap module to launch the application.
 *
 * @remarks
 * This function:
 * 1. Parses CLI arguments from process.argv
 * 2. Shows help and exits if --help flag is present
 * 3. Runs offline config repair and exits if --reset/--password/--address is present
 * 4. Loads terminal color theme
 * 5. Initializes Shiki syntax highlighter (non-blocking on failure)
 * 6. Ensures config directory exists
 * 7. Checks whether connection settings are configured to decide if setup is needed
 * 8. Delegates to bootstrap module with CLI overrides and setup flag
 *
 * @returns Resolves when the application exits.
 *
 * @throws Uncaught errors are caught by the top-level catch block.
 */
const main = async (): Promise<void> => {
  // ===== STEP 1: Parse CLI Arguments =====
  let cliArgs;
  try {
    // Step 1a: Parse command-line arguments from process.argv
    cliArgs = parseCliArgs(process.argv);
  } catch (err) {
    // Step 1b: If parsing fails, show error and help, then exit
    console.error(err instanceof Error ? err.message : String(err));
    printCliHelp();
    process.exit(1);
  }

  // ===== STEP 2: Handle Help Flag =====
  if (cliArgs.help) {
    // Step 2a: If user requested help, show it and exit successfully
    printCliHelp();
    process.exit(0);
  }

  // ===== STEP 2a: Handle Config-Repair Mode =====
  // --reset/--password/--address change the saved connection settings and exit
  // without ever contacting the server. This must run before the Ink app: the
  // in-app /set commands only exist after a successful connection, so when the
  // server's password/port/IP changes out from under the client, this is the
  // only way back in. runConfigRepair prompts for the passphrase itself.
  if (cliArgs.repair) {
    try {
      await runConfigRepair(cliArgs.repair);
    } catch (repairError) {
      // Quitting at the passphrase prompt is a deliberate choice, not a crash —
      // report it as a plain message rather than a stack trace.
      console.error(
        repairError instanceof Error
          ? repairError.message
          : String(repairError),
      );
      process.exit(1);
    }
    process.exit(0);
  }

  // ===== STEP 2b: Unlock (or set up) the encrypted config =====
  // Must happen before ANY config.ts function that reads/writes config.json —
  // loadTheme() below is the very first such call — since loadConfig/saveConfig
  // are synchronous and cannot themselves prompt for a passphrase.
  await unlockOrSetupConfigCipher();

  // ===== STEP 3: Initialize UI Components =====
  // Step 3a: Load terminal color theme from config or defaults
  loadTheme();

  // Step 3b: Initialize Shiki syntax highlighter for code diffs
  // Step 3c: Don't block startup if Shiki fails (fallback to plain text)
  initShiki().catch((err) => {
    console.warn(
      "Warning: Failed to initialize syntax highlighting. Code diffs will display in plain text.",
    );
    console.warn("Error:", err instanceof Error ? err.message : String(err));
  });

  // ===== STEP 4: Ensure Config Directory Exists =====
  // Step 4a: Create config directory if it doesn't exist
  ensureDirs();

  // ===== STEP 5: Check if Setup is Needed =====
  // Step 5a: Determine whether usable connection settings exist. Checking for
  // the file itself would always report "configured": loadTheme() above calls
  // loadConfig(), which writes DEFAULT_CONFIG to disk on a fresh install.
  const needsSetup = !isConnectionConfigured(loadConfig());

  // ===== STEP 6: Delegate to Bootstrap Module =====
  // Step 6a: Pass CLI overrides and setup flag to bootstrap module
  // Step 6b: Bootstrap module will handle setup, connection, and TUI launch
  runInkApp({
    cliOverrides: cliArgs.overrides,
    needsSetup,
  });
};

/**
 * <Summary>
 * What it does:
 *   Top-level error handler that catches any uncaught errors from main() and exits.
 *
 * How it does it (step by step):
 *   1. Calls main() to start the application.
 *   2. If any error propagates out of main(), catches it here.
 *   3. Logs the error to stderr.
 *   4. Exits the process with error code 1.
 *
 * Dependencies:
 *   - main — the main application entry point.
 *
 * Dependants:
 *   None (top-level error handler).
 * </Summary>
 */
main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
