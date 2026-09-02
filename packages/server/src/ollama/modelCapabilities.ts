/**
 * Detects whether an Ollama model supports native tool calling.
 *
 * @remarks
 * Ollama's `GET /api/show/<model>` endpoint returns a `capabilities` array
 * listing features the model supports. If "tools" is present, the model can
 * handle function-calling requests (i.e., the agent can send structured tool
 * schemas and expect back structured tool calls). If absent, the agent must
 * fall back to text-based tool calling (embedding tool descriptions in the
 * prompt and parsing the model's text output).
 *
 * This check is performed at server startup and then cached in config
 * so we don't probe the model on every request.
 *
 * @example
 * ```ts
 * const info = await ollama.showModel("gemma3:27b");
 * if (modelSupportsNativeTools(info)) {
 *   console.log("Can use native tool calling");
 * } else {
 *   console.log("Must use text-based tool calling");
 * }
 * ```
 */

import type { ModelInfo } from "./types.js";

/**
 * Checks if a model supports native tool calling based on its Ollama capabilities.
 *
 * @param info - Model metadata returned by `ollama.showModel()`.
 * @returns True if the `capabilities` array includes `"tools"`, false otherwise.
 *   Returns false if `capabilities` is missing or not an array.
 *
 * @example
 * ```ts
 * const supports = modelSupportsNativeTools({
 *   capabilities: ["completion", "tools"]
 * });
 * console.log(supports); // true
 *
 * const noTools = modelSupportsNativeTools({
 *   capabilities: ["completion"]
 * });
 * console.log(noTools); // false
 * ```
 */
export const modelSupportsNativeTools = (info: ModelInfo): boolean => {
  const caps = info.capabilities;
  // GUARD: Ensure capabilities exists and is an array before checking for "tools".
  // Some models or misconfigured servers may omit this field entirely.
  return Array.isArray(caps) && caps.includes("tools");
};

/**
 * Checks if a model supports Ollama's extended `think` mode based on its capabilities.
 *
 * @remarks
 * Ollama's `/api/show` reports `"thinking"` in the `capabilities` array for
 * reasoning-capable models (e.g. deepseek-r1, qwq). Requesting `think` on a
 * model that lacks this capability fails the chat request outright with an
 * HTTP 400 (`"<model>" does not support thinking`), so callers must gate on
 * this before setting `think: true` on the request.
 *
 * @param info - Model metadata returned by `ollama.showModel()`.
 * @returns True if the `capabilities` array includes `"thinking"`, false otherwise.
 *   Returns false if `capabilities` is missing or not an array.
 *
 * @example
 * ```ts
 * const supports = modelSupportsThinking({
 *   capabilities: ["completion", "thinking"]
 * });
 * console.log(supports); // true
 * ```
 */
export const modelSupportsThinking = (info: ModelInfo): boolean => {
  const caps = info.capabilities;
  return Array.isArray(caps) && caps.includes("thinking");
};
