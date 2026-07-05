/**
 * <Summary>
 * What it does:
 *   Handles model selection command handlers for the CLI.
 *
 * How it fits in the system:
 *   This module provides command handlers for selecting advisor and agent models through the CLI.
 *   It fetches available models from the server, displays them to the user, and allows the user
 *   to select a model. The selected model is then saved to the local configuration and synced to
 *   the server. The banner is also refreshed to reflect the updated configuration.
 * </Summary>
 */

import { updateConfig, loadConfig } from "../config.js";
import type { Connection } from "../connection/index.js";
import type { PromptPort } from "../ui/promptPort.js";
import { refreshInkBanner } from "../ui/uiBridge.js";
import { printModels, printError, printSuccess } from "../renderer.js";
import { formatErrorMessage } from "./utils.js";

/**
 * <Summary>
 * What it does:
 *   Lets the user pick the advisor or agent model from the server's model list and saves it to config.
 *
 * How it does it (step by step):
 *   1. Fetch available model names from the server via Connection.listModels.
 *   2. Handle errors if model fetch fails.
 *   3. Check if any models are available on the server.
 *   4. Display a numbered list of models using renderer.printModels.
 *   5. Prompt the user to select a model by number using promptChoice.
 *   6. Validate the user's choice is within the valid range.
 *   7. Get the selected model name from the array.
 *   8. Determine the configuration key based on the role (advisorModel or agentModel).
 *   9. Capture the previous model name for rollback.
 *   10. Update the local configuration with the selected model.
 *   11. Update the connection with the new configuration.
 *   12. Sync the model choice to the server using Connection.sendCommand.
 *   13. Roll back local config if server sync fails.
 *   14. Refresh the banner to reflect the updated configuration.
 *   15. Print a success message to the user.
 *
 * Parameters:
 * @param modelRole - Which configuration field to update ("advisor" for advisorModel, "agent" for agentModel).
 * @param connection - RSocket connection for server communication.
 * @param prompts - Prompt port for user interaction and selection.
 *
 * Returns:
 * @returns Promise that resolves after setting the model (called for side effects only).
 * </Summary>
 */
export const handleSetModel = async (
  modelRole: "advisor" | "agent",
  connection: Connection,
  prompts: PromptPort,
): Promise<void> => {
  // ===== STEP 1: Fetch available models from server =====
  let availableModels: string[];

  // Step 1a: Wrap in try-catch to handle network errors gracefully
  try {
    // Step 1b: Fetch the list of available model names from the server
    availableModels = await connection.listModels();
  } catch (error) {
    // Step 1c: Handle errors by printing error message and exiting
    // Step 1d: Extract error message if it's an Error object, otherwise use the error itself
    printError(`Could not fetch models: ${formatErrorMessage(error)}`);
    return;
  }

  // ===== STEP 2: Check if models are available =====
  // Step 2a: Check if any models are available on the server
  if (availableModels.length === 0) {
    // Step 2b: Print error message if no models are available
    printError("No models available on the server.");
    return;
  }

  // ===== STEP 3: Display model list to user =====
  // Step 3a: Display a numbered list of available models to the user
  // Step 3b: The role is used for display context (advisor vs agent selection)
  printModels(availableModels, modelRole);

  // ===== STEP 4: Prompt user to select a model =====
  // Step 4a: Prompt the user to pick a model by entering a number
  // Step 4b: The range is from 1 to the number of available models (1-based index)
  const selectedNumber = await prompts.choose(
    `  Pick a number (1-${availableModels.length}): `,
    availableModels.length,
  );

  // Step 4c: Convert from 1-based index to 0-based index for array access
  const modelIndex = selectedNumber - 1;

  // ===== STEP 5: Validate user choice =====
  // Step 5a: Check if the user's choice is within the valid range
  // Step 5b: Invalid choice (including 0 from cancellation) results in no change
  if (modelIndex < 0 || modelIndex >= availableModels.length) {
    // Step 5c: Print message that the selection was cancelled
    printError("Cancelled — no change.");
    return;
  }

  // ===== STEP 6: Get selected model and determine config key =====
  // Step 6a: Get the selected model name from the array using the validated index
  const selectedModelName = availableModels[modelIndex];

  // Step 6b: Determine the configuration key based on the role
  // Step 6c: For advisor role, use "advisorModel"; for agent role, use "agentModel"
  const configKey = modelRole === "advisor" ? "advisorModel" : "agentModel";
  const previousModelName = loadConfig()[configKey] ?? "";

  // ===== STEP 7: Update local configuration =====
  let updatedConfig;
  try {
    updatedConfig = updateConfig({ [configKey]: selectedModelName });
  } catch (error) {
    printError(`Failed to save configuration: ${formatErrorMessage(error)}`);
    return;
  }

  // ===== STEP 8: Sync model choice to server FIRST =====
  try {
    await connection.sendCommand("config.set", {
      key: configKey,
      value: selectedModelName,
    });
    // Only update connection after server confirms the change
    connection.updateConfig(updatedConfig);
  } catch (error) {
    // Roll back local config since server sync failed
    const rolledBack = updateConfig({ [configKey]: previousModelName });
    // Note: connection.updateConfig is not called here because it was only updated
    // after successful server sync (line 157), so the connection still has the correct config
    printError(
      `Failed to set ${modelRole} model on server: ${formatErrorMessage(error)}`,
    );
    return;
  }

  // ===== STEP 9: Refresh banner to reflect changes =====
  // Step 9a: Refresh the banner to display the updated model configuration
  refreshInkBanner(updatedConfig);

  // ===== STEP 11: Print success message =====
  // Step 11a: Print a success message to confirm the model was set
  printSuccess(`${modelRole} model set to ${selectedModelName}`);
};
