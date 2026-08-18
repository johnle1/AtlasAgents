/**
 * Probes Ollama model capabilities and persists whether each model supports native tool calling.
 *
 * @remarks
 * At startup and when switching models, AtlasAgents needs to know whether a model
 * supports native tool calling (function calling). This module provides three
 * high-level functions that:
 * 1. Query Ollama's `/api/show/<model>` endpoint for the model's capabilities
 * 2. Check if "tools" is in the capabilities array (via `modelSupportsNativeTools()`)
 * 3. Persist the result in config under a role-specific key
 *
 * The implementation is graceful: if the probe fails (Ollama down, network error),
 * it logs a warning and returns the existing cached value instead of crashing.
 *
 * Two roles exist: `agent` (lead orchestrator) and `subagent` (task workers), each
 * with its own config flag (`agentModelSupportsTools`, `subagentModelSupportsTools`).
 */

import type { ConfigRole } from "../config/index.js";
import type { IConfigManager } from "../orchestration/interfaces/configInterfaces.js";
import type { IOllamaAdminClient } from "../orchestration/interfaces/ollamaInterfaces.js";
import { logger } from "../utils/logger.js";
import { modelSupportsNativeTools } from "./modelCapabilities.js";

/**
 * Maps orchestrator roles to their config flag names.
 *
 * @remarks
 * Ensures each role (agent vs. subagent) has its own persisted flag.
 * This lets the system use different models for different purposes and
 * cache each model's capability separately.
 */
const TOOL_SUPPORT_CONFIG_KEY: Record<
  ConfigRole,
  "agentModelSupportsTools" | "subagentModelSupportsTools"
> = {
  agent: "agentModelSupportsTools",
  subagent: "subagentModelSupportsTools",
};

/**
 * Type union representing either an agent-role or subagent-role config.
 *
 * @remarks
 * Used to type-safely pass config objects to generic functions like
 * `syncModelToolSupport` without having to know upfront which role
 * we're working with.
 */
type ToolSupportConfig =
  | Pick<IConfigManager, "set" | "getAgentModelSupportsTools">
  | Pick<IConfigManager, "set" | "getSubagentModelSupportsTools">;

/**
 * Retrieves the cached tool-support flag for a given role.
 *
 * @remarks
 * Reads the appropriate getter method from config based on the role.
 * This is a helper to avoid duplicating role-dispatch logic.
 *
 * @param config - Config manager (must have the getter for this role).
 * @param role - Either `"agent"` or `"subagent"`.
 * @returns The cached tool-support boolean for this role.
 */
const getExistingToolSupport = async (
  config: ToolSupportConfig,
  role: ConfigRole,
): Promise<boolean> =>
  role === "agent"
    ? (
        config as Pick<IConfigManager, "getAgentModelSupportsTools">
      ).getAgentModelSupportsTools()
    : (
        config as Pick<IConfigManager, "getSubagentModelSupportsTools">
      ).getSubagentModelSupportsTools();

/**
 * Probes a model's tool-calling capability and persists the result to config.
 *
 * @remarks
 * The core logic: asks Ollama if the model supports native tool calling,
 * then stores the answer in config under the appropriate role-specific key.
 *
 * **Resilience:** If the probe fails (Ollama unreachable, network error, etc.),
 * logs a warning and returns the previously cached value — the system keeps
 * working with stale data rather than crashing.
 *
 * **Empty model:** If the model name is blank after trimming, returns the
 * existing cached value without probing (avoids querying Ollama with "").
 *
 * @param ollama - Ollama admin client (for querying `/api/show`).
 * @param config - Config manager with getter/setter for this role's flag.
 * @param role - Either `"agent"` or `"subagent"`, determines which flag to update.
 * @param modelName - Model to probe (e.g., "llama3:8b", "gemma3:27b").
 * @returns True if the model supports native tool calling, false otherwise.
 *   On probe failure, returns the cached value from config.
 *
 * @example
 * ```ts
 * const supports = await syncModelToolSupport(
 *   ollama,
 *   config,
 *   "subagent",
 *   "gemma3:27b"
 * );
 * if (supports) {
 *   console.log("Can use native tool calling");
 * }
 * ```
 */
export const syncModelToolSupport = async (
  ollama: Pick<IOllamaAdminClient, "showModel">,
  config: ToolSupportConfig,
  role: ConfigRole,
  modelName: string,
): Promise<boolean> => {
  const trimmed = modelName.trim();
  // EARLY RETURN: Empty model name — use cached value instead of probing.
  if (trimmed.length === 0) {
    return getExistingToolSupport(config, role);
  }

  // Look up the config flag name for this role (e.g., "subagentModelSupportsTools" for subagent).
  const configKey = TOOL_SUPPORT_CONFIG_KEY[role];

  try {
    // PROBE: Query Ollama for model metadata, including capabilities.
    const info = await ollama.showModel(trimmed);

    // CHECK: Does the model support tool calling?
    const supports = modelSupportsNativeTools(info);

    // PERSIST: Write the result to config so we remember it on next startup.
    await config.set(configKey, supports);

    return supports;
  } catch (error) {
    // DEGRADATION: Ollama probe failed — log it but don't crash.
    // Return the cached value so the system keeps working with stale data.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { model: trimmed, role, err: message },
      `Could not probe model tool capabilities; keeping existing ${configKey}`,
    );
    return getExistingToolSupport(config, role);
  }
};

/**
 * Probes the lead agent model's tool-calling capability.
 *
 * @remarks
 * Convenience wrapper for the `"agent"` role. Queries Ollama and persists
 * to the `agentModelSupportsTools` config flag.
 *
 * @param ollama - Ollama admin client.
 * @param config - Config manager (must have agent-level getters/setters).
 * @param modelName - Agent model to probe.
 * @returns True if the agent model supports native tool calling.
 *
 * @example
 * ```ts
 * const supports = await syncAgentToolSupport(ollama, config, "llama3:70b");
 * ```
 */
export const syncAgentToolSupport = async (
  ollama: Pick<IOllamaAdminClient, "showModel">,
  config: Pick<IConfigManager, "set" | "getAgentModelSupportsTools">,
  modelName: string,
): Promise<boolean> => syncModelToolSupport(ollama, config, "agent", modelName);

/**
 * Probes the subagent model's tool-calling capability.
 *
 * @remarks
 * Convenience wrapper for the `"subagent"` role. Queries Ollama and persists
 * to the `subagentModelSupportsTools` config flag.
 *
 * @param ollama - Ollama admin client.
 * @param config - Config manager (must have subagent-level getters/setters).
 * @param modelName - Subagent model to probe.
 * @returns True if the subagent model supports native tool calling.
 *
 * @example
 * ```ts
 * const supports = await syncSubagentToolSupport(ollama, config, "gemma3:27b");
 * ```
 */
export const syncSubagentToolSupport = async (
  ollama: Pick<IOllamaAdminClient, "showModel">,
  config: Pick<IConfigManager, "set" | "getSubagentModelSupportsTools">,
  modelName: string,
): Promise<boolean> =>
  syncModelToolSupport(ollama, config, "subagent", modelName);

/**
 * Deprecated alias for `syncAgentToolSupport`.
 *
 * @remarks
 * "Advisor" was this role's name before the agent/subagent rename. Kept for
 * backwards compatibility. Use `syncAgentToolSupport` in new code.
 *
 * @deprecated Use `syncAgentToolSupport` instead.
 */
export const syncAdvisorToolSupport = syncAgentToolSupport;
