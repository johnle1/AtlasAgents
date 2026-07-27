/**
 * Command history and text streaming display management for the Ink CLI UI.
 *
 * @remarks
 * This module handles appending logs/messages to the terminal screen, showing real-time streaming output
 * of tokens from LLM actions, and registration of token streams.
 */

import type { HistoryItem } from "../types.js";
import {
  getBridgeHooks,
  getStreamingTokenHandler,
  setStreamingTokenHandler,
} from "./state.js";

/**
 * Appends a history item to the active terminal history list.
 *
 * @param historyItem - The history item data (e.g. user prompt, thinking block, plan details, etc.).
 */
export const appendHistory = (historyItem: HistoryItem): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onHistoryAppend?.(historyItem);
};

/**
 * Appends a generic text block to the history list with a specified style variant.
 *
 * @param text - The text message to output to the terminal log.
 * @param textVariant - Visual style/variant for rendering (defaults to "system").
 */
export const appendLog = (
  text: string,
  textVariant:
    | "system"
    | "error"
    | "success"
    | "secondary"
    | "user"
    | "assistant" = "system",
): void => {
  const historyItem = { kind: "text" as const, text, variant: textVariant };
  appendHistory(historyItem);
};

/**
 * Sets or clears the active real-time streaming text block.
 *
 * @remarks
 * Used to display progressive response output from agents before final completion.
 * Pass `null` to clear/remove the active streaming block.
 *
 * @param streamingText - The text string to render, or `null` to hide the streaming section.
 */
export const setStreamingText = (streamingText: string | null): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onStreamingSet?.(streamingText);
};

/**
 * Appends a single token to the active stream, clear-triggering the streaming state.
 *
 * @remarks
 * Clears the active static streaming text and forwards the token to the registered
 * token handler function.
 *
 * @param streamingToken - The single token string to append.
 */
export const appendStreamingToken = (streamingToken: string): void => {
  // Clear the static text representation to force regeneration via the handler callback
  setStreamingText(null);

  const streamingTokenHandler = getStreamingTokenHandler();
  streamingTokenHandler?.(streamingToken);
};

/**
 * Registers a callback handler for processing incremental streaming tokens.
 *
 * @param handlerFunction - The token receiver function, or `null` to unregister.
 */
export const registerStreamingHandler = (
  handlerFunction: ((token: string) => void) | null,
): void => {
  setStreamingTokenHandler(handlerFunction);
};

