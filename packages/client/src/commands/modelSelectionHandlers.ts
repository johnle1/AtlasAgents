/**
 * Model selection command handlers.
 *
 * This module handles commands for selecting advisor and agent models:
 * - /set advisor
 * - /set agent
 */

import { updateConfig } from "../config.js";
import type { Connection } from "../connection/index.js";
import type { PromptPort } from "../ui/promptPort.js";
import { printModels, printError, printSuccess } from "../renderer.js";

/**
 * <Summary>
 * What it does:
 *   Lets the user pick the advisor or agent model from the server's model list and saves it to config.
 *
 * How it does it (step by step):
 *   1. Fetches model names via Connection.listModels.
 *   2. Prints a numbered list and promptChoice for a 1-based index.
 *   3. On valid choice, updateConfig for advisorModel or agentModel, then Connection.reload.
 *
 * Parameters:
 *   @param {'advisor' | 'agent'} role — Which config field to update.
 *   @param {Connection} conn — RSocket connection for server communication.
 *   @param {PromptPort} prompts — For user prompts.
 *
 * Returns:
 *   @returns {Promise<void>} — called for side effects only.
 *
 * Dependencies:
 *   - Connection.listModels, Connection.reload — server list and reconnect with new models.
 *   - updateConfig — writes advisorModel or agentModel to disk.
 *   - promptChoice — numeric pick from the printed list.
 *   - renderer.printModels, printError, printSuccess — UI.
 *
 * Dependants:
 *   - configHandlers.handleSet — advisor and agent subcommands.
 * </Summary>
 */
export const handleSetModel = async (
  role: "advisor" | "agent",
  conn: Connection,
  prompts: PromptPort,
): Promise<void> => {
  let models: string[];
  try {
    // Fetch available models from server
    models = await conn.listModels();
  } catch (err) {
    printError(
      `Could not fetch models: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  // Check if any models are available
  if (models.length === 0) {
    printError("No models available on the server.");
    return;
  }

  // Display numbered list of models
  printModels(models, role);

  // Prompt user to pick a model by number
  const pickedNumber = await prompts.choose(
    `  Pick a number (1-${models.length}): `,
    models.length,
  );
  const choiceIndex = pickedNumber - 1;

  // Validate user choice
  if (choiceIndex < 0 || choiceIndex >= models.length) {
    printError("Cancelled — no change.");
    return;
  }

  // Get selected model and determine config key
  const selectedModel = models[choiceIndex];
  const configKey = role === "advisor" ? "advisorModel" : "agentModel";
  try {
    // Sync model choice to server
    await conn.sendCommand("config.set", {
      key: configKey,
      value: selectedModel,
    });
  } catch (err) {
    printError(
      `Failed to set ${role} model on server: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  const config = updateConfig({ [configKey]: selectedModel });
  conn.updateConfig(config);
  printSuccess(`${role} model set to ${selectedModel}`);
};
