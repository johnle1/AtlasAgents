/**
 * <Summary>
 * What it does:
 *   Provides a prompt port interface for the command handler, backed by uiBridge when Ink is active.
 *
 * How it fits in the system:
 *   Abstracts the UI prompt functionality to allow different implementations based on the
 *   rendering context. When using Ink, it delegates to the uiBridge for actual prompt handling.
 *   This enables dependency injection and testing flexibility.
 * </Summary>
 */

import { requestPrompt } from "./uiBridge.js";

/**
 * <Summary>
 * What it does:
 *   Defines the interface for user prompt operations.
 *
 * Used by:
 *   - createInkPromptPort — implements this interface for Ink-based prompting.
 *   - CommandHandler — uses this interface to prompt users.
 *
 * Produced by:
 *   - createInkPromptPort — creates an implementation of this interface.
 * </Summary>
 */
export type PromptPort = {
  /**
   * Prompts the user for a text response with optional masking.
   *
   * Parameters:
   * @param prompt - The question or prompt text to display to the user.
   * @param opts - Optional settings including masked flag for sensitive inputs.
   *
   * Returns:
   * @returns The user's response as a string.
   */
  question: (prompt: string, opts?: { masked?: boolean }) => Promise<string>;

  /**
   * Prompts the user to choose from a numbered list of options.
   *
   * Parameters:
   * @param prompt - The question or prompt text to display to the user.
   * @param max - The maximum number of choices available.
   *
   * Returns:
   * @returns The index of the user's choice (1-based).
   */
  choose: (prompt: string, max: number) => Promise<number>;

  /**
   * Opens the theme selection interface.
   *
   * Returns:
   * @returns Resolves when theme selection is complete.
   */
  pickTheme: () => Promise<void>;
};

/**
 * <Summary>
 * What it does:
 *   Creates a prompt port implementation backed by the uiBridge for Ink rendering.
 *
 * How it does it (step by step):
 *   For question prompts:
 *   1. Request a line input prompt from the uiBridge with optional masking.
 *   2. Convert the response to a string, defaulting to empty string if null.
 *   3. Return the user's response.
 *
 *   For choice prompts:
 *   1. Request a choice input prompt from the uiBridge with max options.
 *   2. Ensure the response is a number, defaulting to 1 if invalid.
 *   3. Return the selected choice index.
 *
 *   For theme selection:
 *   1. Request a theme selection prompt from the uiBridge.
 *   2. Wait for the user to complete theme selection.
 *
 * Returns:
 * @returns A prompt port implementation for Ink-based prompting.
 * </Summary>
 */
export const createInkPromptPort = (): PromptPort => ({
  question: async (prompt, options) => {
    // ===== STEP 1: Request line input from UI =====
    // Step 1a: Request a line input prompt from the uiBridge
    // Step 1b: Include the prompt text and optional masked flag for sensitive inputs
    const response = await requestPrompt({
      type: "line",
      prompt,
      masked: options?.masked,
    });

    // ===== STEP 2: Convert and return response =====
    // Step 2a: Convert the response to a string, defaulting to empty string if null
    // Step 2b: This handles cases where the user cancels or provides no input
    return String(response ?? "");
  },

  choose: async (prompt, max) => {
    // ===== STEP 1: Request choice input from UI =====
    // Step 1a: Request a choice input prompt from the uiBridge
    // Step 1b: Include the prompt text and maximum number of choices
    const response = await requestPrompt({ type: "choice", prompt, max });

    // ===== STEP 2: Validate and return choice =====
    // Step 2a: Ensure the response is a number, defaulting to 1 if invalid
    // Step 2b: This provides a safe fallback if the UI returns an unexpected value
    return typeof response === "number" ? response : 1;
  },

  pickTheme: async () => {
    // ===== STEP 1: Request theme selection =====
    // Step 1a: Request a theme selection prompt from the uiBridge
    // Step 1b: Wait for the user to complete theme selection
    await requestPrompt({ type: "theme" });
  },
});
