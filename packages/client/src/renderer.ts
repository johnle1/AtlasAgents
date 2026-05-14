import type { Config } from "./config.js";
import type { ConnectionStatus, MemoryEntry } from "./connection.js";

/**
 * ANSI escape codes for terminal styling.
 */
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

/**
 * CLI version number displayed in the banner.
 */
const VERSION = "0.1.0";

/**
 * <Summary>
 * What it does:
 *   Prints the LoopyCode CLI banner to the terminal on startup.
 *
 * How it does it (step by step):
 *   1. Prints a boxed banner with version number in cyan.
 *   2. Prints usage hints in dim gray below the banner.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.log).
 *
 * Dependants:
 *   - index.ts main() — calls this once on CLI startup.
 * </Summary>
 */
export const printBanner = (): void => {
  console.log();
  console.log(`${BOLD}${CYAN}  ╭──────────────────────────────────╮${RESET}`);
  console.log(
    `${BOLD}${CYAN}  │        LoopyCode CLI v${VERSION}       │${RESET}`,
  );
  console.log(`${BOLD}${CYAN}  ╰──────────────────────────────────╯${RESET}`);
  console.log();
  console.log(
    `${DIM}  Type a task to send to the server, or use /commands.${RESET}`,
  );
  console.log(
    `${DIM}  /config to see settings · /exit, Ctrl+C, or Ctrl+L to quit${RESET}`,
  );
  console.log();
};

/**
 * <Summary>
 * What it does:
 *   Writes a single token to stdout without adding a newline, so tokens
 *   stream horizontally as they arrive from the server.
 *
 * How it does it (step by step):
 *   1. Writes the token string to process.stdout.
 *
 * Parameters:
 *   @param {string} token — One token string from the SSE stream.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses process.stdout.write).
 *
 * Dependants:
 *   - index.ts Connection.sendTask callback — calls this for each token.
 * </Summary>
 */
export const printToken = (token: string): void => {
  process.stdout.write(token);
};

/**
 * <Summary>
 * What it does:
 *   Prints two blank lines after a streaming response completes to
 *   separate it visually from the next prompt.
 *
 * How it does it (step by step):
 *   1. Prints two newlines.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.log).
 *
 * Dependants:
 *   - index.ts — calls this after Connection.sendTask resolves.
 * </Summary>
 */
export const printStreamEnd = (): void => {
  console.log();
  console.log();
};

/**
 * <Summary>
 * What it does:
 *   Prints a plain text line to the terminal.
 *
 * How it does it (step by step):
 *   1. Calls console.log with the text.
 *
 * Parameters:
 *   @param {string} text — Text to print.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.log).
 *
 * Dependants:
 *   None (utility function, currently unused).
 * </Summary>
 */
export const printLine = (text: string): void => {
  console.log(text);
};

/**
 * <Summary>
 * What it does:
 *   Prints an error message in red with an "error:" prefix.
 *
 * How it does it (step by step):
 *   1. Formats the message with red color for "error:" and resets after.
 *   2. Writes to stderr.
 *
 * Parameters:
 *   @param {string} msg — Error message text.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.error).
 *
 * Dependants:
 *   - CommandHandler — calls this for invalid commands or failed requests.
 *   - index.ts — calls this when Connection.sendTask throws.
 * </Summary>
 */
export const printError = (msg: string): void => {
  console.error(`${RED}  error:${RESET} ${msg}`);
};

/**
 * <Summary>
 * What it does:
 *   Prints a success message in green with a checkmark prefix.
 *
 * How it does it (step by step):
 *   1. Formats the message with green checkmark and resets after.
 *   2. Writes to stdout.
 *
 * Parameters:
 *   @param {string} msg — Success message text.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.log).
 *
 * Dependants:
 *   - CommandHandler.handleSet — confirms model selection.
 *   - CommandHandler.handleSkills (add, sync) — confirms operation.
 *   - CommandHandler.handleMemory (forget, clear) — confirms operation.
 * </Summary>
 */
export const printSuccess = (msg: string): void => {
  console.log(`${GREEN}  ✓${RESET} ${msg}`);
};

/**
 * <Summary>
 * What it does:
 *   Formats a secret string for safe display in the terminal, masking all
 *   but the last 4 characters to prevent accidental exposure.
 *
 * How it does it (step by step):
 *   1. Trims whitespace from the secret.
 *   2. If empty, returns dim "(not set)".
 *   3. If 4 characters or shorter, returns dim "****" (too short to reveal any).
 *   4. Otherwise returns a dim ellipsis followed by the last 4 characters.
 *
 * Parameters:
 *   @param {string} secret — The raw password string from config.
 *
 * Returns:
 *   @returns {string} — ANSI-styled masked representation of the secret.
 *
 * Dependencies:
 *   None.
 *
 * Dependants:
 *   - printConfig — uses this to display the password row safely.
 * </Summary>
 */
const formatSecretDisplay = (secret: string): string => {
  const t = secret.trim();
  if (!t) return `${DIM}(not set)${RESET}`;
  if (t.length <= 4) return `${DIM}****${RESET}`;
  return `${DIM}…${RESET}${t.slice(-4)}`;
};

/**
 * <Summary>
 * What it does:
 *   Prints a one-line dim status label showing the current RSocket
 *   connection state so the user knows whether the CLI is online.
 *
 * How it does it (step by step):
 *   1. Maps the ConnectionStatus value to a human-readable label.
 *   2. Prints the label in dim gray wrapped in square brackets.
 *
 * Parameters:
 *   @param {ConnectionStatus} status — The current connection state.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.log).
 *
 * Dependants:
 *   - index.ts main() — subscribed via Connection.onConnectionStatus.
 * </Summary>
 */
export const printConnectionStatus = (status: ConnectionStatus): void => {
  const label =
    status === "connected"
      ? "connected"
      : status === "connecting"
        ? "connecting…"
        : status === "reconnecting"
          ? "reconnecting…"
          : "disconnected";
  console.log(`${DIM}  [rsocket: ${label}]${RESET}`);
};

/**
 * <Summary>
 * What it does:
 *   Prints the current CLI configuration in a formatted table.
 *
 * How it does it (step by step):
 *   1. Prints "Current Configuration" header in bold.
 *   2. Prints a horizontal line.
 *   3. Prints server, port, and masked password.
 *   4. Prints model names (dim "(not set)" for empty), temps, and retries.
 *
 * Parameters:
 *   @param {Config} config — The configuration object to display.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.log).
 *
 * Dependants:
 *   - CommandHandler.handleConfig — calls this to display config.
 * </Summary>
 */
export const printConfig = (config: Config): void => {
  console.log();
  console.log(`${BOLD}  Current Configuration${RESET}`);
  console.log(`${DIM}  ${"─".repeat(34)}${RESET}`);
  console.log(`  ${CYAN}server${RESET}         ${config.server}`);
  console.log(`  ${CYAN}port${RESET}           ${config.port}`);
  console.log(
    `  ${CYAN}password${RESET}       ${formatSecretDisplay(config.password)}`,
  );
  console.log(
    `  ${CYAN}advisor model${RESET}  ${config.advisorModel || DIM + "(not set)" + RESET}`,
  );
  console.log(
    `  ${CYAN}agent model${RESET}    ${config.agentModel || DIM + "(not set)" + RESET}`,
  );
  console.log(`  ${CYAN}advisor temp${RESET}   ${config.advisorTemp}`);
  console.log(`  ${CYAN}agent temp${RESET}     ${config.agentTemp}`);
  console.log(`  ${CYAN}retries${RESET}        ${config.retries}`);
  console.log();
};

/**
 * <Summary>
 * What it does:
 *   Prints a numbered list of available models so users can pick one.
 *
 * How it does it (step by step):
 *   1. Prints a header with the role label (advisor or agent).
 *   2. Prints each model with a yellow number prefix.
 *
 * Parameters:
 *   @param {string[]} models — Array of model names.
 *   @param {string} label — Role label e.g. "advisor" or "agent".
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.log).
 *
 * Dependants:
 *   - CommandHandler.handleSet — calls this before prompting user to pick.
 * </Summary>
 */
export const printModels = (models: string[], label: string): void => {
  console.log();
  console.log(`${BOLD}  Available models for ${label}:${RESET}`);
  console.log();
  for (let i = 0; i < models.length; i++) {
    console.log(
      `  ${YELLOW}${String(i + 1).padStart(3)}${RESET}  ${models[i]}`,
    );
  }
  console.log();
};

/**
 * <Summary>
 * What it does:
 *   Prints a list of local skill file names.
 *
 * How it does it (step by step):
 *   1. If the array is empty, prints a dim hint to create skills.
 *   2. Otherwise prints a header and a bulleted list with magenta bullets.
 *
 * Parameters:
 *   @param {string[]} names — Array of skill file basenames without extensions.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.log).
 *
 * Dependants:
 *   - CommandHandler.handleSkills (list subcommand) — calls this to display skills.
 * </Summary>
 */
export const printSkills = (names: string[]): void => {
  console.log();
  if (names.length === 0) {
    console.log(
      `${DIM}  No skills found. Use /skills add <name> to create one.${RESET}`,
    );
  } else {
    console.log(`${BOLD}  Skills (${names.length}):${RESET}`);
    console.log();
    for (const name of names) {
      console.log(`  ${MAGENTA}•${RESET} ${name}`);
    }
  }
  console.log();
};

/**
 * <Summary>
 * What it does:
 *   Prints all memory entries from the server in a structured format.
 *
 * How it does it (step by step):
 *   1. If the array is empty, prints a dim "(no memories)" message.
 *   2. Otherwise prints a header with entry count.
 *   3. For each entry, prints the topic in cyan and its rules indented with arrows.
 *
 * Parameters:
 *   @param {MemoryEntry[]} entries — Array of memory topics with their rules.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.log).
 *
 * Dependants:
 *   - CommandHandler.handleMemory (show subcommand) — calls this to display memory.
 * </Summary>
 */
export const printMemory = (entries: MemoryEntry[]): void => {
  console.log();
  if (entries.length === 0) {
    console.log(`${DIM}  No memories stored.${RESET}`);
  } else {
    console.log(`${BOLD}  Stored Memories (${entries.length} topics):${RESET}`);
    console.log();
    for (const entry of entries) {
      console.log(`  ${CYAN}${entry.topic}${RESET}`);
      for (const rule of entry.rules) {
        console.log(`    ${DIM}→${RESET} ${rule}`);
      }
    }
  }
  console.log();
};

/**
 * <Summary>
 * What it does:
 *   Prints the help text listing all available slash commands.
 *
 * How it does it (step by step):
 *   1. Prints a "Commands:" header.
 *   2. Lists each command in green with a brief description.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   None (uses console.log).
 *
 * Dependants:
 *   - CommandHandler.handle (/help case) — calls this when user types /help.
 * </Summary>
 */
export const printHelp = (): void => {
  console.log();
  console.log(`${BOLD}  Commands:${RESET}`);
  console.log();
  console.log(
    `  ${GREEN}/set password [value]${RESET}  Set server password (prompt if omitted)`,
  );
  console.log(
    `  ${GREEN}/set server [host]${RESET}     Set server host (prompt if omitted)`,
  );
  console.log(
    `  ${GREEN}/set port [n]${RESET}          Set server port (prompt if omitted)`,
  );
  console.log(`  ${GREEN}/set advisor${RESET}         Choose advisor model`);
  console.log(`  ${GREEN}/set agent${RESET}           Choose agent model`);
  console.log(
    `  ${GREEN}/config${RESET}              Show current configuration`,
  );
  console.log(`  ${GREEN}/skills list${RESET}         List local skill files`);
  console.log(`  ${GREEN}/skills add <name>${RESET}   Create a new skill file`);
  console.log(`  ${GREEN}/skills sync${RESET}         Sync skills to server`);
  console.log(`  ${GREEN}/memory show${RESET}         Show stored preferences`);
  console.log(`  ${GREEN}/memory forget <t>${RESET}   Forget a topic`);
  console.log(`  ${GREEN}/memory clear${RESET}        Clear all memories`);
  console.log(`  ${GREEN}/help${RESET}                Show this help`);
  console.log(`  ${GREEN}/exit${RESET}                Quit (Ctrl+C when idle; Ctrl+L; during a stream use Ctrl+C twice)`);
  console.log();
  console.log(
    `${DIM}  Editing ~/.agent-cli/config.json by hand requires restarting the CLI unless you use /set.${RESET}`,
  );
  console.log();
};
