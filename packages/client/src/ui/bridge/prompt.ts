/**
 * <Summary>
 * What it does:
 *   Provides functions for managing user prompt requests in the Ink-based CLI UI.
 *
 * How it fits in the system:
 *   This module handles the prompt workflow where the server requests user input
 *   for actions like text input, choice selection, plan editing, or theme selection.
 *   It manages pending prompt state, routes requests to the UI, and resolves prompts
 * with user responses.
 *
 * Dependencies:
 *   - getInkUIActive — checks if the Ink UI is currently active.
 *   - getBridgeHooks — provides access to global state update hooks.
 *   - getPendingPromptEntry/setPendingPromptEntry — manages pending prompt state.
 *
 * Dependants:
 *   - Server communication handlers — call these functions to request user input.
 *   - PromptOverlay component — displays pending prompt requests to users.
 * </Summary>
 */

import type { PromptRequest, PromptResult } from "../types.js";
import { getInkUIActive, getBridgeHooks } from "./state.js";
import { getPendingPromptEntry, setPendingPromptEntry } from "./state.js";

/**
 * <Summary>
 * What it does:
 *   Retrieves the currently pending prompt request, if any.
 *
 * How it does it (step by step):
 *   1. Gets the pending prompt entry from state.
 *   2. Extracts the request object from the entry.
 *   3. Returns null if no prompt is pending.
 *
 * Returns:
 *   @returns {PromptRequest | null} — The pending prompt request or null.
 *
 * Dependencies:
 *   - getPendingPromptEntry — retrieves the pending prompt state entry.
 *
 * Dependants:
 *   - PromptOverlay component — uses this to display the current prompt request.
 *   - Server handlers — check this to avoid duplicate prompt requests.
 * </Summary>
 */
export const getPendingPrompt = (): PromptRequest | null =>
  getPendingPromptEntry()?.req ?? null;

/**
 * <Summary>
 * What it does:
 *   Requests user input for a server action, displaying it in the UI if the
 *   Ink interface is active, or auto-resolving with defaults if running non-interactively.
 *
 * How it does it (step by step):
 *   1. Checks if the Ink UI is currently active.
 *   2. If UI not active, resolves with default based on request type.
 *   3. If another prompt is already pending, rejects the new request.
 *   4. Otherwise, stores the request and resolver in pending state.
 *   5. Notifies the UI to display the prompt request.
 *   6. Returns a promise that resolves when user responds.
 *
 * Parameters:
 *   @param {PromptRequest} promptRequest — The prompt request to present to the user.
 *
 * Returns:
 *   @returns {Promise<PromptResult>} — Promise that resolves with user's input.
 *
 * @throws {Error} — When a prompt request is already pending.
 *
 * Dependencies:
 *   - getInkUIActive — checks if the Ink UI is currently active.
 *   - getPendingPromptEntry — checks for existing pending prompts.
 *   - setPendingPromptEntry — stores the new prompt request.
 *   - getBridgeHooks — provides access to UI notification hooks.
 *
 * Dependants:
 *   - Server streaming handlers — call this to request user input.
 *   - Plan execution functions — use this to get plan edits from user.
 * </Summary>
 */
export const requestPrompt = (
  promptRequest: PromptRequest,
): Promise<PromptResult> => {
  // ===== STEP 1: Check if Ink UI is Active =====
  // Step 1a: Check if the Ink-based CLI interface is currently active
  // Step 1b: If not running interactively, use default auto-resolution behavior
  const isUIActive = getInkUIActive();
  if (!isUIActive) {
    // ===== STEP 1a-i: Auto-Resolve Based on Request Type =====
    // Step 1a-i-1: For choice prompts, default to index 0 (first option)
    if (promptRequest.type === "choice") return Promise.resolve(0);
    // Step 1a-i-2: For plan edit prompts, default to initial value
    if (promptRequest.type === "planEdit") {
      return Promise.resolve(promptRequest.initial);
    }
    // Step 1a-i-3: For theme prompts, default to undefined (no theme)
    if (promptRequest.type === "theme") return Promise.resolve(undefined);
    // Step 1a-i-4: For other prompts, default to empty string
    return Promise.resolve("");
  }

  // ===== STEP 2: Check for Existing Pending Prompt =====
  // Step 2a: Check if there's already a pending prompt request
  // Step 2b: This prevents multiple simultaneous prompt requests
  const existingPendingPrompt = getPendingPromptEntry();
  if (existingPendingPrompt !== null) {
    // Step 2a-i: Reject the new request if one is already pending
    return Promise.reject(new Error("Prompt request already pending"));
  }

  // ===== STEP 3: Store Request and Wait for User Response =====
  // Step 3a: Create a new promise to handle the prompt workflow
  return new Promise((resolvePromptFunction) => {
    // Step 3a-i: Store the prompt request and resolver in pending state
    // Step 3a-i-1: This allows the resolver to be called when user responds
    setPendingPromptEntry({
      req: promptRequest,
      resolve: resolvePromptFunction,
    });

    // Step 3a-ii: Notify the UI to display the prompt request
    // Step 3a-ii-1: This triggers the PromptOverlay component to render
    getBridgeHooks().onPromptChange?.(promptRequest);
  });
};

/**
 * <Summary>
 * What it does:
 *   Resolves a pending prompt request with the user's input.
 *
 * How it does it (step by step):
 *   1. Gets the currently pending prompt entry.
 *   2. Clears the pending prompt state.
 *   3. Notifies the UI to hide the prompt overlay.
 *   4. Calls the resolver with the user's prompt result.
 *
 * Parameters:
 *   @param {PromptResult} promptResult — The user's input response.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - getPendingPromptEntry — retrieves the pending prompt state entry.
 *   - setPendingPromptEntry — clears the pending prompt state.
 *   - getBridgeHooks — provides access to UI notification hooks.
 *
 * Dependants:
 *   - PromptOverlay component — calls this when user submits input.
 *   - Keyboard input handlers — call this when user presses enter on prompts.
 * </Summary>
 */
export const resolvePrompt = (promptResult: PromptResult): void => {
  // ===== STEP 1: Get Current Pending Prompt =====
  // Step 1a: Retrieve the currently pending prompt entry from state
  // Step 1b: This contains the request and the resolver function
  const currentPendingPrompt = getPendingPromptEntry();

  // ===== STEP 2: Clear Pending Prompt State =====
  // Step 2a: Clear the pending prompt entry from state
  // Step 2b: This removes the prompt request from global state
  setPendingPromptEntry(null);

  // ===== STEP 3: Notify UI to Hide Prompt Overlay =====
  // Step 3a: Notify the UI that prompt is no longer pending
  // Step 3b: This triggers the PromptOverlay component to unmount
  getBridgeHooks().onPromptChange?.(null);

  // ===== STEP 4: Resolve Promise with User's Input =====
  // Step 4a: Call the resolver function with the prompt result
  // Step 4b: This resolves the promise returned by requestPrompt
  currentPendingPrompt?.resolve(promptResult);
};
