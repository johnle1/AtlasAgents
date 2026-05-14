import * as readline from 'node:readline'
import { loadConfig, updateConfig, type Config } from './config.js'
import type { Connection } from './connection.js'
import { listSkills, addSkill, readAllSkills, type SkillManager } from './skills.js'
import {
  printConfig,
  printModels,
  printSkills,
  printMemory,
  printError,
  printSuccess,
  printHelp,
} from './renderer.js'

/**
 * <Summary>
 * What it does:
 *   Holds the ANSI escape sequence for dim (secondary) terminal text.
 *
 * Used by:
 *   - CommandHandler.handleSet — dim hint before a visible password question.
 * </Summary>
 */
const DIM = '\x1b[2m'

/**
 * <Summary>
 * What it does:
 *   Resets ANSI styles so text after a dim hint returns to normal brightness.
 *
 * Used by:
 *   - CommandHandler.handleSet — paired with DIM after the hint line.
 * </Summary>
 */
const RESET = '\x1b[0m'

/**
 * @async
 * <Summary>
 * What it does:
 *   Asks one readline question and resolves with the user’s answer as a string.
 *
 * How it does it (step by step):
 *   1. Wraps rl.question in a Promise that resolves with the answered line.
 *
 * Parameters:
 *   @param {readline.Interface} rl — Active REPL readline instance.
 *   @param {string} q — Prompt string shown before the cursor.
 *
 * Returns:
 *   @returns {Promise<string>} — Raw line from the user (caller may trim).
 *
 * Dependencies (classes/modules this method calls):
 *   - readline.Interface.question — collects one line of input.
 *
 * Dependants (classes/modules that call this method):
 *   - CommandHandler.handleSet — when /set omits password, server host, or port inline.
 * </Summary>
 */
const promptLine = (rl: readline.Interface, q: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(q, (line) => resolve(line))
  })
}

/**
 * <Summary>
 * What it does:
 *   Parses a TCP port from user text for /set port validation.
 *
 * How it does it (step by step):
 *   1. Trims the string and parses base-10 integer.
 *   2. Returns null if NaN or outside inclusive range 1–65535.
 *   3. Otherwise returns the port number.
 *
 * Parameters:
 *   @param {string} s — User-supplied or prompted port text.
 *
 * Returns:
 *   @returns {number | null} — Valid port, or null if unusable.
 *
 * Dependencies (classes/modules this method calls):
 *   - None (parseInt and Number helpers only).
 *
 * Dependants (classes/modules that call this method):
 *   - CommandHandler.handleSet — /set port branch.
 * </Summary>
 */
const parsePort = (s: string): number | null => {
  const n = parseInt(s.trim(), 10)
  if (Number.isNaN(n) || n < 1 || n > 65_535) return null
  return n
}

/**
 * @async
 * <Summary>
 * What it does:
 *   Prompts for a 1-based index in [1, max] and returns the matching 0-based list index.
 *
 * How it does it (step by step):
 *   1. Shows the prompt via readline.
 *   2. Parses the answer as an integer.
 *   3. Returns n - 1 when in range, otherwise -1.
 *
 * Parameters:
 *   @param {readline.Interface} rl — Readline instance for the question.
 *   @param {string} prompt — Prompt text (often includes the valid range).
 *   @param {number} max — Upper bound of the allowed 1-based choice.
 *
 * Returns:
 *   @returns {Promise<number>} — Zero-based index into the caller’s array, or -1 if invalid.
 *
 * Dependencies (classes/modules this method calls):
 *   - readline.Interface.question — collects one line of input.
 *
 * Dependants (classes/modules that call this method):
 *   - CommandHandler.handleSetModel — model picker after /set advisor or /set agent.
 * </Summary>
 */
const promptChoice = (
  rl: readline.Interface,
  prompt: string,
  max: number,
): Promise<number> => {
  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      const n = parseInt(answer.trim(), 10)
      if (isNaN(n) || n < 1 || n > max) {
        resolve(-1)
      } else {
        resolve(n - 1)
      }
    })
  })
}

/**
 * <Summary>
 * What it does:
 *   Parses leading-slash input and runs the matching local command handler without treating it as a task line.
 *
 * How it fits in the system:
 *   Sits between index.ts readline and Connection: slash lines stop here; plain text is sent as tasks from index.
 *
 * Dependencies (classes this class imports):
 *   - Connection — listModels, syncSkills, getMemory, forgetMemory, clearMemory, reload.
 *   - config — loadConfig, updateConfig.
 *   - skills — listSkills, addSkill, readAllSkills, SkillManager.
 *   - renderer — printConfig, printModels, printSkills, printMemory, printError, printSuccess, printHelp.
 *
 * Dependants (classes that instantiate or import this class):
 *   - index.ts — constructs one CommandHandler per session after connect.
 * </Summary>
 */
export class CommandHandler {
  /**
   * <Summary>
   * What it does:
   *   Captures the RSocket connection, readline instance, and optional SkillManager used by all command handlers.
   *
   * How it does it (step by step):
   *   1. Stores conn, rl, and optional skills on the instance for handler methods.
   *
   * Parameters:
   *   @param {Connection} conn — Live RSocket client for server-backed commands.
   *   @param {readline.Interface} rl — REPL readline used for prompts (e.g. /set, model pick).
   *   @param {SkillManager | undefined} skills — When set, /skills uses SkillManager; otherwise falls back to module functions.
   *
   * Returns:
   *   void — constructor side effects only.
   *
   * Dependencies (classes/modules this method calls):
   *   None (field assignment only).
   *
   * Dependants (classes/modules that call this method):
   *   - index.ts — constructs CommandHandler after Connection.connect.
   * </Summary>
   */
  constructor(
    private conn: Connection,
    private rl: readline.Interface,
    private readonly skills?: SkillManager,
  ) {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Determines if the input is a slash command and routes it to the
   *   appropriate handler, or returns false if it's plain task text.
   *
   * How it does it (step by step):
   *   1. Checks if input starts with "/" — returns false if not.
   *   2. Splits input into command, subcommand, and argument.
   *   3. Routes to the appropriate handler method based on command.
   *   4. Prints error for unknown commands.
   *   5. Returns true if a command was handled.
   *
   * Parameters:
   *   @param {string} input — Raw user input from the readline interface.
   *
   * Returns:
   *   @returns {Promise<boolean>} — true if command was handled, false if plain text.
   *
   * Dependencies (classes/modules this method calls):
   *   - handleSet, handleConfig, handleSkills, handleMemory, handleExit — private handlers.
   *   - renderer.printHelp, printError — for /help and unknown commands.
   *
   * Dependants (classes/modules that call this method):
   *   - index.ts rl.on('line') — calls this to route each line of input.
   * </Summary>
   */
  handle = async (input: string): Promise<boolean> => {
    if (!input.startsWith('/')) return false

    const parts = input.slice(1).split(/\s+/)
    const cmd = parts[0]?.toLowerCase() ?? ''
    const sub = parts[1]?.toLowerCase() ?? ''
    const arg = parts.slice(2).join(' ')

    switch (cmd) {
      case 'set':
        await this.handleSet(sub, arg)
        break
      case 'config':
        this.handleConfig()
        break
      case 'skills':
        await this.handleSkills(sub, arg)
        break
      case 'memory':
        await this.handleMemory(sub, arg)
        break
      case 'help':
        printHelp()
        break
      case 'exit':
        this.handleExit()
        break
      default:
        printError(`Unknown command: /${cmd}. Type /help for available commands.`)
        break
    }

    return true
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Handles `/set` for password, server, port (updates disk config and reloads the socket) or advisor/agent (model list picker).
   *
   * How it does it (step by step):
   *   1. Shows usage when `sub` is empty.
   *   2. For password/server/port: uses inline `arg` or prompts, then updateConfig and Connection.reload.
   *   3. For advisor/agent: calls handleSetModel.
   *   4. Otherwise prints an unknown-subcommand error.
   *
   * Parameters:
   *   @param {string} sub — First word after `/set`.
   *   @param {string} arg — Everything after the first two words (`parts.slice(2).join(' ')`), often empty.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies (classes/modules this method calls):
   *   - updateConfig, Connection.reload — persist and apply connection fields.
   *   - promptLine, parsePort, DIM, RESET — prompts and port validation.
   *   - renderer.printError, printSuccess — feedback.
   *   - CommandHandler.handleSetModel — advisor and agent branches.
   *
   * Dependants (classes/modules that call this method):
   *   - CommandHandler.handle — `/set` routing.
   * </Summary>
   */
  private handleSet = async (sub: string, arg: string): Promise<void> => {
    if (!sub) {
      printError(
        'Usage: /set password [value] | /set server [host] | /set port [n] | /set advisor | /set agent',
      )
      return
    }

    switch (sub) {
      case 'password': {
        let value = arg.trim().length > 0 ? arg.trim() : ''
        if (!value) {
          console.log(
            `${DIM}  Password echo is visible in the REPL (masked input needs no readline).${RESET}`,
          )
          value = (await promptLine(this.rl, '  New password: ')).trimEnd()
        }
        const config = updateConfig({ password: value })
        await this.conn.reload(config)
        printSuccess('Password updated.')
        break
      }
      case 'server': {
        let host = arg.trim()
        if (!host) {
          const line = await promptLine(
            this.rl,
            '  Enter server address (default localhost): ',
          )
          host = line.trim() || 'localhost'
        }
        const config = updateConfig({ server: host })
        await this.conn.reload(config)
        printSuccess(`Server set to ${host}`)
        break
      }
      case 'port': {
        let port: number | null = null
        const inline = arg.trim()
        if (inline.length > 0) {
          port = parsePort(inline)
        } else {
          const line = await promptLine(this.rl, '  Enter port (default 7000): ')
          const t = line.trim()
          port = t.length === 0 ? 7000 : parsePort(t)
        }
        if (port === null) {
          printError('Port must be an integer between 1 and 65535.')
          return
        }
        const config = updateConfig({ port })
        await this.conn.reload(config)
        printSuccess(`Port set to ${port}`)
        break
      }
      case 'advisor':
      case 'agent':
        await this.handleSetModel(sub)
        break
      default:
        printError(
          'Unknown /set subcommand. Use: password, server, port, advisor, or agent.',
        )
        break
    }
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Lets the user pick the advisor or agent model from the server’s model list and saves it to config.
   *
   * How it does it (step by step):
   *   1. Fetches model names via Connection.listModels.
   *   2. Prints a numbered list and promptChoice for a 1-based index.
   *   3. On valid choice, updateConfig for advisorModel or agentModel, then Connection.reload.
   *
   * Parameters:
   *   @param {'advisor' | 'agent'} role — Which config field to update.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies (classes/modules this method calls):
   *   - Connection.listModels, Connection.reload — server list and reconnect with new models.
   *   - updateConfig — writes advisorModel or agentModel to disk.
   *   - promptChoice — numeric pick from the printed list.
   *   - renderer.printModels, printError, printSuccess — UI.
   *
   * Dependants (classes/modules that call this method):
   *   - CommandHandler.handleSet — advisor and agent subcommands.
   * </Summary>
   */
  private handleSetModel = async (role: 'advisor' | 'agent'): Promise<void> => {
    let models: string[]
    try {
      models = await this.conn.listModels()
    } catch (err) {
      printError(`Could not fetch models: ${err instanceof Error ? err.message : err}`)
      return
    }

    if (models.length === 0) {
      printError('No models available on the server.')
      return
    }

    printModels(models, role)

    const choice = await promptChoice(
      this.rl,
      `  Pick a number (1-${models.length}): `,
      models.length,
    )

    if (choice < 0) {
      printError('Cancelled — no change.')
      return
    }

    const selected = models[choice]
    const key = role === 'advisor' ? 'advisorModel' : 'agentModel'
    const config = updateConfig({ [key]: selected })
    await this.conn.reload(config)
    printSuccess(`${role} model set to ${selected}`)
  }

  /**
   * <Summary>
   * What it does:
   *   Handles "/config" by loading and displaying the current configuration.
   *
   * How it does it (step by step):
   *   1. Loads config from disk via loadConfig.
   *   2. Prints formatted config via renderer.printConfig.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies (classes/modules this method calls):
   *   - loadConfig — reads config.json.
   *   - renderer.printConfig — displays config in formatted table.
   *
   * Dependants (classes/modules that call this method):
   *   - CommandHandler.handle — calls this for /config command.
   * </Summary>
   */
  private handleConfig = (): void => {
    const config = loadConfig()
    printConfig(config)
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Handles "/skills list", "/skills add <name>", and "/skills sync"
   *   by routing to the appropriate skill operation.
   *
   * How it does it (step by step):
   *   1. Routes based on subcommand (list, add, sync).
   *   2. For list: calls listSkills and prints via renderer.printSkills.
   *   3. For add: validates name, calls addSkill to create file and open editor.
   *   4. For sync: calls readAllSkills, then Connection.syncSkills to upload.
   *   5. Prints success or error messages for each operation.
   *
   * Parameters:
   *   @param {string} sub — Subcommand: "list", "add", or "sync".
   *   @param {string} arg — Argument for add subcommand (skill name).
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies (classes/modules this method calls):
   *   - SkillManager or listSkills, addSkill, readAllSkills — local skill files and optional manager.
   *   - Connection.syncSkills — uploads skill payloads when not using SkillManager.sync.
   *   - renderer.printSkills, printError, printSuccess — display output.
   *
   * Dependants (classes/modules that call this method):
   *   - CommandHandler.handle — calls this for /skills commands.
   * </Summary>
   */
  private handleSkills = async (sub: string, arg: string): Promise<void> => {
    switch (sub) {
      case 'list':
        printSkills(this.skills?.list() ?? listSkills())
        break
      case 'add': {
        const name = arg.trim()
        if (!name) {
          printError('Usage: /skills add <name>')
          return
        }
        try {
          if (this.skills) {
            this.skills.create(name)
          } else {
            addSkill(name)
          }
          printSuccess(`Skill "${name}" created.`)
        } catch (err) {
          printError(err instanceof Error ? err.message : String(err))
        }
        break
      }
      case 'sync': {
        if (this.skills) {
          try {
            const n = await this.skills.sync()
            if (n === 0) {
              printError('No skills to sync. Use /skills add <name> first.')
              return
            }
            printSuccess(`Synced ${n} skill(s) to server.`)
          } catch (err) {
            printError(`Sync failed: ${err instanceof Error ? err.message : err}`)
          }
          break
        }
        const skills = readAllSkills()
        if (skills.length === 0) {
          printError('No skills to sync. Use /skills add <name> first.')
          return
        }
        try {
          await this.conn.syncSkills(skills)
          printSuccess(`Synced ${skills.length} skill(s) to server.`)
        } catch (err) {
          printError(`Sync failed: ${err instanceof Error ? err.message : err}`)
        }
        break
      }
      default:
        printError('Usage: /skills list | /skills add <name> | /skills sync')
        break
    }
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Handles "/memory show", "/memory forget <topic>", and "/memory clear"
   *   by routing to the appropriate memory operation on the server.
   *
   * How it does it (step by step):
   *   1. Routes based on subcommand (show, forget, clear).
   *   2. For show: calls Connection.getMemory and prints via renderer.printMemory.
   *   3. For forget: validates topic, calls Connection.forgetMemory.
   *   4. For clear: calls Connection.clearMemory.
   *   5. Prints success or error messages for each operation.
   *
   * Parameters:
   *   @param {string} sub — Subcommand: "show", "forget", or "clear".
   *   @param {string} arg — Argument for forget subcommand (topic name).
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies (classes/modules this method calls):
   *   - Connection.getMemory, forgetMemory, clearMemory — server-side preference store.
   *   - renderer.printMemory, printError, printSuccess — display output.
   *
   * Dependants (classes/modules that call this method):
   *   - CommandHandler.handle — calls this for /memory commands.
   * </Summary>
   */
  private handleMemory = async (sub: string, arg: string): Promise<void> => {
    switch (sub) {
      case 'show': {
        try {
          const entries = await this.conn.getMemory()
          printMemory(entries)
        } catch (err) {
          printError(`Could not fetch memory: ${err instanceof Error ? err.message : err}`)
        }
        break
      }
      case 'forget': {
        const topic = arg.trim()
        if (!topic) {
          printError('Usage: /memory forget <topic>')
          return
        }
        try {
          await this.conn.forgetMemory(topic)
          printSuccess(`Forgot topic "${topic}".`)
        } catch (err) {
          printError(`Failed: ${err instanceof Error ? err.message : err}`)
        }
        break
      }
      case 'clear': {
        try {
          await this.conn.clearMemory()
          printSuccess('All memories cleared.')
        } catch (err) {
          printError(`Failed: ${err instanceof Error ? err.message : err}`)
        }
        break
      }
      default:
        printError('Usage: /memory show | /memory forget <topic> | /memory clear')
        break
    }
  }

  /**
   * <Summary>
   * What it does:
   *   Handles "/exit" by printing a goodbye message and exiting the process.
   *
   * How it does it (step by step):
   *   1. Prints a blank line and "Goodbye!" message.
   *   2. Calls process.exit(0) to terminate immediately.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void — never returns, exits process.
   *
   * Dependencies (classes/modules this method calls):
   *   None (uses console.log and process.exit).
   *
   * Dependants (classes/modules that call this method):
   *   - CommandHandler.handle — calls this for /exit command.
   * </Summary>
   */
  private handleExit = (): void => {
    console.log()
    console.log('  Goodbye!')
    console.log()
    process.exit(0)
  }
}
