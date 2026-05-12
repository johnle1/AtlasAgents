#!/usr/bin/env node

import * as readline from 'node:readline'
import * as fs from 'node:fs'
import { loadConfig, HISTORY_FILE, ensureDirs } from './config.js'
import { Connection } from './connection.js'
import { CommandHandler } from './commands.js'
import {
  printBanner,
  printToken,
  printStreamEnd,
  printError,
  printConnectionStatus,
} from './renderer.js'

/**
 * Maximum number of history lines to keep in ~/.agent-cli/.history.
 * Older entries are trimmed when this limit is reached.
 */
const MAX_HISTORY = 1_000

/**
 * <Summary>
 * What it does:
 *   Loads the readline history from ~/.agent-cli/.history so users can
 *   use arrow keys to recall previous commands across sessions.
 *
 * How it does it (step by step):
 *   1. Reads HISTORY_FILE as UTF-8 text.
 *   2. Splits on newlines and filters out empty lines.
 *   3. Returns the array of history entries.
 *   4. Returns empty array on any error (e.g. file doesn't exist yet).
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {string[]} — Array of previous command strings.
 *
 * Dependencies:
 *   - fs.readFileSync — Node.js filesystem API.
 *
 * Dependants:
 *   - main() — calls this on startup to populate readline history.
 * </Summary>
 */
const loadHistory = (): string[] => {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf-8')
    return raw.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * <Summary>
 * What it does:
 *   Saves the current readline history to ~/.agent-cli/.history, trimming
 *   to the most recent MAX_HISTORY entries.
 *
 * How it does it (step by step):
 *   1. Ensures ~/.agent-cli/ directory exists.
 *   2. Slices the lines array to keep only the last MAX_HISTORY entries.
 *   3. Joins lines with newlines and writes to HISTORY_FILE.
 *
 * Parameters:
 *   @param {string[]} lines — Array of history entries from readline.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - ensureDirs — ensures HISTORY_FILE directory exists.
 *   - fs.writeFileSync — Node.js filesystem API.
 *
 * Dependants:
 *   - main() SIGINT handler — saves history on Ctrl+C exit.
 *   - main() rl.on('close') — saves history on Ctrl+D exit.
 * </Summary>
 */
const saveHistory = (lines: string[]): void => {
  ensureDirs()
  const trimmed = lines.slice(-MAX_HISTORY)
  fs.writeFileSync(HISTORY_FILE, trimmed.join('\n') + '\n', 'utf-8')
}

/**
 * @async
 * <Summary>
 * What it does:
 *   Entry point for the LoopyCode CLI. Sets up the readline REPL, handles
 *   user input by routing slash commands to CommandHandler and plain text
 *   to the server for task execution, and manages history persistence and
 *   signal handling.
 *
 * How it does it (step by step):
 *   1. Loads config from ~/.agent-cli/config.json.
 *   2. Creates Connection instance with loaded config.
 *   3. Subscribes to connection status changes via onConnectionStatus so
 *      the CLI prints a dim status line when state transitions occur.
 *   4. Awaits conn.connect() to open the RSocket TCP session — fails
 *      loudly on startup if the server is unreachable.
 *   5. Prints branded banner.
 *   6. Loads history from disk for arrow-key recall.
 *   7. Creates readline interface with prompt and history.
 *   8. Creates CommandHandler to route slash commands.
 *   9. Sets up SIGINT handler (Ctrl+C):
 *      - During streaming: aborts stream and continues.
 *      - When idle: first press warns, second press exits.
 *   10. Sets up line handler:
 *       - Passes to CommandHandler if starts with "/".
 *       - Otherwise sends to Connection.sendTask as streaming task.
 *   11. Sets up close handler (Ctrl+D):
 *       - Saves history and exits cleanly.
 *   12. Displays prompt and waits for input.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Promise<void>} — Never resolves normally, exits via process.exit.
 *
 * Dependencies:
 *   - config.loadConfig — loads config on startup.
 *   - Connection — opens RSocket TCP session and sends tasks to server.
 *   - Connection.onConnectionStatus — subscribes to status changes.
 *   - CommandHandler — handles slash commands.
 *   - renderer.printBanner, printToken, printStreamEnd, printError,
 *     printConnectionStatus — display output.
 *   - loadHistory, saveHistory — persist command history.
 *   - readline.createInterface — creates REPL.
 *
 * Dependants:
 *   None (entry point).
 * </Summary>
 */
const main = async (): Promise<void> => {
  const config = loadConfig()
  const conn = new Connection(config)

  conn.onConnectionStatus((status) => {
    printConnectionStatus(status)
  })

  await conn.connect()

  printBanner()

  const history = loadHistory()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[1m  ❯ \x1b[0m',
    history,
    historySize: MAX_HISTORY,
    terminal: true,
  })

  const handler = new CommandHandler(conn, rl)

  let busy = false

  /**
   * SIGINT (Ctrl+C) handler:
   * - If busy (streaming), abort the stream and continue REPL.
   * - If idle, first press warns, second press exits and saves history.
   */
  let sigintCount = 0
  process.on('SIGINT', () => {
    if (busy) {
      process.stdout.write('\n')
      return
    }
    sigintCount++
    if (sigintCount >= 2) {
      console.log('\n  Goodbye!\n')
      saveHistory((rl as any).history ?? [])
      process.exit(0)
    }
    console.log('\n  Press Ctrl+C again to exit, or keep typing.')
    rl.prompt()
  })

  rl.prompt()

  /**
   * Line handler: processes each user input line.
   * - Sets busy flag during execution.
   * - Passes to CommandHandler if it's a slash command.
   * - Otherwise sends to server as a streaming task.
   * - Catches and prints errors from either path.
   * - Resets busy flag and displays prompt when done.
   */
  rl.on('line', async (line: string) => {
    sigintCount = 0
    const input = line.trim()
    if (!input) {
      rl.prompt()
      return
    }

    busy = true

    try {
      const wasCommand = await handler.handle(input)
      if (!wasCommand) {
        process.stdout.write('\n')
        await conn.sendTask(input, (token) => printToken(token))
        printStreamEnd()
      }
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err))
    }

    busy = false
    rl.prompt()
  })

  /**
   * Close handler (Ctrl+D / EOF):
   * - Prints goodbye message.
   * - Saves history to disk.
   * - Exits cleanly with code 0.
   */
  rl.on('close', () => {
    console.log('\n  Goodbye!\n')
    saveHistory((rl as any).history ?? [])
    process.exit(0)
  })
}

/**
 * Top-level execution:
 * - Calls main() and catches any fatal errors.
 * - Prints fatal errors to stderr and exits with code 1.
 */
main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
