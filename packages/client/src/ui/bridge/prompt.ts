/**
 * User text/choice prompt request management for the Ink CLI UI.
 *
 * @remarks
 * This module coordinates user prompts and inputs (like text inputs, select lists,
 * and theme options) between the back-end services and the React UI. When the CLI
 * is run non-interactively, prompts are resolved with sensible defaults.
 */

import type { PromptRequest, PromptResult } from "../types.js";
import { getInkUIActive, getBridgeHooks } from "./state.js";
import { getPendingPromptEntry, setPendingPromptEntry } from "./state.js";

/**
 * Fallback result for a prompt type when no user is available to answer it
 * (Ink UI inactive, or a pending prompt is being force-cancelled).
 *
 * @param promptType - The `type` field of the {@link PromptRequest}.
 * @returns The default {@link PromptResult} for that type.
 */
const defaultPromptResult = (promptType: PromptRequest["type"]): PromptResult => {
  if (promptType === "choice") return 0;
  if (promptType === "planFeedback") return "";
  if (promptType === "theme") return undefined;
  return "";
};

/**
 * Retrieves the currently pending prompt request from the state registry.
 *
 * @returns The pending prompt request details, or `null` if no prompt is active.
 */
export const getPendingPrompt = (): PromptRequest | null =>
  getPendingPromptEntry()?.req ?? null;

/**
 * Requests user input or choice, returning a promise that resolves with the user's response.
 *
 * @remarks
 * If the Ink interface is inactive, this function resolves immediately with a default fallback
 * value matching the requested prompt type.
 *
 * @param promptRequest - The prompt details to present to the user.
 * @returns A promise resolving to the user's response (number, string, or undefined).
 * @throws {@link Error} If another prompt request is already pending.
 */
export const requestPrompt = (
  promptRequest: PromptRequest,
): Promise<PromptResult> => {
  const isUIActive = getInkUIActive();
  if (!isUIActive) {
    return Promise.resolve(defaultPromptResult(promptRequest.type));
  }

  const existingPendingPrompt = getPendingPromptEntry();
  if (existingPendingPrompt !== null) {
    return Promise.reject(new Error("Prompt request already pending"));
  }

  return new Promise((resolvePromptFunction) => {
    setPendingPromptEntry({
      req: promptRequest,
      resolve: resolvePromptFunction,
    });

    getBridgeHooks().onPromptChange?.(promptRequest);
  });
};

/**
 * Resolves the currently pending prompt request with the user's input.
 *
 * @param promptResult - The user's input/choice response.
 */
export const resolvePrompt = (promptResult: PromptResult): void => {
  const currentPendingPrompt = getPendingPromptEntry();

  setPendingPromptEntry(null);
  getBridgeHooks().onPromptChange?.(null);

  currentPendingPrompt?.resolve(promptResult);
};

/**
 * Cancels all pending prompt requests, resolving them with default fallback values.
 *
 * @remarks
 * Typically called when the terminal session disconnects or is interrupted.
 */
export const cancelPendingPrompts = (): void => {
  const currentPendingPrompt = getPendingPromptEntry();
  if (!currentPendingPrompt) return;

  setPendingPromptEntry(null);
  getBridgeHooks().onPromptChange?.(null);

  const promptResult = defaultPromptResult(currentPendingPrompt.req.type);
  currentPendingPrompt.resolve(promptResult);
};

