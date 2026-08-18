/**
 * User approval request management for the Ink CLI UI.
 *
 * @remarks
 * This module coordinates user confirmation workflows between the back-end services
 * and the React UI. When the CLI is run non-interactively (without Ink active),
 * approvals are auto-resolved with safe defaults.
 */

import type { ApprovalRequest, ApprovalResult } from "../types.js";
import { getInkUIActive, getBridgeHooks } from "./state.js";
import { getPendingApprovalEntry, setPendingApprovalEntry } from "./state.js";
import { dismissValueFor } from "../components/approvalKeymap.js";
import { notifyUser } from "../notify.js";
import {
  getApprovalMode,
  ruleFromRequest,
  sessionAllowlist,
} from "./allowlist.js";

/**
 * Retrieves the currently pending approval request from the state registry.
 *
 * @returns The pending approval request details, or `null` if no request is active.
 */
export const getPendingApproval = (): ApprovalRequest | null =>
  getPendingApprovalEntry()?.req ?? null;

/**
 * Requests user approval for a task, returning a promise that resolves with the decision.
 *
 * @remarks
 * Short-circuit order: session allowlist → `bypass` (all types) →
 * `accept_edits` / `auto` keepUndo → `auto` planReview → UI.
 * `accept_edits` covers file edits only; shell commands, plan reviews,
 * and other risky actions still prompt. `auto` is the hands-off mode:
 * file edits and plan reviews auto-approve here, and the command layer
 * runs safe commands free and cautious ones sandboxed. The bridge must
 * not short-circuit `runSkip` — the command layer only routes here when
 * it already decided a prompt is warranted (e.g. dangerous commands).
 * `planReview` resolves `"implement"` (a {@link PlanDecision}), never
 * `true` — the server validates the decision token.
 * If the Ink interface is inactive, this function resolves immediately with a default fallback
 * (e.g. skip for plan reviews, false/deny for other prompts).
 *
 * @param approvalRequest - The approval details to present to the user.
 * @returns A promise resolving to the user's approval choice (`boolean` or `"skip"`).
 * @throws {@link Error} If another approval request is already pending.
 */
export const requestApproval = (
  approvalRequest: ApprovalRequest,
): Promise<ApprovalResult> => {
  if (sessionAllowlist.matches(approvalRequest)) {
    return Promise.resolve(true);
  }

  const mode = getApprovalMode();

  if (mode === "bypass") {
    return Promise.resolve(
      approvalRequest.type === "planReview" ? "implement" : true,
    );
  }

  if (
    (mode === "accept_edits" || mode === "auto") &&
    approvalRequest.type === "keepUndo"
  ) {
    return Promise.resolve(true);
  }

  if (mode === "auto" && approvalRequest.type === "planReview") {
    return Promise.resolve("implement");
  }

  const isUIActive = getInkUIActive();
  if (!isUIActive) {
    return Promise.resolve(dismissValueFor(approvalRequest.type));
  }

  const existingPendingApproval = getPendingApprovalEntry();
  if (existingPendingApproval !== null) {
    return Promise.reject(new Error("Approval request already pending"));
  }

  return new Promise((resolveApprovalFunction) => {
    setPendingApprovalEntry({
      req: approvalRequest,
      resolve: resolveApprovalFunction,
    });

    getBridgeHooks().onApprovalChange?.(approvalRequest);
    notifyUser("Action required");
  });
};

/**
 * Resolves the currently pending approval request with the user's decision.
 *
 * @param approvalResult - The user's confirmation decision.
 */
export const resolveApproval = (approvalResult: ApprovalResult): void => {
  const currentPendingApproval = getPendingApprovalEntry();

  if (approvalResult === "always" && currentPendingApproval) {
    const rule = ruleFromRequest(currentPendingApproval.req);
    if (rule) {
      sessionAllowlist.add(rule);
    }
  }

  setPendingApprovalEntry(null);
  getBridgeHooks().onApprovalChange?.(null);

  const resolved: ApprovalResult =
    approvalResult === "always" ? true : approvalResult;
  currentPendingApproval?.resolve(resolved);
};

/**
 * Cancels all pending approval requests, resolving them with default fallback values.
 *
 * @remarks
 * Typically called when the terminal session disconnects or is interrupted.
 */
export const cancelPendingApprovals = (): void => {
  const currentPendingApproval = getPendingApprovalEntry();
  if (!currentPendingApproval) return;

  setPendingApprovalEntry(null);
  getBridgeHooks().onApprovalChange?.(null);

  const approvalResult: ApprovalResult = dismissValueFor(
    currentPendingApproval.req.type,
  );
  currentPendingApproval.resolve(approvalResult);
};

