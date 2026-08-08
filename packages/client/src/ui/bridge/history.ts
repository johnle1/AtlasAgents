/**
 * Command history and text streaming display management for the Ink CLI UI.
 *
 * @remarks
 * This module handles appending logs/messages to the terminal screen, showing real-time streaming output
 * of tokens from LLM actions, and registration of token streams.
 */

import type { HistoryItem, HistoryVariant, LiveThink } from "../types.js";
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
  textVariant: HistoryVariant = "system",
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

/**
 * Opens a new live "thinking" stream, rendered below history until it ends.
 *
 * @remarks
 * Called on a `think-start` frame. The entry starts with empty text — the
 * caller appends to it via {@link appendLiveThink} as `think-delta` frames
 * arrive, then removes it via {@link endLiveThink} on `think-end`.
 *
 * @param id - Wire id from the `think-start` frame; distinguishes concurrent streams.
 * @param agent - `true` for the lead agent, `false` for a subagent.
 * @param label - Subagent display label, or `null` for the lead agent.
 */
export const startLiveThink = (
  id: string,
  agent: boolean,
  label: string | null,
): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onLiveThink?.((previousLiveThinks) => [
    ...previousLiveThinks,
    { id, text: "", agent, label },
  ]);
};

/**
 * Appends a slice of newly-arrived text to an open live think stream.
 *
 * @remarks
 * A no-op if `id` doesn't match any currently-open stream (e.g. it already
 * ended, or `showThinkOutput` was off when it started).
 *
 * @param id - The stream's id, from its `think-start` frame.
 * @param text - The slice of text to append (a `think-delta` frame's `text`).
 */
export const appendLiveThink = (id: string, text: string): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onLiveThink?.((previousLiveThinks) =>
    previousLiveThinks.map((liveThink) =>
      liveThink.id === id
        ? { ...liveThink, text: liveThink.text + text }
        : liveThink,
    ),
  );
};

/**
 * Removes a live think stream once it has ended.
 *
 * @remarks
 * Called on a `think-end` frame, after the caller has committed the
 * completed block to persistent history — this only removes it from the
 * live/in-progress view.
 *
 * @param id - The stream's id, from its `think-start` frame.
 */
export const endLiveThink = (id: string): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onLiveThink?.((previousLiveThinks) =>
    previousLiveThinks.filter((liveThink) => liveThink.id !== id),
  );
};

/**
 * Clears every live think stream immediately, without committing them.
 *
 * @remarks
 * Used when abandoning in-progress reasoning display outright — e.g. on
 * disconnect cleanup — as opposed to {@link endLiveThink}, which removes one
 * stream after its content has already been committed to history.
 */
export const clearLiveThinks = (): void => {
  const bridgeHooks = getBridgeHooks();
  bridgeHooks.onLiveThink?.((): LiveThink[] => []);
};

