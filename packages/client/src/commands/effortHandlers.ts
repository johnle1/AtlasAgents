/**
 * Interactive agent effort picker used by `/effort`.
 *
 * @remarks
 * Mirrors `handleSetModel`'s (`modelSelectionHandlers.ts`) write-then-confirm
 * sequence: write local config, send the change to the server, only then
 * treat it as committed — on server rejection, roll local config back to
 * the previous value. Unlike model selection, this is the first client
 * command to use the generic `config.set` RPC
 * (`packages/server/src/routing/routerBuilder.ts`'s `createSetConfigHandler`)
 * rather than a role-specific one — no server change was needed for it.
 */

import { updateConfig, loadConfig } from "../config/index.js";
import type { Connection } from "../connection/index.js";
import type { PromptPort } from "../ui/promptPort.js";
import { printError, printSuccess } from "../renderer.js";
import { formatErrorMessage } from "./utils.js";
import { EFFORT_LEVELS } from "@atlasagents/shared";
import { EFFORT_OPTION_COLORS } from "./effortOptionColors.js";

/**
 * Lets the user pick the agent's effort level (how much the REASON phase
 * re-deliberates before acting — see `EffortLevel`'s doc comment in
 * `@atlasagents/shared`) and persists the choice.
 *
 * @remarks
 * Order of operations mirrors `handleSetModel`:
 * 1. Load the current effort, find its index in `EFFORT_LEVELS`.
 * 2. User picks via the horizontal option bar (`prompts.pickOption`, the
 *    same shared picker `/model` uses); cancel (Esc) → no-op.
 * 3. Write local config.
 * 4. Send `config.set` to the server.
 * 5. Roll local config back if the server rejects the change.
 *
 * @param connection - Live RSocket connection.
 * @param prompts - Prompt port backing the option-bar overlay.
 *
 * @example
 * ```ts
 * await handleSetEffort(connection, prompts);
 * ```
 */
export const handleSetEffort = async (
  connection: Connection,
  prompts: PromptPort,
): Promise<void> => {
  const currentEffort = loadConfig().effort ?? "medium";
  const currentIndex = EFFORT_LEVELS.indexOf(currentEffort);

  const selectedIndex = await prompts.pickOption(
    "Pick agent effort",
    EFFORT_LEVELS.slice(),
    currentIndex >= 0 ? currentIndex : 0,
    [...EFFORT_OPTION_COLORS],
  );

  if (selectedIndex === null) {
    printError("Cancelled — no change.");
    return;
  }

  const effort = EFFORT_LEVELS[selectedIndex]!;

  // Capture for rollback if the server rejects config.set.
  const previousConfig = loadConfig();
  const previousEffort = previousConfig.effort;
  const previousConfigChangedAt = previousConfig.configChangedAt;

  let updatedConfig;
  try {
    updatedConfig = updateConfig({
      effort,
      // Stamped here (not by updateConfig generically) for the same reason
      // handleSetModel stamps it — see config/types.ts's configChangedAt
      // doc comment.
      configChangedAt: Date.now(),
    });
  } catch (error) {
    printError(`Failed to save configuration: ${formatErrorMessage(error)}`);
    return;
  }

  try {
    await connection.sendCommand<{ ok: boolean }>("config.set", {
      key: "effort",
      value: effort,
    });

    // Defer in-memory Connection config until the server has accepted the change.
    connection.updateConfig(updatedConfig);
    printSuccess(`agent effort set to ${effort}`);
  } catch (error) {
    // Local disk config moved ahead of server — undo so disk matches the live session.
    updateConfig({
      effort: previousEffort,
      configChangedAt: previousConfigChangedAt,
    });
    printError(
      `Failed to set agent effort on server: ${formatErrorMessage(error)}`,
    );
    return;
  }
};
