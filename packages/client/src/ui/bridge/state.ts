/**
 * Global state store for the Ink UI bridge.
 *
 * @remarks
 * This module acts as a singleton data store keeping track of UI status, active hooks,
 * pending user interactions (prompts and approvals), and streaming token handlers.
 */

import type { BridgeHooks, PendingApproval, PendingPrompt } from "./types.js";
import type { PlanStepState } from "../types.js";

export type { BridgeHooks, PendingApproval, PendingPrompt } from "./types.js";

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
  activeTaskCancel: (() => void) | null;
  /** Mirrors DataContext's `activePlan` so non-React code (e.g. modelSelectionHandlers.ts's post-switch confirmation) can read the current checklist without a React context. */
  activePlan: PlanStepState[];
};

const bridgeGlobalState: BridgeState = {
  hooks: {},
  inkUIActive: false,
  taskActive: false,
  pendingApproval: null,
  pendingPrompt: null,
  streamingTokenHandler: null,
  activeTaskCancel: null,
  activePlan: [],
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

/**
 * Stores the cancel callback for the in-flight task stream, or `null` when idle.
 *
 * @param cancel - Function that aborts the current RSocket task stream.
 */
export const setActiveTaskCancelValue = (
  cancel: (() => void) | null,
): void => {
  bridgeGlobalState.activeTaskCancel = cancel;
};

/**
 * Returns the cancel callback for the in-flight task stream, if any.
 *
 * @returns The cancel function, or `null` when no task is running.
 */
export const getActiveTaskCancelValue = (): (() => void) | null =>
  bridgeGlobalState.activeTaskCancel;

/**
 * Returns the agent's current live checklist, as last reported via
 * `update_plan` (see `PlanChecklist.tsx`). Read by non-React code — e.g.
 * `modelSelectionHandlers.ts`'s post-switch "Plan carried over" message —
 * that needs the current value without a React context.
 */
export const getActivePlanValue = (): PlanStepState[] =>
  bridgeGlobalState.activePlan;

/** Updates the mirrored checklist value. Called alongside the React state setter. */
export const setActivePlanValue = (steps: PlanStepState[]): void => {
  bridgeGlobalState.activePlan = steps;
};
