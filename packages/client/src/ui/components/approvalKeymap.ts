/**
 * Pure approval-menu keymap and option list.
 *
 * @remarks
 * Extracted from {@link ApprovalMenu} so Esc / digit hotkeys can be unit-tested
 * without rendering an Ink tree. Esc defaults **must** match
 * {@link cancelPendingApprovals}: `planReview` → `"skip"`, everything else →
 * `false`. Drift here means Esc and a network drop make different decisions.
 */

import type { ApprovalRequest, PlanDecision } from "../types.js";
import type { ApprovalMenuOption as Option } from "./types.js";

/** Decision value a menu option can resolve to. */
export type ApprovalKeyValue =
  | boolean
  | PlanDecision
  | "always"
  | "autoAcceptEdits"
  | "manualApprove";

/**
 * Result of mapping a keystroke onto the approval menu.
 *
 * - `noop` — ignore the key
 * - `move` — highlight a new index (clamped)
 * - `confirm` — resolve with the chosen option (Enter or digit 1–3)
 * - `dismiss` — Esc; value is the safe default for the request type
 */
export type ApprovalKeyAction =
  | { type: "noop" }
  | { type: "move"; index: number }
  | { type: "confirm"; value: ApprovalKeyValue }
  | { type: "dismiss"; value: ApprovalKeyValue };

/**
 * Ink `useInput` key flags this keymap reads.
 */
export type ApprovalKeyInformation = {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
};

/**
 * Safe default when the user dismisses (Esc) or the session drops.
 *
 * @remarks
 * Identical to {@link cancelPendingApprovals}: a plan review is skipped; a
 * file/command approval is denied. Do not change one without the other.
 *
 * @param requestType - Discriminator of the pending {@link ApprovalRequest}.
 * @returns `"skip"` for plan review, otherwise `false`.
 */
export const dismissValueFor = (
  requestType: ApprovalRequest["type"],
): ApprovalKeyValue => (requestType === "planReview" ? "skip" : false);

/**
 * Builds the selectable rows for an approval request.
 *
 * @param request - Pending approval payload from the agent.
 * @returns Menu options in display order (index 0 is the first digit key).
 */
export const buildOptions = (
  request: ApprovalRequest,
): Option<ApprovalKeyValue>[] =>
  request.type === "planReview"
    ? [
        { label: "Yes, and auto-accept edits", value: "autoAcceptEdits", color: "green" },
        { label: "Yes, and manually approve edits", value: "manualApprove", color: "green" },
        { label: "No, keep planning", value: "edit", color: "cyan" },
      ]
    : request.type === "runSkip"
      ? [
          { label: "Run", value: true, color: "green" },
          { label: "Skip", value: false, color: "red" },
          { label: "Revise", value: "edit", color: "cyan" },
          { label: "Always allow (session)", value: "always", color: "green" },
        ]
      : [
          { label: "Keep", value: true, color: "cyan" },
          { label: "Undo", value: false },
          { label: "Revise", value: "edit", color: "cyan" },
          { label: "Always allow (session)", value: "always", color: "green" },
        ];

/**
 * Maps a keystroke to an approval-menu action.
 *
 * @remarks
 * Digit keys `"1"`–`"3"` jump to that option and confirm immediately
 * Out-of-range digits are ignored. Esc uses
 * {@link dismissValueFor}.
 *
 * @param input - Raw character from Ink `useInput`.
 * @param key - Arrow / Enter / Esc flags.
 * @param options - Current menu rows from {@link buildOptions}.
 * @param selectedIndex - Currently highlighted row.
 * @param requestType - Used only for Esc's safe default.
 * @returns The action the menu should take.
 *
 * @example
 * ```ts
 * const action = resolveApprovalKey("1", {}, options, 0, "runSkip");
 * // { type: "confirm", value: true }
 * ```
 */
export const resolveApprovalKey = (
  input: string,
  key: ApprovalKeyInformation,
  options: Option<ApprovalKeyValue>[],
  selectedIndex: number,
  requestType: ApprovalRequest["type"],
): ApprovalKeyAction => {
  if (key.escape) {
    return { type: "dismiss", value: dismissValueFor(requestType) };
  }

  if (key.upArrow) {
    return { type: "move", index: Math.max(0, selectedIndex - 1) };
  }

  if (key.downArrow) {
    return {
      type: "move",
      index: Math.min(options.length - 1, selectedIndex + 1),
    };
  }

  if (key.return) {
    const selected = options[selectedIndex];
    if (!selected) return { type: "noop" };
    return { type: "confirm", value: selected.value };
  }

  if (input.length === 1 && input >= "1" && input <= "9") {
    const optionIndex = Number(input) - 1;
    const selected = options[optionIndex];
    if (!selected) return { type: "noop" };
    return { type: "confirm", value: selected.value };
  }

  return { type: "noop" };
};
