/**
 * <Summary>
 * What it does:
 *   Provides functions for managing user approval requests in the Ink-based CLI UI.
 *
 * How it fits in the system:
 *   This module handles the approval workflow where the server requests user confirmation
 *   for actions like plan review, command execution, or file operations. It manages
 *   pending approval state, routes requests to the UI, and resolves approvals with user responses.
 * </Summary>
 */

import type { ApprovalRequest, ApprovalResult } from "../types.js";
import { getInkUIActive, getBridgeHooks } from "./state.js";
import { getPendingApprovalEntry, setPendingApprovalEntry } from "./state.js";

/**
 * <Summary>
 * What it does:
 *   Retrieves the currently pending approval request, if any.
 *
 * How it does it (step by step):
 *   1. Gets the pending approval entry from state.
 *   2. Extracts the request object from the entry.
 *   3. Returns null if no approval is pending.
 *
 * Returns:
 *   @returns The pending approval request or null.
 * </Summary>
 */
export const getPendingApproval = (): ApprovalRequest | null =>
  getPendingApprovalEntry()?.req ?? null;

/**
 * <Summary>
 * What it does:
 *   Requests user approval for a server action, displaying it in the UI if the
 *   Ink interface is active, or auto-resolving with defaults if running non-interactively.
 *
 * How it does it (step by step):
 *   1. Checks if the Ink UI is currently active.
 *   2. If UI not active, resolves with default based on request type.
 *   3. If another approval is already pending, rejects the new request.
 *   4. Otherwise, stores the request and resolver in pending state.
 *   5. Notifies the UI to display the approval request.
 *   6. Returns a promise that resolves when user responds.
 *
 * Parameters:
 *   @param approvalRequest - The approval request to present to the user.
 *
 * Returns:
 *   @returns Promise that resolves with user's approval decision.
 *
 * @throws {Error} — When an approval request is already pending.
 * </Summary>
 */
export const requestApproval = (
  approvalRequest: ApprovalRequest,
): Promise<ApprovalResult> => {
  // ===== STEP 1: Check if Ink UI is Active =====
  // Step 1a: Check if the Ink-based CLI interface is currently active
  // Step 1b: If not running interactively, use default auto-resolution behavior
  const isUIActive = getInkUIActive();
  if (!isUIActive) {
    // ===== STEP 1a-i: Auto-Resolve Based on Request Type =====
    // Step 1a-i-1: For plan review requests, default to "skip" (non-interactive)
    if (approvalRequest.type === "planReview") {
      return Promise.resolve("skip" as const);
    }
    // Step 1a-i-2: For other requests, default to false/reject
    return Promise.resolve(false);
  }

  // ===== STEP 2: Check for Existing Pending Approval =====
  // Step 2a: Check if there's already a pending approval request
  // Step 2b: This prevents multiple simultaneous approval requests
  const existingPendingApproval = getPendingApprovalEntry();
  if (existingPendingApproval !== null) {
    // Step 2a-i: Reject the new request if one is already pending
    return Promise.reject(new Error("Approval request already pending"));
  }

  // ===== STEP 3: Store Request and Wait for User Response =====
  // Step 3a: Create a new promise to handle the approval workflow
  return new Promise((resolveApprovalFunction) => {
    // Step 3a-i: Store the approval request and resolver in pending state
    // Step 3a-i-1: This allows the resolver to be called when user responds
    setPendingApprovalEntry({
      req: approvalRequest,
      resolve: resolveApprovalFunction,
    });

    // Step 3a-ii: Notify the UI to display the approval request
    // Step 3a-ii-1: This triggers the ApprovalMenu component to render
    getBridgeHooks().onApprovalChange?.(approvalRequest);
  });
};

/**
 * <Summary>
 * What it does:
 *   Resolves a pending approval request with the user's decision.
 *
 * How it does it (step by step):
 *   1. Gets the currently pending approval entry.
 *   2. Clears the pending approval state.
 *   3. Notifies the UI to hide the approval menu.
 *   4. Calls the resolver with the user's approval result.
 *
 * Parameters:
 *   @param approvalResult - The user's approval decision.
 *
 * Returns:
 *   void — called for side effects only.
 * </Summary>
 */
export const resolveApproval = (approvalResult: ApprovalResult): void => {
  // ===== STEP 1: Get Current Pending Approval =====
  // Step 1a: Retrieve the currently pending approval entry from state
  // Step 1b: This contains the request and the resolver function
  const currentPendingApproval = getPendingApprovalEntry();

  // ===== STEP 2: Clear Pending Approval State =====
  // Step 2a: Clear the pending approval entry from state
  // Step 2b: This removes the approval request from global state
  setPendingApprovalEntry(null);

  // ===== STEP 3: Notify UI to Hide Approval Menu =====
  // Step 3a: Notify the UI that approval is no longer pending
  // Step 3b: This triggers the ApprovalMenu component to unmount
  getBridgeHooks().onApprovalChange?.(null);

  // ===== STEP 4: Resolve Promise with User's Decision =====
  // Step 4a: Call the resolver function with the approval result
  // Step 4b: This resolves the promise returned by requestApproval
  currentPendingApproval?.resolve(approvalResult);
};
