/**
 * Composed approval + free-text revise flow shared by command and file
 * approval prompts (`runSkip` / `keepUndo`).
 *
 * @remarks
 * The plain {@link requestApproval} bridge call resolves to `true`/`false`
 * for those two request types, or the string `"edit"` when the user picks
 * "Revise". Callers that naively cast the result `as boolean` would treat
 * `"edit"` as truthy and proceed as if approved — this wraps that call so
 * "Revise" always resolves to a declined outcome plus the free-text reason.
 */

import type { ApprovalRequest } from "./types.js";
import { requestApproval, requestPrompt } from "./uiBridge.js";
import { printReviseRequested, printSkipped } from "../renderer.js";

/** Outcome of a {@link requestApprovalWithFeedback} call. */
export type ApprovalOutcome = {
  /** `true` only when the user picked the affirmative option (Run / Keep). */
  approved: boolean;
  /** Free-text reason when the user picked "Revise"; absent otherwise. */
  feedback?: string;
};

/**
 * Requests a `runSkip` / `keepUndo` approval and resolves "Revise" into
 * declined + feedback text instead of leaving it as a stray truthy string.
 *
 * @param request - The approval request to show (must be `runSkip` or `keepUndo`).
 * @param revisePrompt - Question shown in the follow-up text prompt when the
 *   user picks "Revise".
 * @returns `{ approved: true }` when accepted; `{ approved: false }` when
 *   skipped/undone; `{ approved: false, feedback }` when revised.
 */
export const requestApprovalWithFeedback = async (
  request: ApprovalRequest,
  revisePrompt: string,
): Promise<ApprovalOutcome> => {
  const decision = await requestApproval(request);

  if (decision === "edit") {
    const response = await requestPrompt({ type: "line", prompt: revisePrompt });
    const feedback = typeof response === "string" ? response.trim() : "";
    return feedback.length > 0 ? { approved: false, feedback } : { approved: false };
  }

  return { approved: decision === true };
};

/**
 * Prints the right decline message for a declined {@link ApprovalOutcome}.
 *
 * @remarks
 * Callers that show a revise-or-skip prompt all branch on the same thing:
 * "Revise" (has `feedback`) prints the revise-requested line, plain decline
 * prints the skipped line. Centralizes that branch so it isn't repeated at
 * every call site.
 *
 * @param feedback - The `feedback` field from a declined {@link ApprovalOutcome}.
 */
export const printDeclineFeedback = (feedback?: string): void => {
  if (feedback) {
    printReviseRequested();
  } else {
    printSkipped();
  }
};
