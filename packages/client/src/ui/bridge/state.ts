/**
 * <Summary>
 * What it does:
 *   Provides the global state management for the Ink UI bridge system, including
 *   bridge hooks, pending approvals/prompts, and streaming handlers.
 *
 * How it fits in the system:
 *   This module maintains the global state that allows server-side code to communicate
 *   with the Ink-based UI. It stores callback hooks for state updates, tracks pending
 *   user interactions (approvals and prompts), and manages the streaming token handler.
 *
 * Dependencies:
 *   - Config — type definition for application configuration.
 *   - AgentBoardState, AgentStatusState — type definitions for agent display state.
 *   - ApprovalRequest, ApprovalResult — type definitions for approval workflow.
 *   - HistoryItem — type definition for history display items.
 *   - PromptRequest, PromptResult — type definitions for prompt workflow.
 *   - SpinnerState — type definition for spinner display state.
 *
 * Dependants:
 *   - All bridge modules — use these functions to access and modify global state.
 *   - useBridgeSetup hook — registers bridge hooks during component mount.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Defines the callback hooks that the UI component registers to receive
 *   state update notifications from the bridge system.
 *
 * How it fits in the system:
 *   These hooks are called by bridge functions to update the UI when various
 *   events occur, such as history being appended, streaming text changing,
 *   agent status updating, or approval requests pending.
 *
 * Used by:
 *   - useBridgeSetup hook — registers these hooks with the bridge system.
 *
 * Produced by:
 *   - UI components — provide these callbacks to receive state updates.
 * </Summary>
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
  /** Callback invoked when current working directory changes. */
  onCwd?: (currentWorkingDirectory: string) => void;
  /** Callback invoked when banner should be refreshed. */
  onBannerRefresh?: (configuration: Config) => void;
};

/**
 * <Summary>
 * What it does:
 *   Represents a pending approval request with its resolver function.
 *
 * Used by:
 *   - state module — stores pending approvals in the global state.
 *
 * Produced by:
 *   - requestApproval function — creates this when an approval is requested.
 * </Summary>
 */
export type PendingApproval = {
  /** The approval request to present to the user. */
  req: ApprovalRequest;
  /** Function to resolve the approval with the user's decision. */
  resolve: (approvalResult: ApprovalResult) => void;
};

/**
 * <Summary>
 * What it does:
 *   Represents a pending prompt request with its resolver function.
 *
 * Used by:
 *   - state module — stores pending prompts in the global state.
 *
 * Produced by:
 *   - requestPrompt function — creates this when a prompt is requested.
 * </Summary>
 */
export type PendingPrompt = {
  /** The prompt request to present to the user. */
  req: PromptRequest;
  /** Function to resolve the prompt with the user's input. */
  resolve: (promptResult: PromptResult) => void;
};

/**
 * <Summary>
 * What it does:
 *   Defines the internal state structure for the bridge system.
 *
 * Used by:
 *   - state module — maintains the global bridge state.
 *
 * Produced by:
 *   - State management functions — create and maintain this state.
 * </Summary>
 */
type BridgeState = {
  /** The registered bridge hooks for state update notifications. */
  hooks: BridgeHooks;
  /** Flag indicating whether the Ink UI is currently active. */
  inkUIActive: boolean;
  /** The currently pending approval request (if any). */
  pendingApproval: PendingApproval | null;
  /** The currently pending prompt request (if any). */
  pendingPrompt: PendingPrompt | null;
  /** The handler for streaming tokens (if registered). */
  streamingTokenHandler: ((token: string) => void) | null;
};

/**
 * <Summary>
 * What it does:
 *   The global state object for the bridge system.
 *
 * How it fits in the system:
 *   This singleton object maintains all bridge state across the application.
 *   It is accessed and modified by the state getter/setter functions.
 *
 * Dependencies:
 *   - None (initialized at module load).
 *
 * Dependants:
 *   - All state getter/setter functions — access this global state.
 * </Summary>
 */
const bridgeGlobalState: BridgeState = {
  hooks: {},
  inkUIActive: false,
  pendingApproval: null,
  pendingPrompt: null,
  streamingTokenHandler: null,
};

/**
 * <Summary>
 * What it does:
 *   Retrieves the registered bridge hooks from global state.
 *
 * How it does it (step by step):
 *   1. Returns the hooks object from the global state.
 *
 * Returns:
 *   @returns {BridgeHooks} — The registered bridge hooks.
 *
 * Dependencies:
 *   - bridgeGlobalState — the global state object.
 *
 * Dependants:
 *   - All bridge modules — use this to call the registered hooks.
 * </Summary>
 */
export const getBridgeHooks = (): BridgeHooks => bridgeGlobalState.hooks;

/**
 * <Summary>
 * What it does:
 *   Sets the bridge hooks in global state.
 *
 * How it does it (step by step):
 *   1. Updates the hooks object in the global state.
 *
 * Parameters:
 *   @param {BridgeHooks} bridgeHooks — The bridge hooks to register.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - bridgeGlobalState — the global state object.
 *
 * Dependants:
 *   - registerBridgeHooks function — calls this to register hooks.
 * </Summary>
 */
export const setBridgeHooks = (bridgeHooks: BridgeHooks): void => {
  bridgeGlobalState.hooks = bridgeHooks;
};

/**
 * <Summary>
 * What it does:
 *   Retrieves the Ink UI active flag from global state.
 *
 * How it does it (step by step):
 *   1. Returns the inkUIActive flag from the global state.
 *
 * Returns:
 *   @returns {boolean} — True if Ink UI is active, false otherwise.
 *
 * Dependencies:
 *   - bridgeGlobalState — the global state object.
 *
 * Dependants:
 *   - isInkActive function — calls this to check UI state.
 * </Summary>
 */
export const getInkUIActive = (): boolean => bridgeGlobalState.inkUIActive;

/**
 * <Summary>
 * What it does:
 *   Sets the Ink UI active flag in global state.
 *
 * How it does it (step by step):
 *   1. Updates the inkUIActive flag in the global state.
 *
 * Parameters:
 *   @param {boolean} isActive — Whether the Ink UI is active.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - bridgeGlobalState — the global state object.
 *
 * Dependants:
 *   - setInkActive function — calls this to update UI state.
 * </Summary>
 */
export const setInkUIActiveValue = (isActive: boolean): void => {
  bridgeGlobalState.inkUIActive = isActive;
};

/**
 * <Summary>
 * What it does:
 *   Retrieves the pending approval entry from global state.
 *
 * How it does it (step by step):
 *   1. Returns the pendingApproval entry from the global state.
 *
 * Returns:
 *   @returns {PendingApproval | null} — The pending approval or null.
 *
 * Dependencies:
 *   - bridgeGlobalState — the global state object.
 *
 * Dependants:
 *   - approval module functions — call this to check pending approvals.
 * </Summary>
 */
export const getPendingApprovalEntry = (): PendingApproval | null =>
  bridgeGlobalState.pendingApproval;

/**
 * <Summary>
 * What it does:
 *   Sets the pending approval entry in global state.
 *
 * How it does it (step by step):
 *   1. Updates the pendingApproval entry in the global state.
 *
 * Parameters:
 *   @param {PendingApproval | null} approvalEntry — The approval entry to set.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - bridgeGlobalState — the global state object.
 *
 * Dependants:
 *   - requestApproval function — calls this to store pending approval.
 *   - resolveApproval function — calls this to clear pending approval.
 * </Summary>
 */
export const setPendingApprovalEntry = (
  approvalEntry: PendingApproval | null,
): void => {
  bridgeGlobalState.pendingApproval = approvalEntry;
};

/**
 * <Summary>
 * What it does:
 *   Retrieves the pending prompt entry from global state.
 *
 * How it does it (step by step):
 *   1. Returns the pendingPrompt entry from the global state.
 *
 * Returns:
 *   @returns {PendingPrompt | null} — The pending prompt or null.
 *
 * Dependencies:
 *   - bridgeGlobalState — the global state object.
 *
 * Dependants:
 *   - prompt module functions — call this to check pending prompts.
 * </Summary>
 */
export const getPendingPromptEntry = (): PendingPrompt | null =>
  bridgeGlobalState.pendingPrompt;

/**
 * <Summary>
 * What it does:
 *   Sets the pending prompt entry in global state.
 *
 * How it does it (step by step):
 *   1. Updates the pendingPrompt entry in the global state.
 *
 * Parameters:
 *   @param {PendingPrompt | null} promptEntry — The prompt entry to set.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - bridgeGlobalState — the global state object.
 *
 * Dependants:
 *   - requestPrompt function — calls this to store pending prompt.
 *   - resolvePrompt function — calls this to clear pending prompt.
 * </Summary>
 */
export const setPendingPromptEntry = (
  promptEntry: PendingPrompt | null,
): void => {
  bridgeGlobalState.pendingPrompt = promptEntry;
};

/**
 * <Summary>
 * What it does:
 *   Retrieves the streaming token handler from global state.
 *
 * How it does it (step by step):
 *   1. Returns the streamingTokenHandler from the global state.
 *
 * Returns:
 *   @returns {((token: string) => void) | null} — The streaming handler or null.
 *
 * Dependencies:
 *   - bridgeGlobalState — the global state object.
 *
 * Dependants:
 *   - history module functions — call this to process streaming tokens.
 * </Summary>
 */
export const getStreamingTokenHandler = (): ((token: string) => void) | null =>
  bridgeGlobalState.streamingTokenHandler;

/**
 * <Summary>
 * What it does:
 *   Sets the streaming token handler in global state.
 *
 * How it does it (step by step):
 *   1. Updates the streamingTokenHandler in the global state.
 *
 * Parameters:
 *   @param {((token: string) => void) | null} tokenHandler — The token handler to set.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - bridgeGlobalState — the global state object.
 *
 * Dependants:
 *   - registerStreamingHandler function — calls this to store the handler.
 * </Summary>
 */
export const setStreamingTokenHandler = (
  tokenHandler: ((token: string) => void) | null,
): void => {
  bridgeGlobalState.streamingTokenHandler = tokenHandler;
};
