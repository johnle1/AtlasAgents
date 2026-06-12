import type {
  AgentStage,
  AdvisorStage,
  StatusIcon,
  TaskLifecycleState,
} from "../frames.js";
import { loadConfig } from "../config.js";
import { inTmux, isScreenReaderLikely } from "./terminalEnv.js";

/**
 * <Summary>
 * What it does:
 *   The animation frames for the working state circle pulse in normal terminals.
 *
 * Used by:
 *   - getWorkingFrames — returns these frames when not in tmux.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
/** Circle pulse for normal terminals. */
export const WORKING_FRAMES = ["◉", "◎", "○", "◎"] as const;

/**
 * <Summary>
 * What it does:
 *   The simplified animation frames for the working state in tmux environments.
 *
 * Used by:
 *   - getWorkingFrames — returns these frames when in tmux.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
/** Simpler 2-frame pulse — safer in tmux (matches StatusSpinner tmux branch). */
export const TMUX_WORKING_FRAMES = ["◉", "◎"] as const;

/**
 * <Summary>
 * What it does:
 *   The animation frame interval in milliseconds for normal terminals.
 *
 * Used by:
 *   - getWorkingFrameMs — returns this value when not in tmux.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
export const FRAME_MS = 400;

/**
 * <Summary>
 * What it does:
 *   The animation frame interval in milliseconds for tmux environments.
 *
 * Used by:
 *   - getWorkingFrameMs — returns this value when in tmux.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
export const TMUX_FRAME_MS = 750;

/**
 * <Summary>
 * What it does:
 *   Defines the visual properties for status indicators.
 *
 * Used by:
 *   - All visual resolution functions — return objects of this shape.
 *   - Status display components — use this to render status indicators.
 *
 * Produced by:
 *   - resolveWorkerVisual — creates worker status visuals.
 *   - resolveQueueVisual — creates queue status visuals.
 *   - resolveTaskLifecycleVisual — creates task lifecycle visuals.
 * </Summary>
 */
export type StatusVisual = {
  /** The glyph/icon to display for the status indicator. */
  glyph: string;

  /** The color name for the status indicator (optional). */
  color?: string;

  /** Whether the indicator should be dimmed (optional). */
  dim?: boolean;

  /** Whether the indicator should be animated (optional). */
  animate?: boolean;
};

/**
 * <Summary>
 * What it does:
 *   Determines whether a stage represents working/active state.
 *
 * How it does it (step by step):
 *   1. Check if the stage is "running" (executing tasks).
 *   2. Check if the stage is "reading" (reading files).
 *   3. Check if the stage is "writing" (writing files).
 *   4. Check if the stage is "thinking" (processing/reasoning).
 *   5. Return true if any condition matches, false otherwise.
 *
 * Parameters:
 * @param {AgentStage | AdvisorStage | undefined} stage — The stage to evaluate.
 *
 * Returns:
 * @returns {boolean} — True if the stage represents working state, false otherwise.
 *
 * Dependencies:
 *   - None (simple boolean logic).
 *
 * Dependants:
 *   - resolveWorkerVisual — uses this to determine when to animate the worker indicator.
 * </Summary>
 */
export const isWorkingStage = (stage?: AgentStage | AdvisorStage): boolean =>
  stage === "running" ||
  stage === "reading" ||
  stage === "writing" ||
  stage === "thinking";

/**
 * <Summary>
 * What it does:
 *   Determines whether the worker circle-pulse animation should run.
 *
 * How it does it (step by step):
 *   1. Load the current configuration.
 *   2. Check if showSpinner is not disabled in the config.
 *   3. Check if a screen reader is not likely being used.
 *   4. Return true if animation should run, false otherwise.
 *
 * Returns:
 * @returns {boolean} — True if worker animation should run, false otherwise.
 *
 * Dependencies:
 *   - loadConfig — provides the configuration for spinner settings.
 *   - isScreenReaderLikely — detects screen reader usage for accessibility.
 *
 * Dependants:
 *   - resolveWorkerVisual — uses this to determine animation state.
 *   - resolveTaskLifecycleVisual — uses this to determine animation state.
 * </Summary>
 */
/** True when worker circle-pulse should run (showSpinner on, not CI/dumb). */
export function shouldAnimateWorker(): boolean {
  return loadConfig().ui.showSpinner !== false && !isScreenReaderLikely();
}

/**
 * <Summary>
 * What it does:
 *   Alias for shouldAnimateWorker for plan naming consistency.
 *
 * How it does it (step by step):
 *   1. Call shouldAnimateWorker to check animation eligibility.
 *   2. Return the result directly.
 *
 * Returns:
 * @returns {boolean} — True if animation should run, false otherwise.
 *
 * Dependencies:
 *   - shouldAnimateWorker — provides the animation eligibility check.
 *
 * Dependants:
 *   - Plan visualization functions — use this alias for consistent naming.
 * </Summary>
 */
/** Alias for plan naming. */
export const shouldAnimate = shouldAnimateWorker;

/**
 * <Summary>
 * What it does:
 *   Returns the appropriate frame interval based on the terminal environment.
 *
 * How it does it (step by step):
 *   1. Check if the current terminal is tmux.
 *   2. If tmux, return the longer frame interval for tmux compatibility.
 *   3. If not tmux, return the standard frame interval for normal terminals.
 *
 * Returns:
 * @returns {number} — The frame interval in milliseconds for the current environment.
 *
 * Dependencies:
 *   - inTmux — detects tmux environment.
 *
 * Dependants:
 *   - Animation loop components — use this to set frame timing.
 * </Summary>
 */
export function getWorkingFrameMs(): number {
  return inTmux() ? TMUX_FRAME_MS : FRAME_MS;
}

/**
 * <Summary>
 * What it does:
 *   Returns the appropriate animation frames based on the terminal environment.
 *
 * How it does it (step by step):
 *   1. Check if the current terminal is tmux.
 *   2. If tmux, return the simplified 2-frame pulse for tmux compatibility.
 *   3. If not tmux, return the full 4-frame pulse for normal terminals.
 *
 * Returns:
 * @returns {readonly string[]} — The array of animation frames for the current environment.
 *
 * Dependencies:
 *   - inTmux — detects tmux environment.
 *
 * Dependants:
 *   - getWorkingFrame — uses this to get the frame array.
 * </Summary>
 */
export function getWorkingFrames(): readonly string[] {
  return inTmux() ? TMUX_WORKING_FRAMES : WORKING_FRAMES;
}

/**
 * <Summary>
 * What it does:
 *   Returns the current animation frame based on the pulse index.
 *
 * How it does it (step by step):
 *   1. Get the appropriate animation frames for the current environment.
 *   2. Calculate the frame index using modulo to cycle through frames.
 *   3. Return the frame at the calculated index.
 *
 * Parameters:
 * @param {number} pulseIndex — The current pulse index for animation timing.
 *
 * Returns:
 * @returns {string} — The current animation frame glyph.
 *
 * Dependencies:
 *   - getWorkingFrames — provides the frame array for the current environment.
 *
 * Dependants:
 *   - resolveWorkerVisual — uses this to get the current frame for animation.
 *   - resolveTaskLifecycleVisual — uses this to get the current frame for animation.
 * </Summary>
 */
export function getWorkingFrame(pulseIndex: number): string {
  const frames = getWorkingFrames();
  return frames[pulseIndex % frames.length]!;
}

/**
 * <Summary>
 * What it does:
 *   Resolves the visual properties for a worker status indicator.
 *
 * How it does it (step by step):
 *   1. Check if the status is for an advisor.
 *   2. If advisor, apply color based on success (green) or warning (yellow) icons.
 *   3. Check if the stage is waiting, return dimmed waiting indicator.
 *   4. Check if the stage is done, return green success indicator.
 *   5. Check if stage is escalating or icon is warning, return yellow warning indicator.
 *   6. Check if stage is working, determine animation and return cyan working indicator.
 *   7. Otherwise, return dimmed default indicator.
 *
 * Parameters:
 * @param {AgentStage | AdvisorStage | undefined} stage — The current stage of the worker.
 * @param {StatusIcon} frameIcon — The status icon to display.
 * @param {number} pulseIndex — The current pulse index for animation timing.
 * @param {boolean} isAdvisor — Whether this is an advisor status.
 *
 * Returns:
 * @returns {StatusVisual} — The visual properties for the worker status indicator.
 *
 * Dependencies:
 *   - isWorkingStage — determines if the stage represents working state.
 *   - shouldAnimateWorker — determines if animation should run.
 *   - getWorkingFrame — provides the current animation frame.
 *
 * Dependants:
 *   - Worker status display components — use this to render worker indicators.
 * </Summary>
 */
export const resolveWorkerVisual = (
  stage: AgentStage | AdvisorStage | undefined,
  frameIcon: StatusIcon,
  pulseIndex: number,
  isAdvisor: boolean,
): StatusVisual => {
  // ===== STEP 1: Handle advisor status =====
  // Step 1a: Check if this is an advisor status
  if (isAdvisor) {
    // Step 1b: Return visual with appropriate color based on icon
    return {
      glyph: frameIcon,
      color:
        frameIcon === "✓" ? "green" : frameIcon === "⚠" ? "yellow" : undefined,
    };
  }

  // ===== STEP 2: Handle waiting stage =====
  // Step 2a: Check if the stage is waiting (idle, awaiting input)
  if (stage === "waiting") {
    // Step 2b: Return dimmed waiting indicator
    return { glyph: "◦", dim: true };
  }

  // ===== STEP 3: Handle done stage =====
  // Step 3a: Check if the stage is done (completed successfully)
  if (stage === "done") {
    // Step 3b: Return green success indicator
    return { glyph: "✓", color: "green" };
  }

  // ===== STEP 4: Handle escalating stage =====
  // Step 4a: Check if the stage is escalating or the icon is a warning
  if (stage === "escalating" || frameIcon === "⚠") {
    // Step 4b: Return yellow warning indicator
    return { glyph: "⚠", color: "yellow" };
  }

  // ===== STEP 5: Handle working stage =====
  // Step 5a: Check if the stage is working (running, reading, writing, thinking)
  if (isWorkingStage(stage)) {
    // Step 5b: Determine if animation should run
    const shouldAnimateCurrent = shouldAnimateWorker();

    // Step 5c: Return animated or static working indicator
    return {
      glyph: shouldAnimateCurrent ? getWorkingFrame(pulseIndex) : "◉",
      color: "cyan",
      animate: shouldAnimateCurrent,
    };
  }

  // ===== STEP 6: Default case =====
  // Step 6a: Return dimmed default indicator for other stages
  return { glyph: frameIcon, dim: true };
};

/**
 * <Summary>
 * What it does:
 *   Resolves the visual properties for a queue status indicator.
 *
 * How it does it (step by step):
 *   1. Check if the queue is blocked.
 *   2. If blocked, return dimmed blocked indicator (□).
 *   3. If not blocked, return cyan available indicator (○).
 *
 * Parameters:
 * @param {boolean} blocked — Whether the queue is blocked and unable to process tasks.
 *
 * Returns:
 * @returns {StatusVisual} — The visual properties for the queue status indicator.
 *
 * Dependencies:
 *   - None (simple conditional logic).
 *
 * Dependants:
 *   - Queue status display components — use this to render queue indicators.
 * </Summary>
 */
export const resolveQueueVisual = (blocked: boolean): StatusVisual =>
  blocked ? { glyph: "□", dim: true } : { glyph: "○", color: "cyan" };

/**
 * <Summary>
 * What it does:
 *   Resolves the visual properties for a task lifecycle state indicator.
 *
 * How it does it (step by step):
 *   1. Switch on the task lifecycle state.
 *   2. If complete, return green success indicator (✓).
 *   3. If running, determine animation and return cyan running indicator with animation.
 *   4. If waiting, return cyan waiting indicator (○).
 *   5. If blocked, return dimmed blocked indicator (□).
 *
 * Parameters:
 * @param {TaskLifecycleState} state — The current state of the task lifecycle.
 * @param {number} pulseIndex — The current pulse index for animation timing.
 *
 * Returns:
 * @returns {StatusVisual} — The visual properties for the task lifecycle indicator.
 *
 * Dependencies:
 *   - shouldAnimateWorker — determines if animation should run.
 *   - getWorkingFrame — provides the current animation frame.
 *
 * Dependants:
 *   - Task lifecycle display components — use this to render task indicators.
 * </Summary>
 */
export const resolveTaskLifecycleVisual = (
  state: TaskLifecycleState,
  pulseIndex: number,
): StatusVisual => {
  // ===== STEP 1: Resolve visual based on state =====
  switch (state) {
    // ===== STEP 1a: Complete state =====
    // Step 1a-1: Return green success indicator for completed tasks
    case "complete":
      return { glyph: "✓", color: "green" };

    // ===== STEP 1b: Running state =====
    // Step 1b-1: Determine if animation should run
    case "running": {
      const shouldAnimateCurrent = shouldAnimateWorker();

      // Step 1b-2: Return animated or static running indicator
      return {
        glyph: shouldAnimateCurrent ? getWorkingFrame(pulseIndex) : "◉",
        color: "cyan",
        animate: shouldAnimateCurrent,
      };
    }

    // ===== STEP 1c: Waiting state =====
    // Step 1c-1: Return cyan waiting indicator for queued tasks
    case "waiting":
      return { glyph: "○", color: "cyan" };

    // ===== STEP 1d: Blocked state =====
    // Step 1d-1: Return dimmed blocked indicator for blocked tasks
    case "blocked":
      return { glyph: "□", dim: true };
  }
};
