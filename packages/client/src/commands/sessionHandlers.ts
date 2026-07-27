/**
 * Session lifecycle slash commands: `/explore`, `/new`, `/exit`.
 *
 * @remarks
 * These touch server session state or terminate the CLI process — they do not
 * edit local workspace files.
 */

import type { Connection } from "../connection/index.js";
import { printLine, printError, printSuccess } from "../renderer.js";
import { appendLog, setStreamingText } from "../ui/uiBridge.js";
import { formatErrorMessage } from "./utils.js";
import { logger } from "../utils/logger.js";

/**
 * Runs `/explore` — streams a codebase overview from the server.
 *
 * @remarks
 * Uses `Connection.sendStream({ kind: "explore" })`. Token frames update the
 * live streaming UI; on completion the buffer is appended to history as an
 * assistant message. Errors are printed and do not rethrow.
 *
 * @param conn - Live RSocket connection.
 *
 * @example
 * ```ts
 * await handleExplore(connection);
 * ```
 */
export const handleExplore = async (conn: Connection): Promise<void> => {
  try {
    printLine("  Exploring codebase...");
    let explorationBuffer = "";

    await conn.sendStream({
      kind: "explore",
      payload: {},
      onFrame: async (frame) => {
        if (frame.kind === "token") {
          explorationBuffer += frame.text;
          // Progressive UI — same path as task token streaming.
          setStreamingText(explorationBuffer);
        } else if (frame.kind === "error") {
          printError(frame.message);
        }
      },
    });

    // Clear live stream; history gets the full text once (if any).
    setStreamingText(null);
    if (explorationBuffer.length > 0) {
      appendLog(explorationBuffer, "assistant");
    }
  } catch (err) {
    printError(`Failed: ${formatErrorMessage(err)}`);
  }
};

/**
 * Runs `/new` — clears server-side session state for a fresh conversation.
 *
 * @param conn - Live RSocket connection.
 *
 * @example
 * ```ts
 * await handleNew(connection);
 * ```
 */
export const handleNew = async (conn: Connection): Promise<void> => {
  try {
    const response = await conn.sendCommand<{ message?: string }>(
      "session.clear",
      {},
    );
    printSuccess(response.message ?? "Session cleared");
  } catch (err) {
    printError(`Failed: ${formatErrorMessage(err)}`);
  }
};

/**
 * Runs `/exit` — tears down the CLI via a custom hook or `process.exit(0)`.
 *
 * @remarks
 * When `onExit` is provided (Ink / embedded hosts), it fully owns teardown and
 * this function returns. The default path prints a goodbye banner and exits the
 * Node process immediately (does not return).
 *
 * @param onExit - Optional host-provided exit callback.
 *
 * @example
 * ```ts
 * handleExit(() => app.quit());
 * handleExit(undefined); // prints Goodbye! and exits
 * ```
 */
export const handleExit = (onExit: (() => void) | undefined): void => {
  if (onExit) {
    onExit();
    return;
  }

  logger.blank();
  logger.info("  Goodbye!");
  logger.blank();
  process.exit(0);
};
