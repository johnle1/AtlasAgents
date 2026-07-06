/**
 * Spinner state synchronizer for CLI progress reporting.
 *
 * @remarks
 * Decides whether the status spinner should be in "thinking" or "working" mode,
 * or cleared entirely, based on task status frames incoming from the advisor/agents.
 */

import type { AdvisorStage, TaskFrame } from "../frames.js";
import type { SpinnerState } from "./types.js";

/**
 * Set of advisor workflow stages that represent active thinking.
 */
const ADVISOR_THINKING_STAGES = new Set<AdvisorStage>([
  "understanding",
  "reading-context",
  "drafting",
  "verifying",
  "revising",
  "combining",
]);

/**
 * Helper to construct a spinner state object configured for "thinking" (braille indicator).
 *
 * @param label - The label text to show beside the spinner.
 */
const thinkingSpinner = (label: string): SpinnerState => ({
  active: true,
  label,
  mode: "thinking",
});

/**
 * Helper to construct a spinner state object configured for "working" (command/file execution).
 *
 * @param label - The label text to show beside the spinner.
 */
const workingSpinner = (label: string): SpinnerState => ({
  active: true,
  label,
  mode: "working",
});

/**
 * Maps an incoming server task status frame to the corresponding bottom-line CLI spinner state.
 *
 * @remarks
 * - Returns a `SpinnerState` object if a spinner should be visible.
 * - Returns `null` if the spinner should be cleared/hidden.
 * - Returns `undefined` if the current spinner state should be left unchanged.
 *
 * @param frame - The task status frame to evaluate.
 * @returns The target spinner configuration, or `null`/`undefined`.
 */
export const spinnerForStatusFrame = (
  frame: TaskFrame,
): SpinnerState | null | undefined => {
  if (frame.kind !== "status") {
    return undefined;
  }

  if (frame.source === "advisor") {
    // If advisor is actively generating suggestions and thinking icon is set
    if (
      ADVISOR_THINKING_STAGES.has(frame.stage as AdvisorStage) &&
      frame.icon === "◌"
    ) {
      return thinkingSpinner("Advisor");
    }

    // Once advisor has completed draft and is ready for interaction
    if (frame.stage === "ready") {
      return null;
    }

    return undefined;
  }

  // Handle agent-level progress states
  if (frame.activity?.stage === "thinking") {
    return thinkingSpinner("Agent");
  }

  if (frame.stage === "thinking") {
    return thinkingSpinner("Agent");
  }

  if (frame.activity) {
    return workingSpinner(frame.activity.message);
  }

  // Clear spinner when agent has finished all steps
  return null;
};

