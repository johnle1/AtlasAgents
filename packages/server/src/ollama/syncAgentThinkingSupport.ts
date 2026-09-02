/**
 * Probes the agent model's capabilities and persists whether it supports Ollama's `think` mode.
 *
 * @remarks
 * The agent's planning call always requests reasoning output. Ollama rejects
 * `think: true` outright (HTTP 400) for any model that doesn't advertise the
 * `"thinking"` capability, so the agent must know in advance whether it's
 * safe to ask for it. Mirrors {@link syncAgentToolSupport} in
 * `syncAgentToolSupport.ts` — same probe-then-persist shape, same graceful
 * degradation on probe failure — but only the agent role needs it: the
 * subagent's execution call deliberately never requests `think` (see the
 * `includeThinking` comment in `subagent.ts`), so there is no subagent
 * variant here.
 */

import type { IConfigManager } from "../orchestration/interfaces/configInterfaces.js";
import type { IOllamaAdminClient } from "../orchestration/interfaces/ollamaInterfaces.js";
import { logger } from "../utils/logger.js";
import { modelSupportsThinking } from "./modelCapabilities.js";

/**
 * Probes the lead agent model's thinking-mode capability and persists the result to config.
 *
 * @remarks
 * **Resilience:** If the probe fails (Ollama unreachable, network error, etc.),
 * logs a warning and returns the previously cached value — the system keeps
 * working with stale data rather than crashing.
 *
 * **Empty model:** If the model name is blank after trimming, returns the
 * existing cached value without probing (avoids querying Ollama with "").
 *
 * @param ollama - Ollama admin client (for querying `/api/show`).
 * @param config - Config manager with getter/setter for `agentModelSupportsThinking`.
 * @param modelName - Agent model to probe (e.g., "deepseek-r1:7b", "qwen:4b").
 * @returns True if the agent model supports Ollama's `think` mode, false otherwise.
 *   On probe failure, returns the cached value from config.
 *
 * @example
 * ```ts
 * const supportsThinking = await syncAgentThinkingSupport(
 *   ollama,
 *   config,
 *   "deepseek-r1:7b",
 * );
 * ```
 */
export const syncAgentThinkingSupport = async (
  ollama: Pick<IOllamaAdminClient, "showModel">,
  config: Pick<IConfigManager, "set" | "getAgentModelSupportsThinking">,
  modelName: string,
): Promise<boolean> => {
  const trimmed = modelName.trim();
  // EARLY RETURN: Empty model name — use cached value instead of probing.
  if (trimmed.length === 0) {
    return config.getAgentModelSupportsThinking();
  }

  try {
    // PROBE: Query Ollama for model metadata, including capabilities.
    const info = await ollama.showModel(trimmed);

    // CHECK: Does the model support extended thinking?
    const supports = modelSupportsThinking(info);

    // PERSIST: Write the result to config so we remember it on next startup.
    await config.set("agentModelSupportsThinking", supports);

    return supports;
  } catch (error) {
    // DEGRADATION: Ollama probe failed — log it but don't crash.
    // Return the cached value so the system keeps working with stale data.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { model: trimmed, err: message },
      "Could not probe agent model thinking capability; keeping existing agentModelSupportsThinking",
    );
    return config.getAgentModelSupportsThinking();
  }
};
