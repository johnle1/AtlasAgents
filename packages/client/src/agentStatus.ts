/**
 * Task status — Ink spinner when active, no-op otherwise.
 *
 * This module manages the visual state of an agent's activity through UI spinners.
 * It coordinates between task execution state and the UI spinner (Ink) to provide
 * visual feedback about what the agent is currently doing (thinking, working, etc.).
 *
 * Key concepts:
 * - Task Activity: Tracks whether an agent is currently executing a task
 * - Spinner State: Controls the visual spinner shown to the user
 * - Mode: Different spinner animations for different agent states (thinking vs working)
 */

// Import UI bridge functions to interface with the Ink spinner system
// isInkActive: Checks if the Ink spinner system is currently available/active
// setSpinner: Updates the spinner state with new configuration
import { isInkActive, setSpinner } from "./ui/uiBridge.js";
// Import the SpinnerState type to ensure type safety when setting spinner configurations
import type { SpinnerState } from "./ui/types.js";

// Internal state variable to track whether a task is currently active
// This acts as a global flag that determines if spinner operations should proceed
let taskActive = false;

/**
 * <Summary>
 * What it does:
 *   Returns whether a task is currently active.
 *
 * How it does it (step by step):
 *   1. Reads the global taskActive flag.
 *   2. Returns the boolean value directly.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns true if a task is active, false otherwise.
 * </Summary>
 */
export const isTaskActive = (): boolean => taskActive;

/**
 * <Summary>
 * What it does:
 *   Sets whether a task is currently active.
 *
 * How it does it (step by step):
 *   1. Updates the global taskActive flag with the provided boolean value.
 *   2. This change affects all subsequent spinner operations.
 *
 * Parameters:
 *   @param active - true to mark task as active, false to mark as inactive.
 *
 * Returns:
 *   @returns called for side effects only.
 * </Summary>
 */
export const setTaskActive = (active: boolean): void => {
  taskActive = active;
};

/**
 * <Summary>
 * What it does:
 *   Stops any currently active animated spinner.
 *
 * How it does it (step by step):
 *   1. Checks if the Ink spinner system is currently active.
 *   2. If active, clears the spinner by passing null to setSpinner.
 *   3. This removes the spinner from the UI.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns called for side effects only.
 * </Summary>
 */
export const stopAnimated = (): void => {
  if (isInkActive()) {
    setSpinner(null);
  }
};

/**
 * <Summary>
 * What it does:
 *   Starts an animated spinner with a specific mode and label.
 *
 * How it does it (step by step):
 *   1. Checks if a task is currently active using the taskActive flag.
 *   2. If no task is active, returns without updating the spinner.
 *   3. If task is active, checks if the Ink spinner system is available.
 *   4. If Ink is active, updates the spinner with the new configuration.
 *
 * Parameters:
 *   @param mode - The spinner animation mode ("thinking" or "working").
 *   @param label - The text label to display next to the spinner.
 *
 * Returns:
 *   @returns called for side effects only.
 * </Summary>
 */
const startAnimated = (mode: SpinnerState["mode"], label: string): void => {
  if (!taskActive) return;
  if (isInkActive()) {
    setSpinner({ active: true, label, mode });
  }
};

/**
 * <Summary>
 * What it does:
 *   Starts a "thinking" spinner to indicate the agent is processing.
 *
 * How it does it (step by step):
 *   1. Calls the internal startAnimated function with mode="thinking".
 *   2. Passes the provided label or "Advisor" if none provided.
 *   3. Spinner only appears if taskActive is true and Ink is available.
 *
 * Parameters:
 *   @param nextLabel - The text label to display (defaults to "Advisor").
 *
 * Returns:
 *   @returns called for side effects only.
 * </Summary>
 */
export const startThinking = (nextLabel = "Advisor"): void => {
  startAnimated("thinking", nextLabel);
};

/**
 * <Summary>
 * What it does:
 *   Starts a "working" spinner to indicate the agent is executing actions.
 *
 * How it does it (step by step):
 *   1. Calls the internal startAnimated function with mode="working".
 *   2. Passes the provided label or "Agent" if none provided.
 *   3. Spinner only appears if taskActive is true and Ink is available.
 *
 * Parameters:
 *   @param nextLabel - The text label to display (defaults to "Agent").
 *
 * Returns:
 *   @returns called for side effects only.
 * </Summary>
 */
export const startWorking = (nextLabel = "Agent"): void => {
  startAnimated("working", nextLabel);
};

/**
 * <Summary>
 * What it does:
 *   Prepares the terminal for block output by stopping any active spinner.
 *
 * How it does it (step by step):
 *   1. Stops any animated spinner using stopAnimated.
 *   2. Checks if Ink is NOT currently active.
 *   3. If Ink is not available, writes a newline to stdout for formatting.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns called for side effects only.
 * </Summary>
 */
export const beginBlockOutput = (): void => {
  stopAnimated();
  if (!isInkActive()) {
    process.stdout.write("\n");
  }
};
