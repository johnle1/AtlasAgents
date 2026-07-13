/**
 * Visual resolvers and constants for status rendering.
 *
 * @remarks
 * Maps raw backend stages (running, done, waiting, escalated, etc.) to visual properties
 * like color, glyph icons, and animation options for rendering inside the CLI environment.
 */

import type {
  AgentStage,
  AdvisorStage,
  StatusIcon,
  TaskLifecycleState,
} from "../frames.js";
import { loadConfig } from "../config.js";
import { inTmux, isScreenReaderLikely } from "./terminalEnv.js";

/** Circle pulse character sequence for standard terminals. */
export const WORKING_FRAMES = ["◉", "◎", "○", "◎"] as const;

/** Simpler 2-character pulse sequence safer for tmux buffers. */
export const TMUX_WORKING_FRAMES = ["◉", "◎"] as const;

/** Standard terminal frame delay in milliseconds. */
export const FRAME_MS = 400;

/** tmux terminal frame delay in milliseconds. */
export const TMUX_FRAME_MS = 750;

/** Styling properties for rendering icons. */
export type StatusVisual = {
  /** The icon character to render. */
  glyph: string;
  /** Text color associated with the status indicator. */
  color?: string;
  /** Dim the rendered text/glyph. */
  dim?: boolean;
  /** Trigger animation cycling for the indicator. */
  animate?: boolean;
};

/**
 * Checks if a given advisor/agent stage is actively working.
 *
 * @param stage - The stage to check.
 * @returns True if the stage represents active execution, false otherwise.
 */
export const isWorkingStage = (stage?: AgentStage | AdvisorStage): boolean =>
  stage === "running" ||
  stage === "reading" ||
  stage === "writing" ||
  stage === "searching" ||
  stage === "thinking";

/**
 * Verifies if animations should be executed on status indicators.
 *
 * @remarks
 * True if spinners are enabled in configuration and terminal environment does not resemble
 * non-interactive/dumb/CI runners or screen readers.
 *
 * @returns True if animations should run, false otherwise.
 */
export const shouldAnimateWorker = (): boolean => {
  return loadConfig().ui.showSpinner !== false && !isScreenReaderLikely();
};

/**
 * Alias wrapper for shouldAnimateWorker to align with execution plan names.
 */
export const shouldAnimate = shouldAnimateWorker;

/**
 * Gets the animation tick rate based on the terminal type.
 *
 * @returns Delay duration in milliseconds.
 */
export const getWorkingFrameMs = (): number => {
  return inTmux() ? TMUX_FRAME_MS : FRAME_MS;
};

/**
 * Gets the animation character frames based on the terminal type.
 *
 * @returns An array of frame characters.
 */
export const getWorkingFrames = (): readonly string[] => {
  return inTmux() ? TMUX_WORKING_FRAMES : WORKING_FRAMES;
};

/**
 * Resolves the character frame to render at a specific timestamp offset.
 *
 * @param pulseIndex - The tick pulse index.
 * @returns The frame character.
 */
export const getWorkingFrame = (pulseIndex: number): string => {
  const frames = getWorkingFrames();
  return frames[pulseIndex % frames.length]!;
};

/**
 * Resolves the status rendering details for an agent/advisor stage.
 *
 * @param stage - Current active stage name.
 * @param frameIcon - Default icon.
 * @param pulseIndex - Animation index.
 * @param isAdvisor - True if this represents the Advisor.
 * @returns Status visual characteristics.
 */
export const resolveWorkerVisual = (
  stage: AgentStage | AdvisorStage | undefined,
  frameIcon: StatusIcon,
  pulseIndex: number,
  isAdvisor: boolean,
): StatusVisual => {
  if (isAdvisor) {
    return {
      glyph: frameIcon,
      color:
        frameIcon === "✓" ? "green" : frameIcon === "⚠" ? "yellow" : undefined,
    };
  }

  if (stage === "waiting") {
    return { glyph: "◦", dim: true };
  }

  if (stage === "done") {
    return { glyph: "✓", color: "green" };
  }

  if (stage === "escalating" || frameIcon === "⚠") {
    return { glyph: "⚠", color: "yellow" };
  }

  if (isWorkingStage(stage)) {
    const shouldAnimateCurrent = shouldAnimateWorker();

    return {
      glyph: shouldAnimateCurrent ? getWorkingFrame(pulseIndex) : "◉",
      color: "cyan",
      animate: shouldAnimateCurrent,
    };
  }

  return { glyph: frameIcon, dim: true };
};

/**
 * Resolves visual representation characteristics for queue states.
 *
 * @param blocked - True if queue is currently blocked.
 * @returns Queue status visual properties.
 */
export const resolveQueueVisual = (blocked: boolean): StatusVisual =>
  blocked ? { glyph: "□", dim: true } : { glyph: "○", color: "cyan" };

/**
 * Resolves task execution status rendering parameters.
 *
 * @param state - The lifecycle state.
 * @param pulseIndex - The animation index.
 * @returns State visual properties.
 */
export const resolveTaskLifecycleVisual = (
  state: TaskLifecycleState,
  pulseIndex: number,
): StatusVisual => {
  switch (state) {
    case "complete":
      return { glyph: "✓", color: "green" };

    case "running": {
      const shouldAnimateCurrent = shouldAnimateWorker();

      return {
        glyph: shouldAnimateCurrent ? getWorkingFrame(pulseIndex) : "◉",
        color: "cyan",
        animate: shouldAnimateCurrent,
      };
    }

    case "waiting":
      return { glyph: "○", color: "cyan" };

    case "blocked":
      return { glyph: "□", dim: true };

    case "failed":
      return { glyph: "✗", color: "red" };
  }
};

