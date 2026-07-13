/**
 * Interactive advisor/agent model picker used by `/set advisor` and `/set agent`.
 *
 * @remarks
 * Loads model names from the server, prompts for a numbered choice, writes
 * local config, syncs via `config.set`, then refreshes the Ink banner. Local
 * config rolls back if the server rejects the change.
 */

import { updateConfig, loadConfig } from "../config.js";
import type { Connection } from "../connection/index.js";
import type { PromptPort } from "../ui/promptPort.js";
import { refreshInkBanner } from "../ui/uiBridge.js";
import { printModels, printError, printSuccess, printLine } from "../renderer.js";
import { formatErrorMessage } from "./utils.js";

/**
 * Lets the user pick the advisor or agent model and persists the choice.
 *
 * @remarks
 * Order of operations matters for consistency:
 * 1. Fetch names (`listModels`)
 * 2. User picks a 1-based index (`prompts.choose`); out-of-range / cancel → no-op
 * 3. Write local config for `advisorModel` or `agentModel`
 * 4. Send `config.set` to the server
 * 5. Only then call `connection.updateConfig` + refresh the banner
 *
 * If step 4 fails, local config is restored to the previous model name. The
 * connection object is left alone on failure because it was never updated.
 *
 * When the server returns tool-capability flags, a short note explains whether
 * native tool calling is enabled for that role.
 *
 * @param modelRole - Which config field to update (`"advisor"` | `"agent"`).
 * @param connection - Live RSocket connection.
 * @param prompts - Numbered choice prompt port.
 *
 * @example
 * ```ts
 * await handleSetModel("advisor", connection, prompts);
 * await handleSetModel("agent", connection, prompts);
 * ```
 */
export const handleSetModel = async (
  modelRole: "advisor" | "agent",
  connection: Connection,
  prompts: PromptPort,
): Promise<void> => {
  let availableModels: string[];

  try {
    availableModels = await connection.listModels();
  } catch (error) {
    printError(`Could not fetch models: ${formatErrorMessage(error)}`);
    return;
  }

  if (availableModels.length === 0) {
    printError("No models available on the server.");
    return;
  }

  printModels(availableModels, modelRole);

  const selectedNumber = await prompts.choose(
    `  Pick a number (1-${availableModels.length}): `,
    availableModels.length,
  );

  // prompts.choose is 1-based; 0 / out-of-range means cancel.
  const modelIndex = selectedNumber - 1;
  if (modelIndex < 0 || modelIndex >= availableModels.length) {
    printError("Cancelled — no change.");
    return;
  }

  const selectedModelName = availableModels[modelIndex];
  const configKey = modelRole === "advisor" ? "advisorModel" : "agentModel";
  // Capture for rollback if the server rejects config.set.
  const previousModelName = loadConfig()[configKey] ?? "";

  let updatedConfig;
  try {
    updatedConfig = updateConfig({ [configKey]: selectedModelName });
  } catch (error) {
    printError(`Failed to save configuration: ${formatErrorMessage(error)}`);
    return;
  }

  try {
    const response = await connection.sendCommand<{
      ok: boolean;
      agentModelSupportsTools?: boolean;
      advisorModelSupportsTools?: boolean;
    }>("config.set", {
      key: configKey,
      value: selectedModelName,
    });

    // Defer in-memory Connection config until the server has accepted the change.
    connection.updateConfig(updatedConfig);
    refreshInkBanner(updatedConfig);
    printSuccess(`${modelRole} model set to ${selectedModelName}`);

    if (
      modelRole === "agent" &&
      typeof response.agentModelSupportsTools === "boolean"
    ) {
      printLine(
        response.agentModelSupportsTools
          ? "  native tool calling: enabled"
          : "  native tool calling: disabled (using <<TOOL>> text protocol)",
      );
    }

    if (
      modelRole === "advisor" &&
      typeof response.advisorModelSupportsTools === "boolean"
    ) {
      printLine(
        response.advisorModelSupportsTools
          ? "  native tool calling: enabled"
          : "  native tool calling: disabled (using inline JSON plan)",
      );
    }
  } catch (error) {
    // Local disk config moved ahead of server — undo so disk matches the live session.
    updateConfig({ [configKey]: previousModelName });
    printError(
      `Failed to set ${modelRole} model on server: ${formatErrorMessage(error)}`,
    );
    return;
  }
};
