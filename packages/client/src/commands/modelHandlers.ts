/**
 * <Summary>
 * What it does:
 *   Handles model-related command handlers for the CLI.
 *
 * How it fits in the system:
 *   This module provides command handlers for managing AI models through the CLI. It handles
 *   subcommands for listing, finding, pulling, deleting, showing, and listing running models.
 *   These commands communicate with the server via the RSocket connection and provide real-time
 *   progress feedback during operations like model pulling.
 *
 * Dependencies:
 *   - Connection — provides server communication methods.
 *   - renderer — provides output formatting and display functions.
 *
 * Dependants:
 *   - CommandHandler — uses these handlers for /models commands.
 * </Summary>
 */

import type { Connection } from "../connection/index.js";
import { formatErrorMessage } from "./utils.js";
import { logger } from "../utils/logger.js";
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
 *   1. Route based on the subcommand type.
 *   2. For "list": fetch and display all installed models from the server.
 *   3. For "find": search for a model by name and display matching results.
 *   4. For "pull": stream the model download from the server with progress updates.
 *   5. For "delete": remove a model from the server.
 *   6. For "show": display detailed information about a specific model.
 *   7. For "running": list all currently running models.
 *   8. Print success or error messages for each operation based on the result.
 *
 * Parameters:
 * @param {string} subcommand — Subcommand type: "list", "find", "pull", "delete", "show", or "running".
 * @param {string} modelArgument — Model name for find, pull, delete, and show subcommands.
 * @param {Connection} connection — RSocket connection for server communication.
 *
 * Returns:
 * @returns {Promise<void>} — Promise that resolves after handling the subcommand (called for side effects only).
 *
 * Dependencies:
 *   - Connection.fetchModelsDetailed — fetches detailed model information from server.
 *   - Connection.sendCommand — sends one-time commands to server.
 *   - Connection.sendStream — initiates streaming communication with server.
 *   - renderer.printInstalledModels — displays list of installed models.
 *   - renderer.printModelFind — displays model search results.
 *   - renderer.printLine — prints plain text output.
 *   - renderer.printError — displays error messages.
 *   - renderer.printSuccess — displays success messages.
 *   - renderer.printProgress — displays download progress.
 *   - renderer.resetPullProgress — initializes progress tracking.
 *   - renderer.finishPullProgress — finalizes progress tracking.
 *
 * Dependants:
 *   - CommandHandler.handle — calls this for /models commands.
 * </Summary>
 */
export const handleModels = async (
  subcommand: string,
  modelArgument: string,
  connection: Connection,
): Promise<void> => {
  // ===== STEP 1: Clean model name argument =====
  // Step 1a: Trim whitespace from the model name argument
  // Step 1b: This ensures consistent model name handling
  const modelName = modelArgument.trim();

  // ===== STEP 2: Route to subcommand handler =====
  // Step 2a: Use switch statement to route based on the subcommand type
  switch (subcommand) {
    case "list": {
      // ===== CASE: List all installed models =====
      // Step 1: Fetch and display all installed models from the server

      // ===== STEP 1a: Try to fetch models =====
      // Step 1a-1: Wrap in try-catch to handle network errors gracefully
      try {
        // Step 1a-2: Fetch detailed model information from the server
        const models = await connection.fetchModelsDetailed();

        // Step 1a-3: Display the list of installed models to the user
        printInstalledModels(models);
      } catch (error) {
        // Step 1a-4: Handle errors by printing error message
        // Step 1a-5: Extract error message if it's an Error object, otherwise use the error itself
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "find": {
      // ===== CASE: Find a model by name =====
      // Step 1: Search for a model by name and display results

      // ===== STEP 1a: Validate model name argument =====
      // Step 1a-1: Check if model name was provided
      if (!modelName) {
        // Step 1a-2: Print usage error if model name is missing
        printError("Usage: /models find <name>");
        return;
      }

      // ===== STEP 1b: Try to find the model =====
      try {
        // Step 1b-1: Fetch detailed model information from the server
        const models = await connection.fetchModelsDetailed();

        // Step 1b-2: Search for a model that includes the provided name (case-insensitive)
        const foundModel = models.find((model) =>
          model.name.toLowerCase().includes(modelName.toLowerCase()),
        );

        // Step 1b-3: Display the search results to the user
        printModelFind(modelName, foundModel, models);
      } catch (error) {
        // Step 1b-4: Handle errors by printing error message
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "pull": {
      // ===== CASE: Pull a model from the server =====
      // Step 1: Stream the model download with progress updates

      // ===== STEP 1a: Validate model name argument =====
      // Step 1a-1: Check if model name was provided
      if (!modelName) {
        // Step 1a-2: Print usage error if model name is missing
        printError("Usage: /models pull <name>");
        return;
      }

      // ===== STEP 1b: Try to pull the model =====
      try {
        // Step 1b-1: Print informational message about the model pull operation
        printLine(`Pulling model: ${modelName}`);

        // Step 1b-2: Print warning about the time required for the operation
        printLine(
          "This may take a while depending on your connection and model size...",
        );

        // Step 1b-3: Add a blank line for better visual separation
        logger.blank();

        // Step 1b-4: Initialize progress tracking for this model pull
        resetPullProgress(modelName);

        // Step 1b-5: Track whether the pull operation failed
        let pullFailed = false;

        // Step 1b-6: Initiate streaming communication with the server for model pull
        await connection.sendStream({
          kind: "models.pull",
          payload: { name: modelName },
          onFrame: (frame) => {
            // ===== STEP 1b-6a: Handle streaming frames =====
            // Step 1b-6a-1: Check if the frame is a progress frame with data
            if (frame.kind === "progress" && frame.data) {
              // Step 1b-6a-2: Print progress update and track if it failed
              if (printProgress(frame.data, modelName)) {
                pullFailed = true;
              }
            } else if (frame.kind === "error") {
              // Step 1b-6a-3: Handle error frames
              // Step 1b-6a-4: Finalize progress tracking for the failed pull
              finishPullProgress(modelName);

              // Step 1b-6a-5: Print the error message from the server
              printError(frame.message);

              // Step 1b-6a-6: Mark the pull operation as failed
              pullFailed = true;
            }
          },
        });

        // Step 1b-7: Finalize progress tracking for the pull operation
        finishPullProgress(modelName);

        // Step 1b-8: Print success message if the pull succeeded
        if (!pullFailed) {
          printSuccess(`Model pulled successfully: ${modelName}`);
        }
      } catch (error) {
        // Step 1b-9: Handle errors by finalizing progress and printing error message
        finishPullProgress(modelName);
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "delete": {
      // ===== CASE: Delete a model from the server =====
      // Step 1: Remove a model from the server

      // ===== STEP 1a: Validate model name argument =====
      // Step 1a-1: Check if model name was provided
      if (!modelName) {
        // Step 1a-2: Print usage error if model name is missing
        printError("Usage: /models delete <name>");
        return;
      }

      // ===== STEP 1b: Try to delete the model =====
      try {
        // Step 1b-1: Send delete command to the server
        await connection.sendCommand("models.delete", { name: modelName });

        // Step 1b-2: Print success message
        printSuccess(`Deleted ${modelName}`);
      } catch (error) {
        // Step 1b-3: Handle errors by printing error message
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "show": {
      // ===== CASE: Show detailed model information =====
      // Step 1: Display detailed information about a specific model

      // ===== STEP 1a: Validate model name argument =====
      // Step 1a-1: Check if model name was provided
      if (!modelName) {
        // Step 1a-2: Print usage error if model name is missing
        printError("Usage: /models show <name>");
        return;
      }

      // ===== STEP 1b: Try to fetch model information =====
      try {
        // Step 1b-1: Send show command to the server to fetch model details
        const modelInfo = await connection.sendCommand<Record<string, unknown>>(
          "models.show",
          { name: modelName },
        );

        // Step 1b-2: Print the model information as formatted JSON
        printLine(JSON.stringify(modelInfo, null, 2));
      } catch (error) {
        // Step 1b-3: Handle errors by printing error message
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "running": {
      // ===== CASE: List running models =====
      // Step 1: List all currently running models on the server

      // ===== STEP 1a: Try to fetch running models =====
      try {
        // Step 1a-1: Send running command to the server to fetch running models
        const response = await connection.sendCommand<{ models: unknown[] }>(
          "models.running",
          {},
        );

        // Step 1a-2: Print the list of running models as formatted JSON
        // Step 1a-3: Use null coalescing to default to empty array if models is undefined
        printLine(JSON.stringify(response.models ?? [], null, 2));
      } catch (error) {
        // Step 1a-4: Handle errors by printing error message
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    default:
      // ===== CASE: Unknown subcommand =====
      // Step 1: Print usage error for unknown subcommand
      printError(
        "Usage: /models list | find <name> | pull <name> | delete <name> | show <name> | running",
      );
  }
};
