/**
 * Model-related command handlers.
 *
 * This module handles commands for managing AI models:
 * - /models list, find, pull, delete, show, running
 */

import type { Connection } from "../connection/index.js";
import {
  printInstalledModels,
  printModelFind,
  printLine,
  printError,
  printSuccess,
  printProgress,
  resetPullProgress,
  finishPullProgress,
} from "../renderer.js";

/**
 * <Summary>
 * What it does:
 *   Handles "/models" subcommands for listing, finding, pulling, deleting, showing, and listing running models.
 *
 * How it does it (step by step):
 *   1. Routes based on subcommand (list, find, pull, delete, show, running).
 *   2. For list: fetches and displays all installed models.
 *   3. For find: searches for a model by name and displays results.
 *   4. For pull: streams the model download with progress updates.
 *   5. For delete: removes a model from the server.
 *   6. For show: displays detailed information about a model.
 *   7. For running: lists currently running models.
 *   8. Prints success or error messages for each operation.
 *
 * Parameters:
 *   @param {string} sub — Subcommand: "list", "find", "pull", "delete", "show", or "running".
 *   @param {string} arg — Model name for find, pull, delete, and show subcommands.
 *   @param {Connection} conn — RSocket connection for server communication.
 *
 * Returns:
 *   @returns {Promise<void>} — called for side effects only.
 *
 * Dependencies:
 *   - Connection.fetchModelsDetailed, sendCommand, sendStream — server communication.
 *   - renderer.printInstalledModels, printModelFind, printLine, printProgress, printError, printSuccess — display output.
 *   - resetPullProgress, finishPullProgress — progress tracking.
 *
 * Dependants:
 *   - CommandHandler.handle — calls this for /models commands.
 * </Summary>
 */
export const handleModels = async (
  sub: string,
  arg: string,
  conn: Connection,
): Promise<void> => {
  const modelName = arg.trim();
  switch (sub) {
    case "list": {
      // Fetch and display all installed models
      try {
        const models = await conn.fetchModelsDetailed();
        printInstalledModels(models);
      } catch (err) {
        printError(`Failed: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    case "find": {
      // Validate model name argument
      if (!modelName) {
        printError("Usage: /models find <name>");
        return;
      }
      try {
        const models = await conn.fetchModelsDetailed();
        const foundModel = models.find((model) =>
          model.name.toLowerCase().includes(modelName.toLowerCase()),
        );
        printModelFind(modelName, foundModel, models);
      } catch (err) {
        printError(`Failed: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    case "pull": {
      // Validate model name argument
      if (!modelName) {
        printError("Usage: /models pull <name>");
        return;
      }
      try {
        printLine(`Pulling model: ${modelName}`);
        printLine(
          "This may take a while depending on your connection and model size...",
        );
        console.log();
        resetPullProgress();
        // Stream the model download with progress updates
        await conn.sendStream({
          kind: "models.pull",
          payload: { name: modelName },
          onFrame: (frame) => {
            if (frame.kind === "progress" && frame.data) {
              printProgress(frame.data);
            } else if (frame.kind === "error") {
              finishPullProgress();
              printError(frame.message);
            }
          },
        });
        finishPullProgress();
        printSuccess(`Model pulled successfully: ${modelName}`);
      } catch (err) {
        finishPullProgress();
        printError(`Failed: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    case "delete": {
      // Validate model name argument
      if (!modelName) {
        printError("Usage: /models delete <name>");
        return;
      }
      try {
        await conn.sendCommand("models.delete", { name: modelName });
        printSuccess(`Deleted ${modelName}`);
      } catch (err) {
        printError(`Failed: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    case "show": {
      // Validate model name argument
      if (!modelName) {
        printError("Usage: /models show <name>");
        return;
      }
      try {
        const modelInfo = await conn.sendCommand<Record<string, unknown>>(
          "models.show",
          { name: modelName },
        );
        printLine(JSON.stringify(modelInfo, null, 2));
      } catch (err) {
        printError(`Failed: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    case "running": {
      // List currently running models
      try {
        const response = await conn.sendCommand<{ models: unknown[] }>(
          "models.running",
          {},
        );
        printLine(JSON.stringify(response.models ?? [], null, 2));
      } catch (err) {
        printError(`Failed: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    default:
      printError(
        "Usage: /models list | find <name> | pull <name> | delete <name> | show <name> | running",
      );
  }
};
