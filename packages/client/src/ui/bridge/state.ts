/**
 * Global state store for the Ink UI bridge.
 *
 * @remarks
 * This module acts as a singleton data store keeping track of UI status, active hooks,
 * pending user interactions (prompts and approvals), and streaming token handlers.
 */

import type { Config } from "../../config.js";
import type {
  AgentBoardState,
  AgentStatusState,
  ApprovalRequest,
  ApprovalResult,
  HistoryItem,
  PromptRequest,
  PromptResult,
  SpinnerState,
} from "../types.js";

/**
 * Event hook callbacks registered by the React root context to receive updates from backend actions.
 */
export type BridgeHooks = {
  /** Callback invoked when a history item is appended. */
  onHistoryAppend?: (historyItem: HistoryItem) => void;
  /** Callback invoked when streaming text is set or cleared. */
  onStreamingSet?: (streamingText: string | null) => void;
  /** Callback invoked when spinner state changes. */
  onSpinner?: (spinnerState: SpinnerState | null) => void;
  /** Callback invoked to update agent statuses map. */
  onAgentStatuses?: (
    statusUpdater: (
      previousStatusMap: Map<number | "advisor", AgentStatusState>,
    ) => Map<number | "advisor", AgentStatusState>,
  ) => void;
  /** Callback invoked to update agent boards array. */
  onAgentBoards?: (
    boardUpdater: (previousBoards: AgentBoardState[]) => AgentBoardState[],
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
};

/**
 * Tracks an active pending user approval promise-resolver pair.
 */
export type PendingApproval = {
  /** The approval request metadata. */
  req: ApprovalRequest;
  /** The promise resolver callback triggered when the user responds. */
  resolve: (approvalResult: ApprovalResult) => void;
};

/**
 * Tracks an active pending user text/choice prompt promise-resolver pair.
 */
export type PendingPrompt = {
  /** The prompt request metadata. */
  req: PromptRequest;
  /** The promise resolver callback triggered when the user submits input. */
  resolve: (promptResult: PromptResult) => void;
};

/**
 * The internal structure of the global bridge state.
 */
type BridgeState = {
  hooks: BridgeHooks;
  inkUIActive: boolean;
  taskActive: boolean;
  pendingApproval: PendingApproval | null;
  pendingPrompt: PendingPrompt | null;
  streamingTokenHandler: ((token: string) => void) | null;
};

const bridgeGlobalState: BridgeState = {
  hooks: {},
  inkUIActive: false,
  taskActive: false,
  pendingApproval: null,
  pendingPrompt: null,
  streamingTokenHandler: null,
};

/**
 * Retrieves the currently registered bridge hooks.
 *
 * @returns The active bridge hooks object.
 */
export const getBridgeHooks = (): BridgeHooks => bridgeGlobalState.hooks;

/**
 * Updates the active bridge hooks registry.
 *
 * @param bridgeHooks - The new bridge hooks object.
 */
export const setBridgeHooks = (bridgeHooks: BridgeHooks): void => {
  bridgeGlobalState.hooks = bridgeHooks;
};

/**
 * Gets the active rendering state of the Ink CLI UI.
 *
 * @returns True if the Ink CLI UI is active, false otherwise.
 */
export const getInkUIActive = (): boolean => bridgeGlobalState.inkUIActive;

/**
 * Sets the active rendering state of the Ink CLI UI.
 *
 * @param isActive - True if the Ink CLI UI is active, false otherwise.
 */
export const setInkUIActiveValue = (isActive: boolean): void => {
  bridgeGlobalState.inkUIActive = isActive;
};

/**
 * Gets the active state of task execution.
 *
 * @returns True if a task is actively running.
 */
export const getTaskActiveValue = (): boolean => bridgeGlobalState.taskActive;

/**
 * Sets the active state of task execution.
 *
 * @param isTaskActive - True if a task is actively running.
 */
export const setTaskActiveValue = (isTaskActive: boolean): void => {
  bridgeGlobalState.taskActive = isTaskActive;
};

/**
 * Retrieves the currently active pending approval entry.
 *
 * @returns The pending approval entry, or `null`.
 */
export const getPendingApprovalEntry = (): PendingApproval | null =>
  bridgeGlobalState.pendingApproval;

/**
 * Updates the active pending approval entry.
 *
 * @param approvalEntry - The approval entry to set, or `null` to clear.
 */
export const setPendingApprovalEntry = (
  approvalEntry: PendingApproval | null,
): void => {
  bridgeGlobalState.pendingApproval = approvalEntry;
};

/**
 * Retrieves the currently active pending prompt entry.
 *
 * @returns The pending prompt entry, or `null`.
 */
export const getPendingPromptEntry = (): PendingPrompt | null =>
  bridgeGlobalState.pendingPrompt;

/**
 * Updates the active pending prompt entry.
 *
 * @param promptEntry - The prompt entry to set, or `null` to clear.
 */
export const setPendingPromptEntry = (
  promptEntry: PendingPrompt | null,
): void => {
  bridgeGlobalState.pendingPrompt = promptEntry;
};

/**
 * Gets the currently registered streaming token handler.
 *
 * @returns The active callback function, or `null`.
 */
export const getStreamingTokenHandler = (): ((token: string) => void) | null =>
  bridgeGlobalState.streamingTokenHandler;

/**
 * Registers or clears the streaming token handler.
 *
 * @param tokenHandler - The callback function, or `null` to clear.
 */
export const setStreamingTokenHandler = (
  tokenHandler: ((token: string) => void) | null,
): void => {
  bridgeGlobalState.streamingTokenHandler = tokenHandler;
};

