/**
 * Session-related command handlers.
 *
 * This module handles commands for session management:
 * - /explore
 * - /new
 * - /exit
 */

import type { Connection } from "../connection/index.js";
import { printLine, printError, printSuccess } from "../renderer.js";
import { appendLog, setStreamingText } from "../ui/uiBridge.js";

/**
 * <Summary>
 * What it does:
 *   Handles "/explore" to analyze and describe the current codebase.
 *
 * How it does it (step by step):
 *   1. Sends explore request to server via streaming connection.
 *   2. Accumulates streaming tokens in a buffer.
 *   3. Updates streaming text UI with accumulated tokens.
 *   4. On completion, appends the exploration result to history.
 *   5. Handles and displays any errors that occur.
 *
 * Parameters:
 *   @param {Connection} conn — RSocket connection for server communication.
 *
 * Returns:
 *   @returns {Promise<void>} — called for side effects only.
 *
 * Dependencies:
 *   - Connection.sendStream — sends explore request to server.
 *   - uiBridge.setStreamingText, appendLog — UI updates.
 *   - renderer.printLine, printError — display output.
 *
 * Dependants:
 *   - CommandHandler.handle — calls this for /explore command.
 * </Summary>
 */
export const handleExplore = async (conn: Connection): Promise<void> => {
  try {
    printLine("  Exploring codebase...");
    let explorationBuffer = "";
    // Send explore request and stream the response
    await conn.sendStream({
      kind: "explore",
      payload: {},
      onFrame: async (frame) => {
        if (frame.kind === "token") {
          // Accumulate streaming tokens
          explorationBuffer += frame.text;
          setStreamingText(explorationBuffer);
        } else if (frame.kind === "error") {
          printError(frame.message);
        }
      },
    });
    setStreamingText(null);
    // Append exploration result to history if content was received
    if (explorationBuffer.length > 0) {
      appendLog(explorationBuffer, "assistant");
    }
  } catch (err) {
    printError(`Failed: ${err instanceof Error ? err.message : err}`);
  }
};

/**
 * <Summary>
 * What it does:
 *   Handles "/new" to clear the current session and start fresh.
 *
 * How it does it (step by step):
 *   1. Sends session.clear command to server.
 *   2. Displays success message with server response or default.
 *   3. Handles and displays any errors that occur.
 *
 * Parameters:
 *   @param {Connection} conn — RSocket connection for server communication.
 *
 * Returns:
 *   @returns {Promise<void>} — called for side effects only.
 *
 * Dependencies:
 *   - Connection.sendCommand — sends clear session command to server.
 *   - renderer.printSuccess, printError — display output.
 *
 * Dependants:
 *   - CommandHandler.handle — calls this for /new command.
 * </Summary>
 */
export const handleNew = async (conn: Connection): Promise<void> => {
  try {
    const response = await conn.sendCommand<{ message?: string }>(
      "session.clear",
      {},
    );
    printSuccess(response.message ?? "Session cleared");
  } catch (err) {
    printError(`Failed: ${err instanceof Error ? err.message : err}`);
  }
};

/**
 * <Summary>
 * What it does:
 *   Handles "/exit" by printing a goodbye message and exiting the process.
 *
 * How it does it (step by step):
 *   1. Calls custom exit handler if provided.
 *   2. Otherwise prints a blank line and "Goodbye!" message.
 *   3. Calls process.exit(0) to terminate immediately.
 *
 * Parameters:
 *   @param {(() => void) | undefined} onExit — Optional custom exit handler.
 *
 * Returns:
 *   @returns {void} — never returns, exits process.
 *
 * Dependencies:
 *   - None (uses console.log and process.exit).
 *
 * Dependants:
 *   - CommandHandler.handle — calls this for /exit command.
 * </Summary>
 */
export const handleExit = (onExit: (() => void) | undefined): void => {
  // Call custom exit handler if provided
  if (onExit) {
    onExit();
    return;
  }
  // Default exit behavior: print goodbye message and exit process
  console.log();
  console.log("  Goodbye!");
  console.log();
  process.exit(0);
};
