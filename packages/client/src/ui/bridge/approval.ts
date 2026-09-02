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
import {
  getPendingApprovalEntry,
  setPendingApprovalEntry,
  enqueueApproval,
  dequeueNextApproval,
  drainApprovalQueue,
} from "./state.js";
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
 * Short-circuit order: session allowlist → `auto` (all types) →
 * `accept_edits` keepUndo → UI. `accept_edits` covers file edits only;
 * shell commands and plan reviews still prompt. `auto` is full bypass —
 * every request type auto-approves unconditionally, including shell
 * commands the command layer would otherwise gate (dangerous included).
 * `planReview` resolves `"implement"` (a {@link PlanDecision}), never
 * `true` — the server validates the decision token.
 * If the Ink interface is inactive, this function resolves immediately with a default fallback
 * (e.g. skip for plan reviews, false/deny for other prompts).
 *
 * @param approvalRequest - The approval details to present to the user.
 * @returns A promise resolving to the user's approval choice (`boolean` or `"skip"`).
 */
export const requestApproval = (
  approvalRequest: ApprovalRequest,
): Promise<ApprovalResult> => {
  if (sessionAllowlist.matches(approvalRequest)) {
    return Promise.resolve(true);
  }

  const mode = getApprovalMode();

  if (mode === "auto") {
    return Promise.resolve(
      approvalRequest.type === "planReview" ? "implement" : true,
    );
  }

  if (mode === "accept_edits" && approvalRequest.type === "keepUndo") {
    return Promise.resolve(true);
  }

  const isUIActive = getInkUIActive();
  if (!isUIActive) {
    return Promise.resolve(dismissValueFor(approvalRequest.type));
  }

  const existingPendingApproval = getPendingApprovalEntry();
  if (existingPendingApproval !== null) {
    // A second concurrent request (e.g. a parallel batch's second file
    // write) queues rather than failing outright — resolveApproval below
    // advances the queue once the active one is answered. Mirrors
    // workspace/review/planReviewBroker.ts's queue/active pattern on the
    // server side.
    return new Promise((resolveApprovalFunction) => {
      enqueueApproval({ req: approvalRequest, resolve: resolveApprovalFunction });
    });
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
 * @remarks
 * If another request was queued behind this one (see `requestApproval`), it
 * becomes the new active entry and `onApprovalChange` fires for it — this
 * is what actually gives a queued request its turn. The UI never sees the
 * queue itself, only the single active entry it's always read.
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

  const resolved: ApprovalResult =
    approvalResult === "always" ? true : approvalResult;
  currentPendingApproval?.resolve(resolved);

  const next = dequeueNextApproval();
  setPendingApprovalEntry(next);
  getBridgeHooks().onApprovalChange?.(next?.req ?? null);
  if (next) {
    notifyUser("Action required");
  }
};

/**
 * Cancels all pending approval requests, resolving them with default fallback values.
 *
 * @remarks
 * Typically called when the terminal session disconnects or is interrupted.
 * Drains the queue too, not just the active entry — a caller `await`ing a
 * queued request would otherwise hang forever past session teardown.
 */
export const cancelPendingApprovals = (): void => {
  const currentPendingApproval = getPendingApprovalEntry();
  const queuedApprovals = drainApprovalQueue();
  if (!currentPendingApproval && queuedApprovals.length === 0) {
    return;
  }

  setPendingApprovalEntry(null);
  getBridgeHooks().onApprovalChange?.(null);

  if (currentPendingApproval) {
    currentPendingApproval.resolve(
      dismissValueFor(currentPendingApproval.req.type),
    );
  }
  for (const queuedApproval of queuedApprovals) {
    queuedApproval.resolve(dismissValueFor(queuedApproval.req.type));
  }
};

