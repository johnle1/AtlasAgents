/**
 * Type definitions for React hooks in the UI layer.
 *
 * @remarks
 * This module exports shared types used across the custom React hooks,
 * which handle keyboard input, connection management, bridge setup, and
 * command submission.
 */

import type { AppContextValue } from "../../state/DataContext.js";

/**
 * State setters from {@link AppContextValue} that the bridge needs to update.
 *
 * @remarks
 * This type picks only the setter functions from the full context, since the bridge
 * only needs to write state (not read it). Each setter corresponds to a bridge hook
 * that server-side code can invoke to trigger a UI update.
 */
export type BridgeSetupContext = Pick<
  AppContextValue,
  | "setHistory"
  | "setStreamingText"
  | "setLiveThinks"
  | "setSpinner"
  | "setBusy"
  | "setTaskActive"
  | "setPrompt"
  | "setApproval"
  | "setPromptReq"
  | "setBannerEntries"
  | "setSubagentStatuses"
  | "setSubagentBoards"
> & {
  /**
   * Extra work after a screen clear (e.g. bumping Ink `<Static>`'s remount key).
   * History / streaming / live-think reset is handled inside the hook.
   */
  onAfterClearScreen?: () => void;
};

/**
 * State setters from {@link AppContextValue} that need to be reset on disconnect.
 *
 * @remarks
 * These setters are used to clear UI state when the connection drops, ensuring
 * the user sees a clean idle state instead of stuck spinners or in-progress tasks.
 */
export type ConnectionDisconnectCleanupSetters = Pick<
  AppContextValue,
  | "setTaskActive"
  | "setBusy"
  | "setSpinner"
  | "setStreamingText"
  | "setLiveThinks"
  | "setSubagentStatuses"
  | "setSubagentBoards"
>;

/**
 * State values and setters from {@link AppContextValue} needed for keyboard handling.
 *
 * @remarks
 * This type picks only the context values that the keyboard handler needs:
 * - UI state (approval, promptReq, busy) to know if input should be blocked
 * - Input state (input, inputHistory, histIdx) for history navigation
 * - Autocomplete state (activeIndex, scrollOffset) for suggestion navigation
 * - Setters to update these states in response to key events
 * - fileProxy for directory expansion (Ctrl+O)
 */
export type KeyboardInputContext = Pick<
  AppContextValue,
  | "approval"
  | "promptReq"
  | "busy"
  | "inputHistory"
  | "histIdx"
  | "input"
  | "activeIndex"
  | "scrollOffset"
  | "sigintBusy"
  | "setSigintBusy"
  | "onSaveHistory"
  | "fileProxy"
  | "setHistory"
  | "setActiveIndex"
  | "setScrollOffset"
  | "setInput"
  | "setHistIdx"
  | "showShortcuts"
  | "setShowShortcuts"
>;

/**
 * External handlers that the keyboard input handler can invoke.
 *
 * @remarks
 * These are actions that don't belong in the React context but are needed
 * by the keyboard handler: exiting, cancelling the in-flight task, and
 * clearing the screen.
 */
export type KeyboardInputHandlers = {
  /** Function to exit the application. */
  exit: () => void;
  /** Abort the in-flight task stream without quitting the CLI. */
  cancelActiveTask: () => void;
  /** Clear committed history and redraw the UI (Ctrl+L / `/clear`). */
  clearScreen: () => void;
};

/**
 * State values and setters from {@link AppContextValue} needed for line submission.
 *
 * @remarks
 * This type picks the context values required to:
 * - Check if submission is blocked (busy, approval, promptReq)
 * - Manage input history persistence (inputHistory, setInputHistory, onInputHistoryRef)
 * - Update UI state during execution (setInput, setBusy, setHistory, setSigintBusy)
 * - Execute commands or tasks (connection, commandHandler)
 */
export type SubmitLineContext = Pick<
  AppContextValue,
  | "busy"
  | "approval"
  | "promptReq"
  | "inputHistory"
  | "setInputHistory"
  | "onInputHistoryRef"
  | "setHistIdx"
  | "setInput"
  | "setBusy"
  | "setHistory"
  | "setSigintBusy"
  | "connection"
  | "commandHandler"
>;
