/**
 * Interactive agent/subagent model picker used by `/set agent` and `/set subagent`.
 *
 * @remarks
 * Loads provider-grouped model names from the server, prompts for a numbered
 * choice, writes local config, syncs via `config.setModel`, then refreshes the
 * Ink banner. Local config rolls back if the server rejects the change.
 */

import { updateConfig, loadConfig } from "../config/index.js";
import type { Connection } from "../connection/index.js";
import type { PromptPort } from "../ui/promptPort.js";
import { refreshInkBanner } from "../ui/uiBridge.js";
import { printGroupedModels, printError, printSuccess, printLine } from "../renderer.js";
import type { ModelGroup, CurrentModelSelection } from "../renderer.js";
import { formatErrorMessage } from "./utils.js";

/**
 * Lets the user pick the agent or subagent model (from any configured
 * provider) and persists the choice.
 *
 * @remarks
 * Order of operations matters for consistency:
 * 1. Fetch provider-grouped models (`providers.listModels`)
 * 2. User picks a 1-based index (`prompts.choose`); out-of-range / cancel → no-op
 * 3. Write local config for `subagentModel`/`agentProvider` (or subagent equivalents)
 * 4. Send `config.setModel` to the server
 * 5. Only then call `connection.updateConfig` + refresh the banner
 *
 * If step 4 fails, local config is restored to the previous provider/model. The
 * connection object is left alone on failure because it was never updated.
 *
 * When the server returns a tool-capability flag, a short note explains
 * whether native tool calling is enabled for that role.
 *
 * @param modelRole - Which config fields to update (`"agent"` | `"subagent"`).
 * @param connection - Live RSocket connection.
 * @param prompts - Numbered choice prompt port.
 *
 * @example
 * ```ts
 * await handleSetModel("agent", connection, prompts);
 * await handleSetModel("subagent", connection, prompts);
 * ```
 */
export const handleSetModel = async (
  modelRole: "agent" | "subagent",
  connection: Connection,
  prompts: PromptPort,
): Promise<void> => {
  let groups: ModelGroup[];

  try {
    const response = await connection.sendCommand<{ groups: ModelGroup[] }>(
      "providers.listModels",
      {},
    );
    groups = response.groups;
  } catch (error) {
    printError(`Could not fetch models: ${formatErrorMessage(error)}`);
    return;
  }

  // Config's on-disk field names are shifted by one role relative to their
  // meaning: `subagentModel`/`agentProvider` hold the *agent's* selection,
  // `subsubagentModel`/`subagentProvider` hold the *subagent's* — see the
  // wire translation in requestStream.ts. Building `current` here (rather
  // than trusting field names at the call site) keeps that footgun local.
  //
  // Trim before the presence check — whitespace-only strings are truthy but
  // mean "not set" everywhere else (Banner, useSubmitLine). Passing them
  // through would mark the wrong picker rows (or mark none usefully).
  const existingConfig = loadConfig();
  const agentModel = (existingConfig.subagentModel ?? "").trim();
  const subagentModel = (existingConfig.subsubagentModel ?? "").trim();
  const current: CurrentModelSelection = {
    ...(agentModel
      ? {
          agent: {
            provider: existingConfig.agentProvider,
            model: agentModel,
          },
        }
      : {}),
    ...(subagentModel
      ? {
          subagent: {
            provider: existingConfig.subagentProvider,
            model: subagentModel,
          },
        }
      : {}),
  };

  const entries = printGroupedModels(groups, modelRole, current);

  if (entries.length === 0) {
    printError("No models available on any configured provider.");
    return;
  }

  const selectedNumber = await prompts.choose(
    `  Pick a number (1-${entries.length}): `,
    entries.length,
  );

  // prompts.choose is 1-based; 0 / out-of-range means cancel.
  const entryIndex = selectedNumber - 1;
  if (entryIndex < 0 || entryIndex >= entries.length) {
    printError("Cancelled — no change.");
    return;
  }

  const { provider: selectedProvider, model: selectedModelName } =
    entries[entryIndex];
  const modelKey = modelRole === "agent" ? "subagentModel" : "subsubagentModel";
  const providerKey =
    modelRole === "agent" ? "agentProvider" : "subagentProvider";

  // Capture for rollback if the server rejects config.setModel.
  const previousConfig = loadConfig();
  const previousModelName = previousConfig[modelKey] ?? "";
  const previousProvider = previousConfig[providerKey] ?? "ollama";

  let updatedConfig;
  try {
    updatedConfig = updateConfig({
      [modelKey]: selectedModelName,
      [providerKey]: selectedProvider,
    });
  } catch (error) {
    printError(`Failed to save configuration: ${formatErrorMessage(error)}`);
    return;
  }

  try {
    const response = await connection.sendCommand<{
      ok: boolean;
      supportsTools?: boolean;
      placementWarning?: string;
    }>("config.setModel", {
      role: modelRole,
      provider: selectedProvider,
      model: selectedModelName,
    });

    // Defer in-memory Connection config until the server has accepted the change.
    connection.updateConfig(updatedConfig);
    refreshInkBanner(updatedConfig);
    printSuccess(
      `${modelRole} model set to ${selectedModelName} (${selectedProvider})`,
    );

    if (typeof response.supportsTools === "boolean") {
      printLine(
        response.supportsTools
          ? "  native tool calling: enabled"
          : "  native tool calling: disabled (using inline/legacy text protocol)",
      );
    }

    if (response.placementWarning) {
      printLine(response.placementWarning);
    }
  } catch (error) {
    // Local disk config moved ahead of server — undo so disk matches the live session.
    updateConfig({
      [modelKey]: previousModelName,
      [providerKey]: previousProvider,
    });
    printError(
      `Failed to set ${modelRole} model on server: ${formatErrorMessage(error)}`,
    );
    return;
  }
};
