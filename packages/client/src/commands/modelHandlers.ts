/**
 * Ollama model management slash commands under `/models`.
 *
 * @remarks
 * Subcommands talk to the server over RSocket: list/find use
 * {@link Connection.fetchModelsDetailed}; pull uses a progress stream;
 * delete/show/running are one-shot commands.
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
 * Routes `/models list | find | pull | delete | show | running`.
 *
 * @remarks
 * `find` does a case-insensitive substring match against installed model names.
 * `pull` resets/finishes the CLI progress UI even on failure so spinners do not
 * leak. Errors are printed and not rethrown.
 *
 * @param subcommand - Operation name after `/models`.
 * @param modelArgument - Model name for find/pull/delete/show.
 * @param connection - Live RSocket connection.
 *
 * @example
 * ```ts
 * await handleModels("list", "", connection);
 * await handleModels("pull", "gemma3:4b", connection);
 * await handleModels("find", "gemma", connection);
 * ```
 */
export const handleModels = async (
  subcommand: string,
  modelArgument: string,
  connection: Connection,
): Promise<void> => {
  const modelName = modelArgument.trim();

  switch (subcommand) {
    case "list": {
      try {
        const models = await connection.fetchModelsDetailed();
        printInstalledModels(models);
      } catch (error) {
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "find": {
      if (!modelName) {
        printError("Usage: /models find <name>");
        return;
      }

      try {
        const models = await connection.fetchModelsDetailed();
        const foundModel = models.find((model) =>
          model.name.toLowerCase().includes(modelName.toLowerCase()),
        );
        printModelFind(modelName, foundModel, models);
      } catch (error) {
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "pull": {
      if (!modelName) {
        printError("Usage: /models pull <name>");
        return;
      }

      try {
        printLine(`Pulling model: ${modelName}`);
        printLine(
          "This may take a while depending on your connection and model size...",
        );
        logger.blank();
        resetPullProgress(modelName);

        let pullFailed = false;

        await connection.sendStream({
          kind: "models.pull",
          payload: { name: modelName },
          onFrame: (frame) => {
            if (frame.kind === "progress" && frame.data) {
              // printProgress returns true when the frame indicates terminal failure.
              if (printProgress(frame.data, modelName)) {
                pullFailed = true;
              }
            } else if (frame.kind === "error") {
              finishPullProgress(modelName);
              printError(frame.message);
              pullFailed = true;
            }
          },
        });

        finishPullProgress(modelName);
        if (!pullFailed) {
          printSuccess(`Model pulled successfully: ${modelName}`);
        }
      } catch (error) {
        // Always clear progress UI — otherwise a hung bar survives the error path.
        finishPullProgress(modelName);
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "delete": {
      if (!modelName) {
        printError("Usage: /models delete <name>");
        return;
      }

      try {
        // ===== SEND DELETE REQUEST AND CAPTURE RESPONSE =====
        // Step 1: Send delete command and capture warnings about stale config
        const response = await connection.sendCommand<{
          ok: boolean;
          wasAdvisorModel?: boolean;
          wasAgentModel?: boolean;
        }>("models.delete", { name: modelName });

        // ===== DISPLAY SUCCESS AND ANY WARNINGS =====
        // Step 2: Print success message
        printSuccess(`Deleted ${modelName}`);

        // Step 3: Warn if deleted model was the active advisor model
        if (response.wasAdvisorModel) {
          printLine(
            "⚠ Warning: This was your active advisor model. Run /set advisor to choose a new one.",
          );
        }

        // Step 4: Warn if deleted model was the active agent model
        if (response.wasAgentModel) {
          printLine(
            "⚠ Warning: This was your active agent model. Run /set agent to choose a new one.",
          );
        }
      } catch (error) {
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "show": {
      if (!modelName) {
        printError("Usage: /models show <name>");
        return;
      }

      try {
        const modelInfo = await connection.sendCommand<Record<string, unknown>>(
          "models.show",
          { name: modelName },
        );
        printLine(JSON.stringify(modelInfo, null, 2));
      } catch (error) {
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "running": {
      try {
        const response = await connection.sendCommand<{ models: unknown[] }>(
          "models.running",
          {},
        );
        printLine(JSON.stringify(response.models ?? [], null, 2));
      } catch (error) {
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    default:
      printError(
        "Usage: /models list | find <name> | pull <name> | delete <name> | show <name> | running",
      );
  }
};
