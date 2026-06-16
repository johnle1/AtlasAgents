/**
 * <Summary>
 * What it does:
 *   Bridge between non-React code (Connection, LocalFileProxy, CommandHandler) and the Ink UI.
 *   Provides promise-based approvals and prompts, and hook-based communication for history, spinner,
 *   and state updates.
 *
 * How it fits in the system:
 *   This module serves as the communication layer between the imperative CLI code (commands, file proxy,
 *   connection) and the declarative React UI. It allows non-React code to trigger UI updates through
 *   registered hooks, and provides promise-based interfaces for user approvals and prompts.
 *
 * Dependencies:
 *   - Config — provides configuration for banner refresh.
 *   - frames — provides stage types for agent status.
 *   - types — provides type definitions for the UI layer.
 *
 * Dependants:
 *   - Connection — uses bridge functions to update UI state.
 *   - LocalFileProxy — uses bridge functions to update UI state.
 *   - CommandHandler — uses bridge functions to update UI state.
 *   - taskStream — uses bridge functions for UI communication.
 *   - AppContext — registers hooks to receive UI updates.
 * </Summary>
 */

import type { Config } from "../config.js";
import type { AgentStage } from "../frames.js";
import type {
  AgentBoardState,
  AgentStatusState,
  ApprovalRequest,
  ApprovalResult,
  HistoryItem,
  PromptRequest,
  PromptResult,
  SpinnerState,
} from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Defines the hook interface for registering callbacks that React components use to receive UI updates.
 *
 * Used by:
 *   - registerBridgeHooks — registers these hooks from React.
 *   - All bridge functions — call these hooks to trigger UI updates.
 *
 * Produced by:
 *   - AppContext — creates and registers hook implementations.
 * </Summary>
 */
type BridgeHooks = {
  /** Callback invoked when a new item is appended to history. */
  onHistoryAppend?: (item: HistoryItem) => void;

  /** Callback invoked when streaming text is set or cleared. */
  onStreamingSet?: (text: string | null) => void;

  /** Callback invoked when the bottom-line spinner state changes. */
  onSpinner?: (state: SpinnerState | null) => void;

  /** Callback invoked when agent status map changes (added, updated, or removed). */
  onAgentStatuses?: (
    updater: (
      prev: Map<number | "advisor", AgentStatusState>,
    ) => Map<number | "advisor", AgentStatusState>,
  ) => void;

  /** Callback invoked when agent boards are updated (task assignments changed). */
  onAgentBoards?: (
    updater: (prev: AgentBoardState[]) => AgentBoardState[],
  ) => void;

  /** Callback invoked when an approval request appears or is resolved. */
  onApprovalChange?: (req: ApprovalRequest | null) => void;

  /** Callback invoked when a prompt request appears or is resolved. */
  onPromptChange?: (req: PromptRequest | null) => void;

  /** Callback invoked when the application busy state changes. */
  onBusy?: (busy: boolean) => void;

  /** Callback invoked when the current working directory changes. */
  onCwd?: (cwd: string) => void;

  /** Callback invoked when configuration changes and banner needs refresh. */
  onBannerRefresh?: (cfg: Config) => void;
};

/**
 * <Summary>
 * What it does:
 *   Stores the current bridge hooks registered from the React UI.
 *
 * Used by:
 *   - registerBridgeHooks — updates this with new hook implementations.
 *   - All bridge functions — call hooks on this object to trigger UI updates.
 *
 * Produced by:
 *   - registerBridgeHooks — sets this when registering hooks.
 * </Summary>
 */
let bridgeHooks: BridgeHooks = {};

/**
 * <Summary>
 * What it does:
 *   Tracks whether the Ink UI is currently active and rendering.
 *
 * Used by:
 *   - setInkActive — sets this to true when Ink mounts.
 *   - isInkActive — checks this to determine if UI is available.
 *   - requestApproval/requestPrompt — auto-resolves if false (UI not available).
 *
 * Produced by:
 *   - setInkActive — sets this to true when Ink mounts.
 *   - UI component lifecycle — sets this to false when Ink unmounts.
 * </Summary>
 */
let inkUIActive = false;

/**
 * <Summary>
 * What it does:
 *   Stores the currently pending approval request and its resolve function.
 *
 * Used by:
 *   - requestApproval — sets this when creating a new approval request.
 *   - resolveApproval — clears this after resolving the request.
 *   - getPendingApproval — retrieves the current pending request.
 *
 * Produced by:
 *   - requestApproval — sets this when creating a new approval request.
 * </Summary>
 */
let pendingApproval: {
  req: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
} | null = null;

/**
 * <Summary>
 * What it does:
 *   Stores the currently pending prompt request and its resolve function.
 *
 * Used by:
 *   - requestPrompt — sets this when creating a new prompt request.
 *   - resolvePrompt — clears this after resolving the request.
 *   - getPendingPrompt — retrieves the current pending request.
 *
 * Produced by:
 *   - requestPrompt — sets this when creating a new prompt request.
 * </Summary>
 */
let pendingPrompt: {
  req: PromptRequest;
  resolve: (result: PromptResult) => void;
} | null = null;

/**
 * <Summary>
 * What it does:
 *   Sets whether the Ink UI is currently active and rendering.
 *
 * How it does it (step by step):
 *   1. Update the Ink active flag with the provided boolean value.
 *
 * Parameters:
 * @param {boolean} active — Whether Ink UI is currently active (true when mounted, false when unmounted).
 *
 * Returns:
 * @returns {void} — Returns after updating the Ink active flag.
 *
 * Dependencies:
 *   - None (simple variable assignment).
 *
 * Dependants:
 *   - AppContext — calls this when Ink mounts/unmounts.
 *   - isInkActive — reads this to check UI availability.
 *   - requestApproval/requestPrompt — read this to determine if UI is available.
 * </Summary>
 */
export const setInkActive = (active: boolean): void => {
  // ===== STEP 1: Update Ink active flag =====
  // Step 1a: Update the Ink active flag with the provided boolean value
  // Step 1b: This allows non-React code to determine if UI is available
  inkUIActive = active;
};

/**
 * <Summary>
 * What it does:
 *   Returns whether the Ink UI is currently active and rendering.
 *
 * How it does it (step by step):
 *   1. Return the current value of the Ink active flag.
 *
 * Returns:
 * @returns {boolean} — True if Ink UI is active, false otherwise.
 *
 * Dependencies:
 *   - None (simple variable access).
 *
 * Dependants:
 *   - requestApproval/requestPrompt — read this to determine if UI is available.
 * </Summary>
 */
export const isInkActive = (): boolean => inkUIActive;

/**
 * <Summary>
 * What it does:
 *   Registers the bridge hooks from the React UI for receiving UI updates.
 *
 * How it does it (step by step):
 *   1. Update the bridge hooks with the provided hook implementations.
 *
 * Parameters:
 * @param {BridgeHooks} newBridgeHooks — The hook implementations to register.
 *
 * Returns:
 * @returns {void} — Returns after updating the bridge hooks.
 *
 * Dependencies:
 *   - None (simple variable assignment).
 *
 * Dependants:
 *   - AppContext — calls this on mount to register hook implementations.
 * </Summary>
 */
export const registerBridgeHooks = (newBridgeHooks: BridgeHooks): void => {
  // ===== STEP 1: Update bridge hooks =====
  // Step 1a: Update the bridge hooks with the provided hook implementations
  // Step 1b: This replaces any previously registered hooks
  bridgeHooks = newBridgeHooks;
};

/**
 * <Summary>
 * What it does:
 *   Appends a history item to the terminal display.
 *
 * How it does it (step by step):
 *   1. Call the registered onHistoryAppend hook if it exists.
 *   2. Pass the history item to the hook for display.
 *
 * Parameters:
 * @param {HistoryItem} historyItem — The history item to append (text, think block, plan, diff, or block).
 *
 * Returns:
 * @returns {void} — Returns after triggering the history append hook.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - All CLI components — use this to add items to the terminal output.
 *   - appendLog — uses this to add text items.
 *   - taskStream — uses this to add various history items.
 * </Summary>
 */
export const appendHistory = (historyItem: HistoryItem): void => {
  // ===== STEP 1: Trigger history append hook =====
  // Step 1a: Call the registered onHistoryAppend hook if it exists
  // Step 1b: Pass the history item to the hook for display in the React UI
  bridgeHooks.onHistoryAppend?.(historyItem);
};

/**
 * <Summary>
 * What it does:
 *   Appends a text line to the terminal display with a specified variant for styling.
 *
 * How it does it (step by step):
 *   1. Create a text history item with the provided text and variant.
 *   2. Append the text item to history.
 *
 * Parameters:
 * @param {string} text — The text line to append to the terminal output.
 * @param {"system" | "error" | "success" | "secondary" | "user" | "assistant"} variant — The display variant for styling (defaults to "system").
 *
 * Returns:
 * @returns {void} — Returns after appending the text item to history.
 *
 * Dependencies:
 *   - appendHistory — appends the created text item to history.
 *
 * Dependants:
 *   - All CLI components — use this for simple text output with styling.
 *   - sink — uses this for log output functionality.
 * </Summary>
 */
export const appendLog = (
  text: string,
  variant:
    | "system"
    | "error"
    | "success"
    | "secondary"
    | "user"
    | "assistant" = "system",
): void => {
  // ===== STEP 1: Create and append text history item =====
  // Step 1a: Create a text history item with the provided text and variant
  // Step 1b: Append the text item to history for display in the React UI
  appendHistory({ kind: "text", text, variant });
};

/**
 * <Summary>
 * What it does:
 *   Sets the streaming text displayed during task execution.
 *
 * How it does it (step by step):
 *   1. Call the registered onStreamingSet hook if it exists.
 *   2. Pass the streaming text (or null to clear) to the hook.
 *
 * Parameters:
 * @param {string | null} text — The streaming text to display, or null to clear the streaming display.
 *
 * Returns:
 * @returns {void} — Returns after triggering the streaming set hook.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - taskStream — uses this to update streaming text during task execution.
 *   - AppContext — receives streaming text updates via hooks.
 * </Summary>
 */
export const setStreamingText = (text: string | null): void => {
  // ===== STEP 1: Trigger streaming set hook =====
  // Step 1a: Call the registered onStreamingSet hook if it exists
  // Step 1b: Pass the streaming text (or null to clear) to the hook for display
  bridgeHooks.onStreamingSet?.(text);
};

/**
 * <Summary>
 * What it does:
 *   Appends a streaming token to the streaming display.
 *
 * How it does it (step by step):
 *   1. Call the registered onStreamingSet hook with null (as a trigger to update).
 *   2. Pass the token to the dedicated streaming token handler.
 *
 * Parameters:
 * @param {string} token — The streaming token to append to the display.
 *
 * Returns:
 * @returns {void} — Returns after triggering streaming update.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *   - streamingTokenHandler — provides the dedicated token handler.
 *
 * Dependants:
 *   - taskStream — uses this for streaming text updates.
 *
 * Note:
 *   Handled in React via callback registration. The null trigger is a no-op that causes React
 *   to update its state, while the actual token is handled by the dedicated streaming handler.
 * </Summary>
 */
export const appendStreamingToken = (token: string): void => {
  // ===== STEP 1: Trigger streaming update =====
  // Step 1a: Call the registered onStreamingSet hook with null (noop trigger)
  // Step 1b: This causes React to update its state without changing the actual streaming text
  // Step 1c: The App tracks streaming via a dedicated function instead
  bridgeHooks.onStreamingSet?.(null);

  // Step 1d: Pass the actual token to the dedicated streaming token handler
  streamingTokenHandler?.(token);
};

/**
 * <Summary>
 * What it does:
 *   Stores the dedicated handler for streaming tokens.
 *
 * Used by:
 *   - appendStreamingToken — uses this to pass tokens to the handler.
 *   - registerStreamingHandler — sets this to the provided handler.
 *
 * Produced by:
 *   - registerStreamingHandler — sets this to the provided handler.
 * </Summary>
 */
let streamingTokenHandler: ((token: string) => void) | null = null;

/**
 * <Summary>
 * What it does:
 *   Registers the dedicated handler for streaming tokens from the React UI.
 *
 * How it does it (step by step):
 *   1. Set the streaming token handler to the provided function.
 *
 * Parameters:
 * @param {((token: string) => void) | null} handlerFunction — The handler function to call with each streaming token, or null to clear the handler.
 *
 * Returns:
 * @returns {void} — Returns after updating the streaming token handler.
 *
 * Dependencies:
 *   - None (simple variable assignment).
 *
 * Dependants:
 *   - AppContext — calls this on mount to register the streaming handler.
 * </Summary>
 */
export const registerStreamingHandler = (
  handlerFunction: ((token: string) => void) | null,
): void => {
  // ===== STEP 1: Update streaming token handler =====
  // Step 1a: Set the streaming token handler to the provided function
  // Step 1b: This allows the React UI to handle streaming tokens efficiently
  streamingTokenHandler = handlerFunction;
};

/**
 * <Summary>
 * What it does:
 *   Sets the bottom-line spinner state for status indication.
 *
 * How it does it (step by step):
 *   1. Call the registered onSpinner hook if it exists.
 *   2. Pass the spinner state (or null to clear) to the hook.
 *
 * Parameters:
 * @param {SpinnerState | null} spinnerState — The spinner state to display, or null to clear the spinner.
 *
 * Returns:
 * @returns {void} — Returns after triggering the spinner hook.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - taskStream — uses this to update spinner status during task execution.
 *   - spinnerSync — provides spinner state mapping from status frames.
 * </Summary>
 */
export const setSpinner = (spinnerState: SpinnerState | null): void => {
  // ===== STEP 1: Trigger spinner hook =====
  // Step 1a: Call the registered onSpinner hook if it exists
  // Step 1b: Pass the spinner state (or null to clear) to the hook for display
  bridgeHooks.onSpinner?.(spinnerState);
};

export const setAgentStatus = (status: AgentStatusState): void => {
  bridgeHooks.onAgentStatuses?.((prev) => {
    const next = new Map(prev);
    next.set(status.id, status);
    return next;
  });
};

/**
 * <Summary>
 * What it does:
 *   Removes the status for an agent or the advisor.
 *
 * How it does it (step by step):
 *   1. Check if the agent exists in the status map.
 *   2. If not found, return early (nothing to remove).
 *   3. Create a new Map from the current status map to trigger reactivity.
 *   4. Delete the agent's status from the map.
 *   5. Call the registered onAgentStatuses hook to update the UI.
 *
 * Parameters:
 * @param {number | "advisor"} agentId — The ID of the agent to remove, or "advisor" for the advisor.
 *
 * Returns:
 * @returns {void} — Returns after removing the agent status.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - taskStream — removes agent status when agents complete.
 * </Summary>
 */
export const removeAgentStatus = (agentId: number | "advisor"): void => {
  bridgeHooks.onAgentStatuses?.((prev) => {
    if (!prev.has(agentId)) {
      return prev;
    }
    const next = new Map(prev);
    next.delete(agentId);
    return next;
  });
};

/**
 * <Summary>
 * What it does:
 *   Clears all agent statuses and agent boards.
 *
 * How it does it (step by step):
 *   1. Create a new empty Map for agent statuses.
 *   2. Update the module-level map and trigger UI update.
 *   3. Clear the agent boards.
 *
 * Returns:
 * @returns {void} — Returns after clearing all agent statuses and boards.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - taskStream — clears all agent statuses at task start/completion.
 * </Summary>
 */
export const clearAgentStatuses = (): void => {
  bridgeHooks.onAgentStatuses?.(() => new Map());
  clearAgentBoards();
};

/**
 * <Summary>
 * What it does:
 *   Sets the agent boards with current task assignments.
 *
 * How it does it (step by step):
 *   1. Map over the provided boards to determine activity preservation.
 *   2. Check if each board has running tasks.
 *   3. If no running tasks, clear the activity; otherwise preserve from previous board.
 *   4. Update the module-level boards and trigger UI update.
 *
 * Parameters:
 * @param {AgentBoardState[]} boards — The array of agent boards to set.
 *
 * Returns:
 * @returns {void} — Returns after updating the agent boards.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - taskStream — updates agent boards when task assignments change.
 *   - Status frame handlers — update agent boards when assignments arrive.
 * </Summary>
 */
export const setAgentBoards = (boards: AgentBoardState[]): void => {
  bridgeHooks.onAgentBoards?.((prev) =>
    boards.map((board) => {
      const hasRunningTask = board.tasks.some((task) => task.state === "running");
      const previousBoard = prev.find(
        (previousBoard) => previousBoard.id === board.id,
      );
      return {
        ...board,
        activity: hasRunningTask
          ? (previousBoard?.activity ?? board.activity)
          : undefined,
      };
    }),
  );
};

/**
 * <Summary>
 * What it does:
 *   Updates the activity for a specific agent.
 *
 * How it does it (step by step):
 *   1. Find the agent board by ID.
 *   2. If not found, return early (agent doesn't exist).
 *   3. Map over the boards, updating the matching agent's activity.
 *   4. Update the module-level boards and trigger UI update.
 *
 * Parameters:
 * @param {number} agentId — The ID of the agent to update.
 * @param {{ stage: AgentStage; message: string } | null} activity — The new activity state, or null to clear it.
 *
 * Returns:
 * @returns {void} — Returns after updating the agent's activity.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - taskStream — updates agent activity during task execution.
 *   - Status frame handlers — update agent activity when frames arrive.
 * </Summary>
 */
export const updateAgentActivity = (
  agentId: number,
  activity: { stage: AgentStage; message: string } | null,
): void => {
  bridgeHooks.onAgentBoards?.((prev) => {
    const foundIndex = prev.findIndex((board) => board.id === agentId);
    if (foundIndex < 0) {
      return prev;
    }
    return prev.map((board, index) =>
      index === foundIndex
        ? { ...board, activity: activity ?? undefined }
        : board,
    );
  });
};

/**
 * <Summary>
 * What it does:
 *   Clears all agent boards.
 *
 * How it does it (step by step):
 *   1. Set the module-level boards array to empty.
 *   2. Call the registered onAgentBoards hook to update the UI.
 *
 * Returns:
 * @returns {void} — Returns after clearing the agent boards.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - clearAgentStatuses — calls this to clear boards along with statuses.
 * </Summary>
 */
export const clearAgentBoards = (): void => {
  bridgeHooks.onAgentBoards?.(() => []);
};

/**
 * <Summary>
 * What it does:
 *   Sets the application busy state to prevent duplicate submissions.
 *
 * How it does it (step by step):
 *   1. Call the registered onBusy hook if it exists.
 *   2. Pass the busy state (true for busy, false for not busy).
 *
 * Parameters:
 * @param {boolean} busyState — The busy state to set.
 *
 * Returns:
 * @returns {void} — Returns after triggering the busy hook.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - taskStream — sets busy state during task execution.
 *   - AppContext — receives busy state updates via hooks.
 * </Summary>
 */
export const setBusy = (busyState: boolean): void => {
  // ===== STEP 1: Trigger busy hook =====
  // Step 1a: Call the registered onBusy hook if it exists
  // Step 1b: Pass the busy state to the hook for display
  bridgeHooks.onBusy?.(busyState);
};

/**
 * <Summary>
 * What it does:
 *   Updates the current working directory label in the UI.
 *
 * How it does it (step by step):
 *   1. Call the registered onCwd hook if it exists.
 *   2. Pass the current working directory path to the hook.
 *
 * Parameters:
 * @param {string} currentWorkingDirectory — The current working directory path to display.
 *
 * Returns:
 * @returns {void} — Returns after triggering the CWD hook.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - taskStream — updates CWD when directory changes during task execution.
 *   - AppContext — receives CWD updates via hooks.
 * </Summary>
 */
export const setCwdLabel = (currentWorkingDirectory: string): void => {
  // ===== STEP 1: Trigger CWD hook =====
  // Step 1a: Call the registered onCwd hook if it exists
  // Step 1b: Pass the current working directory path to the hook for display
  bridgeHooks.onCwd?.(currentWorkingDirectory);
};

/** Notifies the Ink App to re-read config and re-render the banner. */
/**
 * <Summary>
 * What it does:
 *   Notifies the Ink App to re-read configuration and re-render the banner.
 *
 * How it does it (step by step):
 *   1. Call the registered onBannerRefresh hook if it exists.
 *   2. Pass the updated configuration to the hook.
 *
 * Parameters:
 * @param {Config} configuration — The updated configuration that triggered the banner refresh.
 *
 * Returns:
 * @returns {void} — Returns after triggering the banner refresh hook.
 *
 * Dependencies:
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - Configuration change handlers — call this when configuration changes.
 * </Summary>
 */
export const refreshInkBanner = (configuration: Config): void => {
  // ===== STEP 1: Trigger banner refresh hook =====
  // Step 1a: Call the registered onBannerRefresh hook if it exists
  // Step 1b: Pass the updated configuration to the hook for banner re-rendering
  bridgeHooks.onBannerRefresh?.(configuration);
};

/**
 * <Summary>
 * What it does:
 *   Returns the currently pending approval request.
 *
 * How it does it (step by step):
 *   1. Return the approval request from the pending approval object, or null if none.
 *
 * Returns:
 * @returns {ApprovalRequest | null} — The pending approval request, or null if no approval is pending.
 *
 * Dependencies:
 *   - pendingApproval — stores the pending approval request.
 *
 * Dependants:
 *   - AppContext — calls this to check if approval is pending on mount.
 * </Summary>
 */
export const getPendingApproval = (): ApprovalRequest | null =>
  pendingApproval?.req ?? null;

/**
 * <Summary>
 * What it does:
 *   Returns the currently pending prompt request.
 *
 * How it does it (step by step):
 *   1. Return the prompt request from the pending prompt object, or null if none.
 *
 * Returns:
 * @returns {PromptRequest | null} — The pending prompt request, or null if no prompt is pending.
 *
 * Dependencies:
 *   - pendingPrompt — stores the pending prompt request.
 *
 * Dependants:
 *   - AppContext — calls this to check if prompt is pending on mount.
 * </Summary>
 */
export const getPendingPrompt = (): PromptRequest | null =>
  pendingPrompt?.req ?? null;

/**
 * <Summary>
 * What it does:
 *   Requests user approval for an action (plan, file operation, or command).
 *
 * How it does it (step by step):
 *   1. Check if Ink is active (UI is available).
 *   2. If Ink is not active, auto-resolve with default values (simpler for non-interactive environments).
 *   3. If Ink is active, create a promise with the approval request.
 *   4. Store the request and resolve function in pending approval.
 *   5. Trigger the onApprovalChange hook to display the approval dialog.
 *   6. Return the promise which resolves when user responds.
 *
 * Parameters:
 * @param {ApprovalRequest} approvalRequest — The approval request to display.
 *
 * Returns:
 * @returns {Promise<ApprovalResult>} — Promise that resolves when the user responds to the approval request.
 *
 * Dependencies:
 *   - isInkActive — checks if UI is available.
 *   - bridgeHooks — provides the registered hooks.
 *   - pendingApproval — stores the pending request.
 *
 * Dependants:
 *   - taskStream — uses this to request plan, file, and command approvals.
 *
 * Note:
 *   All approvals should always be shown for user confirmation. Only auto-resolve if Ink is not
 *   active (UI not available). This ensures user control even in automated environments.
 * </Summary>
 */
export const requestApproval = (
  approvalRequest: ApprovalRequest,
): Promise<ApprovalResult> => {
  // ===== STEP 1: Check UI availability =====
  // Step 1a: All approvals should always be shown for user confirmation
  // Step 1b: Only auto-resolve if ink is not active (UI not available)

  // ===== STEP 2: Fail closed if UI not available =====
  if (!inkUIActive) {
    if (approvalRequest.type === "planReview")
      return Promise.resolve("skip" as const);
    return Promise.resolve(false);
  }

  // ===== STEP 3: Reject concurrent requests =====
  if (pendingApproval !== null) {
    return Promise.reject(new Error("Approval request already pending"));
  }

  // ===== STEP 4: Create approval promise =====
  // Step 4a: Return a new promise that will resolve when user responds
  return new Promise((resolveFunction) => {
    // Step 3b: Store the approval request and resolve function for later resolution
    pendingApproval = { req: approvalRequest, resolve: resolveFunction };

    // Step 3c: Trigger the onApprovalChange hook to display the approval dialog
    bridgeHooks.onApprovalChange?.(approvalRequest);
  });
};

/**
 * <Summary>
 * What it does:
 *   Resolves a pending approval request with the user's decision.
 *
 * How it does it (step by step):
 *   1. Store the current pending approval request in a local variable.
 *   2. Clear the pending approval to null (request has been resolved).
 *   3. Trigger the onApprovalChange hook with null (dialog should be hidden).
 *   4. Call the resolve function with the user's approval result.
 *
 * Parameters:
 * @param {ApprovalResult} approvalResult — The user's approval decision or result.
 *
 * Returns:
 * @returns {void} — Returns after resolving the approval request.
 *
 * Dependencies:
 *   - pendingApproval — stores the pending approval request.
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - ApprovalMenu — calls this when user responds to the approval dialog.
 * </Summary>
 */
export const resolveApproval = (approvalResult: ApprovalResult): void => {
  // ===== STEP 1: Get pending request =====
  // Step 1a: Store the current pending approval request in a local variable
  const currentPendingApproval = pendingApproval;

  // ===== STEP 2: Clear pending approval =====
  // Step 2a: Clear the pending approval to null (request has been resolved)
  pendingApproval = null;

  // ===== STEP 3: Hide approval dialog =====
  // Step 3a: Trigger the onApprovalChange hook with null to hide the approval dialog
  bridgeHooks.onApprovalChange?.(null);

  // ===== STEP 4: Resolve with user's decision =====
  // Step 4a: Call the resolve function with the user's approval result
  currentPendingApproval?.resolve(approvalResult);
};

/**
 * <Summary>
 * What it does:
 *   Requests user input through a prompt dialog.
 *
 * How it does it (step by step):
 *   1. Check if Ink is active (UI is available).
 *   2. If Ink is not active, auto-resolve with default values based on prompt type.
 *   3. If Ink is active, create a promise with the prompt request.
 *   4. Store the request and resolve function in pending prompt.
 *   5. Trigger the onPromptChange hook to display the prompt dialog.
 *   6. Return the promise which resolves when user responds.
 *
 * Parameters:
 * @param {PromptRequest} promptRequest — The prompt request to display.
 *
 * Returns:
 * @returns {Promise<PromptResult>} — Promise that resolves when the user responds to the prompt.
 *
 * Dependencies:
 *   - isInkActive — checks if UI is available.
 *   - bridgeHooks — provides the registered hooks.
 *   - pendingPrompt — stores the pending request.
 *
 * Dependants:
 *   - taskStream — uses this to request plan editing.
 *   - promptPort — uses this for line, choice, and theme prompts.
 *
 * Note:
 *   All prompts should always be shown for user interaction. Only auto-resolve if Ink is not active
 *   (UI not available). This ensures user control even in automated environments.
 * </Summary>
 */
export const requestPrompt = (
  promptRequest: PromptRequest,
): Promise<PromptResult> => {
  // ===== STEP 1: Check UI availability =====
  // Step 1a: All prompts should always be shown for user interaction
  // Step 1b: Only auto-resolve if ink is not active (UI not available)

  // ===== STEP 2: Fail closed if UI not available =====
  if (!inkUIActive) {
    if (promptRequest.type === "choice") return Promise.resolve(0);
    if (promptRequest.type === "planEdit")
      return Promise.resolve(promptRequest.initial);
    if (promptRequest.type === "theme") return Promise.resolve(undefined);
    return Promise.resolve("");
  }

  // ===== STEP 3: Reject concurrent requests =====
  if (pendingPrompt !== null) {
    return Promise.reject(new Error("Prompt request already pending"));
  }

  // ===== STEP 4: Create prompt promise =====
  // Step 4a: Return a new promise that will resolve when user responds
  return new Promise((resolveFunction) => {
    // Step 3b: Store the prompt request and resolve function for later resolution
    pendingPrompt = { req: promptRequest, resolve: resolveFunction };

    // Step 3c: Trigger the onPromptChange hook to display the prompt dialog
    bridgeHooks.onPromptChange?.(promptRequest);
  });
};

/**
 * <Summary>
 * What it does:
 *   Resolves a pending prompt request with the user's input.
 *
 * How it does it (step by step):
 *   1. Store the current pending prompt request in a local variable.
 *   2. Clear the pending prompt to null (request has been resolved).
 *   3. Trigger the onPromptChange hook with null (dialog should be hidden).
 *   4. Call the resolve function with the user's prompt result.
 *
 * Parameters:
 * @param {PromptResult} promptResult — The user's input or selection.
 *
 * Returns:
 * @returns {void} — Returns after resolving the prompt request.
 *
 * Dependencies:
 *   - pendingPrompt — stores the pending prompt request.
 *   - bridgeHooks — provides the registered hooks.
 *
 * Dependants:
 *   - PromptOverlay — calls this when user responds to the prompt dialog.
 * </Summary>
 */
export const resolvePrompt = (promptResult: PromptResult): void => {
  // ===== STEP 1: Get pending request =====
  // Step 1a: Store the current pending prompt request in a local variable
  const currentPendingPrompt = pendingPrompt;

  // ===== STEP 2: Clear pending prompt =====
  // Step 2a: Clear the pending prompt to null (request has been resolved)
  pendingPrompt = null;

  // ===== STEP 3: Hide prompt dialog =====
  // Step 3a: Trigger the onPromptChange hook with null to hide the prompt dialog
  bridgeHooks.onPromptChange?.(null);

  // ===== STEP 4: Resolve with user's input =====
  // Step 4a: Call the resolve function with the user's prompt result
  currentPendingPrompt?.resolve(promptResult);
};

/** Alternate screen buffer enter/exit (gemini-cli style). */
/**
 * <Summary>
 * What it does:
 *   Enters the alternate screen buffer mode for full-screen terminal display.
 *
 * How it does it (step by step):
 *   1. Check if stdout is a TTY (interactive terminal).
 *   2. If not a TTY, return early (alternate screen doesn't work in pipes/redirects).
 *   3. Write the ANSI escape sequence to enter alternate screen buffer.
 *   4. Write the sequence to hide the cursor.
 *
 * Returns:
 * @returns {void} — Returns after entering alternate screen mode.
 *
 * Dependencies:
 *   - node:process.stdout — provides the terminal output stream.
 *
 * Dependants:
 *   - AppContext — calls this when using alternate screen mode.
 *
 * Note:
 *   This is the gemini-cli style of alternate screen management. It provides a
 *   full-screen interface that doesn't scroll with the rest of the terminal content.
 * </Summary>
 */
export const enterAlternateScreen = (): void => {
  // ===== STEP 1: Check if terminal is TTY =====
  // Step 1a: Check if stdout is a TTY (interactive terminal)
  // Step 1b: If not a TTY, return early (alternate screen doesn't work in pipes/redirects)
  if (!process.stdout.isTTY) return;

  // ===== STEP 2: Enter alternate screen and hide cursor =====
  // Step 2a: Write ANSI escape sequence to enter alternate screen buffer (application cursor mode)
  // Step 2b: Write sequence to hide the cursor
  process.stdout.write("\x1b[?1049h\x1b[?25l");
};

/**
 * <Summary>
 * What it does:
 *   Exits the alternate screen buffer mode and restores normal terminal display.
 *
 * How it does it (step by step):
 *   1. Check if stdout is a TTY (interactive terminal).
 *   2. If not a TTY, return early (alternate screen doesn't work in pipes/redirects).
 *   3. Write the ANSI escape sequence to show the cursor.
 *   4. Write the sequence to exit alternate screen buffer.
 *
 * Returns:
 * @returns {void} — Returns after exiting alternate screen mode.
 *
 * Dependencies:
 *   - node:process.stdout — provides the terminal output stream.
 *
 * Dependants:
 *   - AppContext — calls this when unmounting with alternate screen mode.
 *
 * Note:
 *   This is the gemini-cli style of alternate screen management. It restores the
 *   normal terminal scrolling behavior after the application exits.
 * </Summary>
 */
export const exitAlternateScreen = (): void => {
  // ===== STEP 1: Check if terminal is TTY =====
  // Step 1a: Check if stdout is a TTY (interactive terminal)
  // Step 1b: If not a TTY, return early (alternate screen doesn't work in pipes/redirects)
  if (!process.stdout.isTTY) return;

  // ===== STEP 2: Show cursor and exit alternate screen =====
  // Step 2a: Write ANSI escape sequence to show the cursor
  // Step 2b: Write sequence to exit alternate screen buffer (normal cursor mode)
  process.stdout.write("\x1b[?25h\x1b[?1049l");
};
