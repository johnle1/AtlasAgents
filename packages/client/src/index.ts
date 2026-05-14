#!/usr/bin/env node

/**
 * <Summary>
 * What it does:
 *   CLI entry file: wires config, first-run prompts, RSocket connection,
 *   readline REPL, slash commands, task streaming, and history persistence.
 *
 * How it fits in the system:
 *   Node runs this module directly; everything else (Connection, CommandHandler,
 *   SkillManager) is constructed from here after config is known.
 *
 * Dependencies (modules this file imports):
 *   - config — paths, load/save config, first-run detection.
 *   - maskedPassword — masked password line before the main readline REPL exists.
 *   - connection — RSocket client session.
 *   - commands — slash-command routing.
 *   - skills — SkillManager for /skills when wired with Connection.
 *   - renderer — banner, tokens, errors, connection status line.
 *
 * Dependants:
 *   - None (process entry; package.json bin points here).
 * </Summary>
 */

import * as readline from 'node:readline'
import * as fs from 'node:fs'
import {
  loadConfig,
  HISTORY_FILE,
  ensureDirs,
  hasConfigFile,
  getDefaultConfig,
  saveConfig,
} from './config.js'
import { readMaskedPassword } from './maskedPassword.js'
import { Connection } from './connection.js'
import { CommandHandler } from './commands.js'
import { SkillManager } from './skills.js'
import {
  printBanner,
  printToken,
  printStreamEnd,
  printError,
  printConnectionStatus,
} from './renderer.js'

/**
 * <Summary>
 * What it does:
 *   Limits how many REPL input lines are kept in ~/.agent-cli/.history so the file cannot grow without bound.
 *
 * Used by:
 *   - saveHistory — keeps only the last MAX_HISTORY lines before writing.
 *   - main — passes the same value to readline as historySize.
 * </Summary>
 */
const MAX_HISTORY = 1_000

/**
 * <Summary>
 * What it does:
 *   Restores prior-session REPL lines from disk so the user can recall them with arrow keys.
 *
 * How it does it (step by step):
 *   1. Reads HISTORY_FILE as UTF-8 text.
 *   2. Splits on newline and drops empty strings.
 *   3. On any read error returns an empty array (first run or missing file).
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {string[]} — History lines oldest-to-newest as stored on disk.
 *
 * Dependencies (classes/modules this function calls):
 *   - fs.readFileSync — reads HISTORY_FILE.
 *
 * Dependants (classes/modules that call this function):
 *   - main — seeds readline history on startup.
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
 *   Persists the in-memory REPL history array to ~/.agent-cli/.history for the next session.
 *
 * How it does it (step by step):
 *   1. Ensures the parent ~/.agent-cli directory exists.
 *   2. Keeps only the last MAX_HISTORY lines.
 *   3. Writes a trailing newline after joined lines.
 *
 * Parameters:
 *   @param {string[]} lines — History entries from readline (best-effort from rl.history).
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies (classes/modules this function calls):
 *   - ensureDirs — creates ~/.agent-cli when missing.
 *   - fs.writeFileSync — writes HISTORY_FILE.
 *
 * Dependants (classes/modules that call this function):
 *   - main — SIGINT double-press exit path and readline close handler.
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
 *   Asks you for server, port, and password the first time there is no config file, then saves `config.json`.
 *
 * How it does it (step by step):
 *   1. Starts from built-in defaults (models, timeouts, etc.).
 *   2. Asks for server address and port (simple text questions), then closes that prompt helper.
 *   3. Asks for password; on a normal terminal the characters are hidden (dots).
 *   4. Saves everything to `~/.agent-cli/config.json` so the next line of `main` can load it normally.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Promise<void>} — Finishes when the new config file has been written.
 *
 * Dependencies (classes/modules this function calls):
 *   - readline — questions for server and port only.
 *   - getDefaultConfig, saveConfig — template config and write to disk.
 *   - readMaskedPassword — password question (after readline above is closed).
 *
 * Dependants (classes/modules that call this function):
 *   - main — only when `hasConfigFile()` is false.
 * </Summary>
 */
const runFirstRunSetup = async (): Promise<void> => {
  const defaults = getDefaultConfig()
  const rlSetup = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rlSetup.question(prompt, (line) => resolve(line))
    })
  let server: string
  let port: number
  try {
    const serverRaw = (await question('Enter server address (default localhost): ')).trim()
    server = serverRaw.length > 0 ? serverRaw : 'localhost'
    const portRaw = (await question('Enter port (default 7000): ')).trim()
    port = 7000
    if (portRaw.length > 0) {
      const n = parseInt(portRaw, 10)
      if (!Number.isNaN(n) && n >= 1 && n <= 65_535) {
        port = n
      }
    }
  } finally {
    rlSetup.close()
  }
  const password = await readMaskedPassword('Enter password: ')
  saveConfig({ ...defaults, server, port, password })
}

/**
 * @async
 * <Summary>
 * What it does:
 *   Starts the LoopyCode CLI session: config, TCP connection, welcome output, readline loop, and shutdown hooks.
 *
 * How it does it (step by step):
 *   1. Runs runFirstRunSetup when config.json is missing, then loadConfig().
 *   2. Builds Connection, prints connection status transitions, await connect() or process.exit(1).
 *   3. Prints post-connect welcome lines and printBanner().
 *   4. Creates readline with persisted history; constructs SkillManager and CommandHandler.
 *   5. Registers SIGINT (Ctrl+C): idle exits once; during streaming first Ctrl+C cancels, second exits; Ctrl+L quits on TTY; line/close handlers for commands, tasks, and history save.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Promise<void>} — Normally never resolves; process exits from handlers.
 *
 * Dependencies (classes/modules this function calls):
 *   - hasConfigFile, loadConfig, runFirstRunSetup — config bootstrap.
 *   - Connection — RSocket session to the server.
 *   - SkillManager, CommandHandler — skills and slash commands.
 *   - loadHistory, saveHistory — disk-backed REPL history.
 *   - renderer — user-visible output.
 *   - readline.createInterface — interactive loop.
 *
 * Dependants (classes/modules that call this function):
 *   - Module top-level — main().catch(...) starts this function.
 * </Summary>
 */
const main = async (): Promise<void> => {
  if (!hasConfigFile()) {
    await runFirstRunSetup()
  }
  const config = loadConfig()
  const conn = new Connection(config)

  conn.onConnectionStatus((status) => {
    printConnectionStatus(status)
  })

  try {
    await conn.connect()
  } catch (err) {
    printError(
      `Could not connect to ${config.server}:${config.port}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    process.exit(1)
  }

  console.log('Connecting... ✓')
  console.log('Welcome to LoopyCode')
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

  const exitRepl = (): never => {
    console.log('\n  Goodbye!\n')
    saveHistory((rl as any).history ?? [])
    process.exit(0)
  }

  const skills = new SkillManager(conn)
  const handler = new CommandHandler(conn, rl, skills)

  let busy = false
  /** SIGINT presses while streaming; idle exits on first Ctrl+C. */
  let sigintWhileStreaming = 0

  // Ctrl+L → same clean exit as Ctrl+D (readline "close"). Standard in many shells for clear screen; here we use it to quit.
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl)
    process.stdin.on('keypress', (_str, key) => {
      if (key?.ctrl && key.name === 'l') {
        rl.close()
      }
    })
  }

  /**
   * <Summary>
   * What it does:
   *   Handles Ctrl+C: when idle, exits immediately; when streaming, first press interrupts, second press exits.
   *
   * How it does it (step by step):
   *   1. If busy, writes a newline and counts presses; second press while still busy runs exitRepl().
   *   2. If idle, resets the streaming counter and runs exitRepl() on the first press.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies (classes/modules this listener calls):
   *   - exitRepl — goodbye line, saveHistory, process.exit(0).
   *
   * Dependants:
   *   - process — registers this listener on 'SIGINT'.
   * </Summary>
   */
  process.on('SIGINT', () => {
    if (busy) {
      process.stdout.write('\n')
      sigintWhileStreaming++
      if (sigintWhileStreaming >= 2) {
        exitRepl()
      }
      return
    }
    sigintWhileStreaming = 0
    exitRepl()
  })

  rl.prompt()

  /**
   * @async
   * <Summary>
   * What it does:
   *   Dispatches each completed input line to slash commands or to the server as a streaming task.
   *
   * How it does it (step by step):
   *   1. Trims input; ignores empty lines with a fresh prompt.
   *   2. Sets busy, awaits CommandHandler.handle; on false return runs Connection.sendTask with token printer.
   *   3. Catches errors to printError, clears busy, always calls rl.prompt().
   *
   * Parameters:
   *   @param {string} line — Raw line from readline (includes leading/trailing spaces until trim).
   *
   * Returns:
   *   void — async listener; errors surfaced to user.
   *
   * Dependencies (classes/modules this listener calls):
   *   - CommandHandler.handle — slash commands.
   *   - Connection.sendTask — plain text tasks.
   *   - renderer.printToken, printStreamEnd, printError — output.
   *
   * Dependants:
   *   - readline.Interface — emits 'line' events.
   * </Summary>
   */
  rl.on('line', async (line: string) => {
    sigintWhileStreaming = 0
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
   * <Summary>
   * What it does:
   *   Handles readline close (Ctrl+D, Ctrl+L on TTY, or EOF): goodbye message, history save, clean exit.
   *
   * How it does it (step by step):
   *   1. Delegates to exitRepl() — goodbye line, saveHistory, process.exit(0).
   *   (Ctrl+L on TTY calls rl.close() first; Ctrl+D / EOF also end up here.)
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies (classes/modules this listener calls):
   *   - exitRepl — shared shutdown path with Ctrl+C when idle.
   *
   * Dependants:
   *   - readline.Interface — emits 'close' when stdin ends.
   * </Summary>
   */
  rl.on('close', () => {
    exitRepl()
  })
}

/**
 * <Summary>
 * What it does:
 *   Boots main() and maps unexpected startup failures to stderr and exit code 1.
 *
 * How it does it (step by step):
 *   1. Awaits the main() promise.
 *   2. On rejection logs "Fatal:" with the error and exits with code 1.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Promise<void>} — Settles when the process exits (main never resolves in normal use).
 *
 * Dependencies (classes/modules this expression calls):
 *   - main — entire CLI startup sequence.
 *
 * Dependants:
 *   - Node runtime — evaluates this module as the program entry.
 * </Summary>
 */
main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
