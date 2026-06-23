/**
 * <Summary>
 * What it does:
 *   Provides functions for managing command history and streaming text display
 *   in the Ink-based CLI UI through the bridge system.
 *
 * How it fits in the system:
 *   This module handles the history of commands and messages displayed in the terminal,
 *   as well as real-time streaming of text output from server operations. It manages
 *   the display of user input, system messages, errors, and streaming output through
 *   the global application state.
 * </Summary>
 */

import type { HistoryItem } from "../types.js";
import {
  getBridgeHooks,
  getStreamingTokenHandler,
  setStreamingTokenHandler,
} from "./state.js";

/**
 * <Summary>
 * What it does:
 *   Appends a history item to the command history display.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onHistoryAppend hook with the history item.
 *   3. The hook adds the item to the history array and triggers UI re-render.
 *
 * Parameters:
 *   @param historyItem - The history item to add (text, think, plan, etc.).
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const appendHistory = (historyItem: HistoryItem): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Append History Item =====
  // Step 2a: Call the onHistoryAppend hook with the history item
  // Step 2b: This adds the item to the global history array
  // Step 2c: The history component renders the new item in the terminal
  bridgeHooks.onHistoryAppend?.(historyItem);
};

/**
 * <Summary>
 * What it does:
 *   Appends a text message to the history with the specified variant.
 *
 * How it does it (step by step):
 *   1. Creates a text history item with the provided text and variant.
 *   2. Calls appendHistory to add the item to the history.
 *
 * Parameters:
 *   @param text - The message text to display.
 * @param textVariant - The display variant (system, error, success, secondary, user, assistant).
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
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
  // ===== STEP 1: Create Text History Item =====
  // Step 1a: Create a history item with the text and variant
  // Step 1b: This creates a standardized history item for display
  const historyItem = { kind: "text" as const, text, variant: textVariant };

  // ===== STEP 2: Append to History =====
  // Step 2a: Call appendHistory to add the item to the history
  // Step 2b: This displays the message in the terminal with the appropriate styling
  appendHistory(historyItem);
};

/**
 * <Summary>
 * What it does:
 *   Sets or clears the streaming text that displays real-time server output.
 *
 * How it does it (step by step):
 *   1. Gets the bridge hooks for state updates.
 *   2. Calls the onStreamingSet hook with the streaming text.
 *   3. The hook updates the streaming text state and triggers UI re-render.
 *
 * Parameters:
 *   @param streamingText - The streaming text to display (null to clear).
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const setStreamingText = (streamingText: string | null): void => {
  // ===== STEP 1: Get Bridge Hooks =====
  // Step 1a: Retrieve the bridge hooks for global state updates
  const bridgeHooks = getBridgeHooks();

  // ===== STEP 2: Update Streaming Text =====
  // Step 2a: Call the onStreamingSet hook with the streaming text
  // Step 2b: This updates the global streaming text state
  // Step 2c: The streaming text component displays the text in real-time
  // Step 2d: Passing null clears the streaming text display
  bridgeHooks.onStreamingSet?.(streamingText);
};

/**
 * <Summary>
 * What it does:
 *   Appends a streaming token to the streaming text and triggers the streaming token handler.
 *
 * How it does it (step by step):
 *   1. Calls setStreamingText with null to clear the streaming text state.
 *   2. Gets the streaming token handler from state.
 *   3. Calls the handler with the new token if it exists.
 *
 * Parameters:
 *   @param streamingToken - The token to append to the streaming text.
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const appendStreamingToken = (streamingToken: string): void => {
  // ===== STEP 1: Clear Streaming Text State =====
  // Step 1a: Clear the streaming text state to prepare for token append
  // Step 1b: This allows the streaming token handler to rebuild the text
  setStreamingText(null);

  // ===== STEP 2: Get Streaming Token Handler =====
  // Step 2a: Retrieve the streaming token handler from state
  // Step 2b: This handler is responsible for processing streaming tokens
  const streamingTokenHandler = getStreamingTokenHandler();

  // ===== STEP 3: Process Streaming Token =====
  // Step 3a: Call the handler with the new streaming token
  // Step 3b: The handler appends the token and updates the streaming text
  // Step 3c: This allows custom token processing logic
  streamingTokenHandler?.(streamingToken);
};

/**
 * <summary>
 * What it does:
 *   Registers a custom handler for processing streaming tokens.
 *
 * How it does it (step by step):
 *   1. Calls setStreamingTokenHandler to store the custom handler.
 *   2. The handler is called by appendStreamingToken for each token.
 *
 * Parameters:
 *   @param handlerFunction - The handler function (null to clear).
 *
 * Returns:
 *   void — called for side effects only.
 *
 * </summary>
 */
export const registerStreamingHandler = (
  handlerFunction: ((token: string) => void) | null,
): void => {
  // ===== STEP 1: Register Streaming Token Handler =====
  // Step 1a: Store the streaming token handler function in state
  // Step 1b: This allows custom processing of streaming tokens
  // Step 1c: Pass null to clear any existing handler
  setStreamingTokenHandler(handlerFunction);
};
