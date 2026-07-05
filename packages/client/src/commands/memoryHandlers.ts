/**
 * Memory-related command handlers.
 *
 * This module handles commands for managing server-side memory:
 * - /memory show, forget, clear
 */

import type { Connection } from "../connection/index.js";
import { printMemory, printError, printSuccess } from "../renderer.js";
import { formatErrorMessage } from "./utils.js";

/**
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
 *   @param sub - Subcommand: "show", "forget", or "clear".
 *   @param arg - Argument for forget subcommand (topic name).
 *   @param conn - RSocket connection for server communication.
 *
 * Returns:
 *   @returns called for side effects only.
 * </Summary>
 */
export const handleMemory = async (
  sub: string,
  arg: string,
  conn: Connection,
): Promise<void> => {
  switch (sub) {
    case "show": {
      try {
        // Fetch and display memory entries from server
        const entries = await conn.getMemory();
        printMemory(entries);
      } catch (err) {
        printError(
          `Could not fetch memory: ${formatErrorMessage(err)}`,
        );
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
        // Forget specific topic from server memory
        await conn.forgetMemory(topic);
        printSuccess(`Forgot topic "${topic}".`);
      } catch (err) {
        printError(`Failed: ${formatErrorMessage(err)}`);
      }
      break;
    }
    case "clear": {
      try {
        // Clear all memory entries from server
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
