import * as readline from 'node:readline'
import { loadConfig, updateConfig, type Config } from './config.js'
import type { Connection } from './connection.js'
import { listSkills, addSkill, readAllSkills } from './skills.js'
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
 *   Prompts the user to enter a number between 1 and max, then returns
 *   the 0-based array index corresponding to their choice.
 *
 * How it does it (step by step):
 *   1. Calls rl.question with the prompt string.
 *   2. Parses the answer as an integer.
 *   3. Checks if it's in the valid range [1, max].
 *   4. Returns (n - 1) to convert to 0-based index.
 *   5. Returns -1 if input is invalid or out of range.
 *
 * Parameters:
 *   @param {readline.Interface} rl — Readline interface for user input.
 *   @param {string} prompt — Prompt text to display.
 *   @param {number} max — Maximum valid number (1-indexed).
 *
 * Returns:
 *   @returns {Promise<number>} — 0-based index or -1 for invalid input.
 *
 * Dependencies:
 *   - readline.Interface.question — Node.js readline API.
 *
 * Dependants:
 *   - CommandHandler.handleSet — uses this to let user pick a model.
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
 *   Handles all slash commands locally without hitting the server, routing
 *   each command to the appropriate handler method.
 *
 * How it fits in the system:
 *   Sits between the CLI input loop (index.ts) and the server connection.
 *   Decides whether input is a command (starts with /) or a task (plain text).
 *   Commands are handled here; tasks are passed to Connection.sendTask.
 *
 * Dependencies:
 *   - Connection — calls listModels, syncSkills, getMemory, forgetMemory, clearMemory.
 *   - config module — loads and updates config.json.
 *   - skills module — lists, creates, and reads skill files.
 *   - renderer module — displays formatted output for each command.
 *
 * Dependants:
 *   - index.ts rl.on('line') — creates a CommandHandler and calls handle() for each line.
 * </Summary>
 */
export class CommandHandler {
  /**
   * @param {Connection} conn — Connection instance for server requests.
   * @param {readline.Interface} rl — Readline interface for user prompts.
   */
  constructor(
    private conn: Connection,
    private rl: readline.Interface,
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
   * Dependencies:
   *   - handleSet, handleConfig, handleSkills, handleMemory, handleExit — private handlers.
   *   - renderer.printHelp, printError — for /help and unknown commands.
   *
   * Dependants:
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
        await this.handleSet(sub)
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
   *   Handles "/set advisor" and "/set agent" by fetching models from the
   *   server, showing a numbered list, and updating config with user's pick.
   *
   * How it does it (step by step):
   *   1. Validates role is "advisor" or "agent" — prints error if not.
   *   2. Calls Connection.listModels to fetch available models.
   *   3. Prints numbered model list via renderer.printModels.
   *   4. Prompts user to pick a number via promptChoice.
   *   5. Updates config with selected model.
   *   6. Reloads Connection with updated config.
   *   7. Prints success message.
   *
   * Parameters:
   *   @param {string} role — "advisor" or "agent".
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - Connection.listModels — fetches models from server.
   *   - promptChoice — prompts user for selection.
   *   - updateConfig — saves selected model to config.json.
   *   - Connection.reload — updates connection's config reference.
   *   - renderer.printModels, printError, printSuccess — display output.
   *
   * Dependants:
   *   - CommandHandler.handle — calls this for /set commands.
   * </Summary>
   */
  private handleSet = async (role: string): Promise<void> => {
    if (role !== 'advisor' && role !== 'agent') {
      printError('Usage: /set advisor  or  /set agent')
      return
    }

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
   * Dependencies:
   *   - loadConfig — reads config.json.
   *   - renderer.printConfig — displays config in formatted table.
   *
   * Dependants:
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
   * Dependencies:
   *   - skills.listSkills, addSkill, readAllSkills — local file operations.
   *   - Connection.syncSkills — uploads skills to server.
   *   - renderer.printSkills, printError, printSuccess — display output.
   *
   * Dependants:
   *   - CommandHandler.handle — calls this for /skills commands.
   * </Summary>
   */
  private handleSkills = async (sub: string, arg: string): Promise<void> => {
    switch (sub) {
      case 'list':
        printSkills(listSkills())
        break
      case 'add': {
        const name = arg.trim()
        if (!name) {
          printError('Usage: /skills add <name>')
          return
        }
        try {
          addSkill(name)
          printSuccess(`Skill "${name}" created.`)
        } catch (err) {
          printError(err instanceof Error ? err.message : String(err))
        }
        break
      }
      case 'sync': {
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
   * Dependencies:
   *   - Connection.getMemory, forgetMemory, clearMemory — server API calls.
   *   - renderer.printMemory, printError, printSuccess — display output.
   *
   * Dependants:
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
   * Dependencies:
   *   None (uses console.log and process.exit).
   *
   * Dependants:
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
