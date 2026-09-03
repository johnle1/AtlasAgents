/**
 * Prompt port interface abstraction for command execution.
 *
 * @remarks
 * Decouples the command execution environments (like terminal inputs or headless commands)
 * from the specific React UI prompting implementation.
 */

import { requestPrompt } from "./uiBridge.js";

/**
 * Interface definition for requesting text/choice input interaction from the user.
 */
export type PromptPort = {
  /**
   * Prompts the user with a question for a text response.
   *
   * @param prompt - The descriptive question to present.
   * @param opts - Configurations like input masking.
   * @returns The user-entered response string.
   */
  question: (prompt: string, opts?: { masked?: boolean }) => Promise<string>;

  /**
   * Prompts the user to select from a set of options.
   *
   * @param prompt - The question to display.
   * @param max - The total count of choices (1-based index range).
   * @returns The 1-based index of the chosen option.
   */
  choose: (prompt: string, max: number) => Promise<number>;

  /**
   * Triggers the theme selection overlay menu.
   *
   * @returns Resolves when theme selection is completed.
   */
  pickTheme: () => Promise<void>;

  /**
   * Prompts the user to pick one of `options` via the horizontal,
   * left/right-navigable option bar — shared by `/model` and `/effort`.
   *
   * @param prompt - The question to display above the bar.
   * @param options - Display labels in order.
   * @param initialIndex - Index to highlight when the bar opens (the
   *   current value). Defaults to `0`.
   * @returns The chosen option's index, or `null` if the user cancelled
   *   (Esc) — callers should treat `null` as "no change".
   */
  pickOption: (
    prompt: string,
    options: string[],
    initialIndex?: number,
    optionColors?: string[],
  ) => Promise<number | null>;
};

/**
 * Creates a PromptPort implementation backed by the uiBridge for Ink terminal UI interactions.
 *
 * @returns A new PromptPort instance.
 */
export const createInkPromptPort = (): PromptPort => ({
  question: async (prompt, options) => {
    const response = await requestPrompt({
      type: "line",
      prompt,
      masked: options?.masked,
    });

    return String(response ?? "");
  },

  choose: async (prompt, max) => {
    const response = await requestPrompt({ type: "choice", prompt, max });

    return typeof response === "number" ? response : 1;
  },

  pickTheme: async () => {
    await requestPrompt({ type: "theme" });
  },

  pickOption: async (prompt, options, initialIndex = 0, optionColors) => {
    const response = await requestPrompt({
      type: "optionBar",
      prompt,
      options,
      initialIndex,
      ...(optionColors ? { optionColors } : {}),
    });

    return typeof response === "number" ? response : null;
  },
});

