/**
 * Keyboard input hook for CLI interactions and commands.
 *
 * @remarks
 * Thin React wrapper around the pure {@link createKeyHandler} factory so Ink's
 * `useInput` receives a stable callback. See `keyHandler.ts` for the key
 * contract (Esc cancel, Ctrl+C, Ctrl+L, autocomplete, history). The hook
 * memoizes the handler against the context values it closes over.
 *
 * @example
 * ```tsx
 * const keyboardHandler = useKeyboardInput(context, {
 *   exit,
 *   cancelActiveTask,
 *   clearScreen,
 *   insertNewline,
 * });
 * useInput(keyboardHandler);
 * ```
 */

import { useMemo } from "react";

import { createKeyHandler } from "./keyHandler.js";
import type { KeyboardInputContext, KeyboardInputHandlers } from "./types.js";

/**
 * React hook that returns a keyboard input handler callback for Ink's `useInput`.
 *
 * @param context - Selected app state values and setters.
 * @param handlers - External functions for application actions.
 * @returns The key handler callback.
 */
export const useKeyboardInput = (
  context: KeyboardInputContext,
  handlers: KeyboardInputHandlers,
) =>
  useMemo(() => createKeyHandler(context, handlers), [
    context.approval,
    context.promptReq,
    context.busy,
    context.inputHistory,
    context.histIdx,
    context.input,
    context.activeIndex,
    context.scrollOffset,
    context.sigintBusy,
    context.setSigintBusy,
    context.onSaveHistory,
    context.fileProxy,
    context.setHistory,
    context.setActiveIndex,
    context.setScrollOffset,
    context.setInput,
    context.setHistIdx,
    context.showShortcuts,
    context.setShowShortcuts,
    context.markdownRaw,
    context.setMarkdownRaw,
    context.approvalMode,
    context.setApprovalMode,
    handlers.exit,
    handlers.cancelActiveTask,
    handlers.clearScreen,
    handlers.insertNewline,
    handlers.enqueueMessage,
    context.mentionNames,
  ]);
