import type { AdvisorStage, TaskFrame } from "../frames.js";
import type { SpinnerState } from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Defines the set of advisor stages that should show a thinking spinner.
 *
 * Used by:
 *   - spinnerForStatusFrame — checks if an advisor stage is in this set.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Creates a spinner state for thinking operations.
 *
 * How it does it (step by step):
 *   1. Create a spinner state with active flag set to true.
 *   2. Set the label to the provided text.
 *   3. Set the mode to "thinking" for braille indicator display.
 *
 * Parameters:
 * @param {string} label — The label text to display next to the spinner.
 *
 * Returns:
 * @returns {SpinnerState} — A spinner state object configured for thinking mode.
 *
 * Dependencies:
 *   - None (simple object creation).
 *
 * Dependants:
 *   - spinnerForStatusFrame — uses this to create advisor and agent thinking spinners.
 * </Summary>
 */
const thinkingSpinner = (label: string): SpinnerState => ({
  active: true,
  label,
  mode: "thinking",
});

/**
 * <Summary>
 * What it does:
 *   Maps a status frame to the appropriate bottom-line spinner state.
 *
 * How it does it (step by step):
 *   1. Check if the frame is a status frame (return undefined if not).
 *   2. Check if the source is the advisor.
 *   3. If advisor is in a thinking stage with the right icon, show "Advisor" thinking spinner.
 *   4. If advisor is ready, clear the spinner (return null).
 *   5. If advisor is in other stages, leave spinner unchanged (return undefined).
 *   6. Check if agent activity is in thinking stage, show "Agent" thinking spinner.
 *   7. Check if agent stage is thinking, show "Agent" thinking spinner.
 *   8. Check if agent has activity, leave spinner unchanged (return undefined).
 *   9. Otherwise, clear the spinner (return null).
 *
 * Parameters:
 * @param {TaskFrame} frame — The task frame to evaluate for spinner state.
 *
 * Returns:
 * @returns {SpinnerState | null | undefined} — The spinner state (show spinner), null (clear spinner), or undefined (no change).
 *
 * Dependencies:
 *   - ADVISOR_THINKING_STAGES — provides the set of advisor thinking stages.
 *   - thinkingSpinner — creates spinner states for thinking operations.
 *
 * Dependants:
 *   - Status display components — use this to determine spinner behavior.
 * </Summary>
 */
/**
 * Maps a status frame to bottom-line spinner state.
 * - SpinnerState: show braille thinking indicator
 * - null: clear spinner
 * - undefined: leave current spinner unchanged
 */
export const spinnerForStatusFrame = (
  frame: TaskFrame,
): SpinnerState | null | undefined => {
  // ===== STEP 1: Validate frame type =====
  // Step 1a: Check if the frame is a status frame
  // Step 1b: If not a status frame, return undefined to leave spinner unchanged
  if (frame.kind !== "status") {
    return undefined;
  }

  // ===== STEP 2: Handle advisor source =====
  // Step 2a: Check if the frame source is the advisor
  if (frame.source === "advisor") {
    // ===== STEP 2a-1: Check for thinking stages =====
    // Step 2a-1a: Check if the advisor is in a thinking stage
    // Step 2a-1b: Check if the advisor has the "◌" icon (thinking indicator)
    if (
      ADVISOR_THINKING_STAGES.has(frame.stage as AdvisorStage) &&
      frame.icon === "◌"
    ) {
      // Step 2a-1c: Return a thinking spinner labeled "Advisor"
      return thinkingSpinner("Advisor");
    }

    // ===== STEP 2a-2: Check for ready stage =====
    // Step 2a-2a: Check if the advisor is in the ready stage
    if (frame.stage === "ready") {
      // Step 2a-2b: Return null to clear the spinner (advisor is done thinking)
      return null;
    }

    // ===== STEP 2a-3: Other advisor stages =====
    // Step 2a-3a: For other advisor stages, return undefined to leave spinner unchanged
    return undefined;
  }

  // ===== STEP 3: Handle agent activity thinking =====
  // Step 3a: Check if the agent activity is in thinking stage
  if (frame.activity?.stage === "thinking") {
    // Step 3b: Return a thinking spinner labeled "Agent"
    return thinkingSpinner("Agent");
  }

  // ===== STEP 4: Handle agent stage thinking =====
  // Step 4a: Check if the agent stage is thinking
  if (frame.stage === "thinking") {
    // Step 4b: Return a thinking spinner labeled "Agent"
    return thinkingSpinner("Agent");
  }

  // ===== STEP 5: Handle agent with activity =====
  // Step 5a: Check if the agent has any activity
  if (frame.activity) {
    // Step 5b: Return undefined to leave spinner unchanged (agent is doing something)
    return undefined;
  }

  // ===== STEP 6: Default: clear spinner =====
  // Step 6a: Return null to clear the spinner (agent is idle or done)
  return null;
}
