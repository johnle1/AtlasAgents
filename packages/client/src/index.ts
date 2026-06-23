#!/usr/bin/env node

/**
 * <Summary>
 * What it does:
 *   Entry point for the LoopyCode CLI application that parses CLI arguments,
 *   initializes theme and syntax highlighting, and launches the Ink TUI via the
 *   bootstrap module.
 *
 * How it fits in the system:
 *   This is the minimal entry point that handles only:
 *   - CLI argument parsing and help display
 *   - Theme and syntax highlighter initialization
 *   - Config directory creation
 *   - Delegation to the bootstrap module for all other initialization
 *
 *   The bootstrap module handles:
 *   - First-run setup (if needed)
 *   - Configuration loading
 *   - Server connection
 *   - File proxy setup
 *   - Skill synchronization
 *   - Ink TUI launch
 *
 *   None (entry point).
 * </Summary>
 */

import { ensureDirs, hasConfigFile } from "./config.js";
import { initShiki } from "./diff/shikiHighlighter.js";
import { loadTheme } from "./theme/themeManager.js";
import { parseCliArgs, printCliHelp } from "./cliArgs.js";
import { runInkApp } from "./ui/bootstrap/index.js";

/**
 * @async
 * <Summary>
 * What it does:
 *   Main entry point that parses CLI arguments, initializes UI components,
 *   and delegates to the bootstrap module to launch the application.
 *
 * How it does it (step by step):
 *   1. Parses CLI arguments from process.argv.
 *   2. Shows help and exits if --help flag is present.
 *   3. Loads terminal color theme.
 *   4. Initializes Shiki syntax highlighter (non-blocking on failure).
 *   5. Ensures config directory exists.
 *   6. Checks if config file exists to determine if setup is needed.
 *   7. Delegates to bootstrap module with CLI overrides and setup flag.
 *
 * Returns:
 *   @returns Resolves when the application exits.
 *
 * Throws:
 *   @throws {Error} — Uncaught errors are caught by the top-level catch block.
 * </Summary>
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
  // Step 5a: Determine if config file exists (first-run detection)
  const needsSetup = !hasConfigFile();

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
 *   None (top-level error handler).
 * </Summary>
 */
main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
