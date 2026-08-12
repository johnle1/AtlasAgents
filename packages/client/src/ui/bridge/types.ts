/**
 * Type definitions for the Ink UI bridge system.
 *
 * @remarks
 * This module exports shared types used across the bridge layer, which coordinates
 * state updates between server-side code and the React-based Ink UI.
 */

import type { Config } from "../../config/index.js";
import type {
  SubagentBoardState,
  SubagentStatusState,
  ApprovalRequest,
  ApprovalResult,
  HistoryItem,
  LiveThink,
  PromptRequest,
  PromptResult,
  SpinnerState,
} from "../types.js";

/**
 * Event hook callbacks registered by the React root context to receive updates from backend actions.
 *
 * @remarks
 * These callbacks are registered via {@link registerBridgeHooks} and invoked by bridge
 * functions to trigger React state updates from non-React code.
 */
export type BridgeHooks = {
  /** Callback invoked when a history item is appended. */
  onHistoryAppend?: (historyItem: HistoryItem) => void;
  /** Callback invoked when streaming text is set or cleared. */
  onStreamingSet?: (streamingText: string | null) => void;
  /** Callback invoked to update the live (in-progress) think streams array. */
  onLiveThink?: (
    thinkUpdater: (previousLiveThinks: LiveThink[]) => LiveThink[],
  ) => void;
  /** Callback invoked when spinner state changes. */
  onSpinner?: (spinnerState: SpinnerState | null) => void;
  /** Callback invoked to update agent statuses map. */
  onSubagentStatuses?: (
    statusUpdater: (
      previousStatusMap: Map<number | "agent", SubagentStatusState>,
    ) => Map<number | "agent", SubagentStatusState>,
  ) => void;
  /** Callback invoked to update agent boards array. */
  onSubagentBoards?: (
    boardUpdater: (previousBoards: SubagentBoardState[]) => SubagentBoardState[],
  ) => void;
  /** Callback invoked when an approval request changes. */
  onApprovalChange?: (approvalRequest: ApprovalRequest | null) => void;
  /** Callback invoked when a prompt request changes. */
  onPromptChange?: (promptRequest: PromptRequest | null) => void;
  /** Callback invoked when busy state changes. */
  onBusy?: (isBusy: boolean) => void;
  /** Callback invoked when agent-task active state changes. */
  onTaskActive?: (isTaskActive: boolean) => void;
  /** Callback invoked when current working directory changes. */
  onCwd?: (currentWorkingDirectory: string) => void;
  /** Callback invoked when banner should be refreshed. */
  onBannerRefresh?: (configuration: Config) => void;
  /**
   * Callback invoked when the user asks to clear the screen (Ctrl+L / `/clear`).
   * The React root remounts Ink `<Static>` and writes ANSI clear escapes.
   */
  onClearScreen?: () => void;
};

/**
 * Tracks an active pending user approval promise-resolver pair.
 *
 * @remarks
 * When the server requests user approval via {@link requestApproval}, this structure
 * stores the request metadata and the resolve function. The React UI calls
 * {@link resolveApproval} when the user responds, which invokes this resolve function.
 */
export type PendingApproval = {
  /** The approval request metadata. */
  req: ApprovalRequest;
  /** The promise resolver callback triggered when the user responds. */
  resolve: (approvalResult: ApprovalResult) => void;
};

/**
 * Tracks an active pending user text/choice prompt promise-resolver pair.
 *
 * @remarks
 * When the server requests user input via {@link requestPrompt}, this structure
 * stores the request metadata and the resolve function. The React UI calls
 * {@link resolvePrompt} when the user submits input, which invokes this resolve function.
 */
export type PendingPrompt = {
  /** The prompt request metadata. */
  req: PromptRequest;
  /** The promise resolver callback triggered when the user submits input. */
  resolve: (promptResult: PromptResult) => void;
};
