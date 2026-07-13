/**
 * Server preference-store slash commands under `/memory`.
 *
 * @remarks
 * Memory is learned user preference text (topics + rules), not chat history.
 * Operations call through {@link Connection} (`getMemory`, `forgetMemory`,
 * `clearMemory`).
 */

import type { Connection } from "../connection/index.js";
import { printMemory, printError, printSuccess } from "../renderer.js";
import { formatErrorMessage } from "./utils.js";

/**
 * Routes `/memory show | forget <topic> | clear`.
 *
 * @remarks
 * - `show` — lists all topics via {@link printMemory}
 * - `forget` — requires a non-empty topic argument (exact server key)
 * - `clear` — wipes the entire store (irreversible from the client)
 *
 * Failures print errors and do not rethrow.
 *
 * @param sub - Subcommand after `/memory`.
 * @param arg - Topic for `forget`; ignored otherwise.
 * @param conn - Live RSocket connection.
 *
 * @example
 * ```ts
 * await handleMemory("show", "", connection);
 * await handleMemory("forget", "coding-style", connection);
 * await handleMemory("clear", "", connection);
 * ```
 */
export const handleMemory = async (
  sub: string,
  arg: string,
  conn: Connection,
): Promise<void> => {
  switch (sub) {
    case "show": {
      try {
        const entries = await conn.getMemory();
        printMemory(entries);
      } catch (err) {
        printError(`Could not fetch memory: ${formatErrorMessage(err)}`);
      }
      break;
    }
    case "forget": {
      const topic = arg.trim();
      if (!topic) {
        printError("Usage: /memory forget <topic>");
        return;
      }
      try {
        await conn.forgetMemory(topic);
        printSuccess(`Forgot topic "${topic}".`);
      } catch (err) {
        printError(`Failed: ${formatErrorMessage(err)}`);
      }
      break;
    }
    case "clear": {
      try {
        await conn.clearMemory();
        printSuccess("All memories cleared.");
      } catch (err) {
        printError(`Failed: ${formatErrorMessage(err)}`);
      }
      break;
    }
    default:
      printError(
        "Usage: /memory show | /memory forget <topic> | /memory clear",
      );
      break;
  }
};
