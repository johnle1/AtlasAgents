/**
 * Spinner state synchronizer for CLI progress reporting.
 *
 * @remarks
 * Decides whether the status spinner should be in "thinking" or "working" mode,
 * or cleared entirely, based on task status frames incoming from the agent/subagents.
 */

import type { AgentStage, TaskFrame } from "../types/frames.js";
import type { SpinnerState } from "./types.js";

/**
 * Set of subagent workflow stages that represent active thinking.
 */
const AGENT_THINKING_STAGES = new Set<AgentStage>([
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

  if (frame.source === "agent") {
    // If agent is actively generating suggestions and thinking icon is set
    if (
      AGENT_THINKING_STAGES.has(frame.stage as AgentStage) &&
      frame.icon === "◌"
    ) {
      return thinkingSpinner("Agent");
    }

    // Once agent has completed draft and is ready for interaction
    if (frame.stage === "ready") {
      return null;
    }

    return undefined;
  }

  // Handle subagent-level progress states
  if (frame.activity?.stage === "thinking") {
    return thinkingSpinner("Subagent");
  }

  if (frame.stage === "thinking") {
    return thinkingSpinner("Subagent");
  }

  if (frame.activity) {
    if (frame.activity.stage === "escalating" || frame.stage === "escalating") {
      return null;
    }
    return workingSpinner(frame.activity.message);
  }

  if (frame.stage === "escalating") {
    return null;
  }

  // Clear spinner when agent has finished all steps
  return null;
};
