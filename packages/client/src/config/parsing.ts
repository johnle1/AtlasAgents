/**
 * Boundary parsing: merges raw disk JSON with `DEFAULT_CONFIG` into a
 * complete `Config`, and decides whether the merged result needs to be
 * written back (missing keys, invalid `subagentCap`/`showThinkOutput`).
 */

import type { Config } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { parsePersistedApprovalMode } from "./approvalMode.js";
import { isSandboxMode } from "../fileProxy/sandbox/index.js";
import { isEffortLevel } from "@atlasagents/shared";

/**
 * Merges parsed config from disk with DEFAULT_CONFIG to fill missing keys.
 *
 * @remarks
 * This function ensures that the loaded config has all required fields by:
 * - Starting with DEFAULT_CONFIG as the base layer
 * - Overriding with parsed config values
 * - Validating showThinkOutput is boolean (otherwise use default)
 * - Validating subagentCap is positive integer (otherwise use default)
 * - Merging ui objects with defaults as base
 *
 * @param parsedConfig - Config object parsed from config.json.
 * @returns The merged configuration with all required fields.
 */
export const mergeConfigFromDisk = (parsedConfig: Partial<Config>): Config => ({
  ...DEFAULT_CONFIG,
  ...parsedConfig,
  showThinkOutput:
    typeof parsedConfig.showThinkOutput === "boolean"
      ? parsedConfig.showThinkOutput
      : DEFAULT_CONFIG.showThinkOutput,
  subagentCap:
    typeof parsedConfig.subagentCap === "number" &&
    Number.isInteger(parsedConfig.subagentCap) &&
    parsedConfig.subagentCap >= 1
      ? parsedConfig.subagentCap
      : DEFAULT_CONFIG.subagentCap,
  approvalMode: parsePersistedApprovalMode(parsedConfig.approvalMode),
  effort: isEffortLevel(parsedConfig.effort)
    ? parsedConfig.effort
    : DEFAULT_CONFIG.effort,
  ui: { ...DEFAULT_CONFIG.ui, ...parsedConfig.ui },
  sandbox: {
    ...DEFAULT_CONFIG.sandbox,
    ...parsedConfig.sandbox,
    mode: isSandboxMode(parsedConfig.sandbox?.mode)
      ? parsedConfig.sandbox.mode
      : DEFAULT_CONFIG.sandbox.mode,
  },
});

/**
 * Determines whether the config needs to be persisted back to disk.
 *
 * @remarks
 * This function checks if the loaded config needs corrections by:
 * - Checking if any DEFAULT_CONFIG keys are missing from stored config
 * - Checking if nested ui object is missing any keys
 * - Validating subagentCap is a positive integer
 * - Validating showThinkOutput is a boolean
 *
 * Returns true if any corrections are needed, indicating the config should be
 * re-saved to disk with the corrections applied.
 *
 * @param storedConfig - Raw config object read from disk.
 * @param parsedConfig - Parsed config with type information.
 * @returns true if config should be persisted, false otherwise.
 */
export const configNeedsPersist = (
  storedConfig: Record<string, unknown>,
  parsedConfig: Partial<Config>,
): boolean => {
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key === "ui" || key === "sandbox") {
      const nested = storedConfig[key];
      if (typeof nested !== "object" || nested === null) {
        return true;
      }
      const nestedObject = nested as Record<string, unknown>;
      const defaults = DEFAULT_CONFIG[key] as unknown as Record<string, unknown>;
      for (const nestedKey of Object.keys(defaults)) {
        if (!(nestedKey in nestedObject)) {
          return true;
        }
      }
      continue;
    }
    if (!(key in storedConfig)) {
      return true;
    }
  }
  if (
    parsedConfig.subagentCap !== undefined &&
    (typeof parsedConfig.subagentCap !== "number" ||
      !Number.isInteger(parsedConfig.subagentCap) ||
      parsedConfig.subagentCap < 1)
  ) {
    return true;
  }
  if (
    parsedConfig.showThinkOutput !== undefined &&
    typeof parsedConfig.showThinkOutput !== "boolean"
  ) {
    return true;
  }
  return false;
};
