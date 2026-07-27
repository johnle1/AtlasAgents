import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { inTmux, isScreenReaderLikely } from "../terminalEnv.js";
import { loadConfig } from "../../config/index.js";
import type { StatusSpinnerProps as Props } from "./types.js";

/** Dot animation patterns for tmux compatibility (tmux doesn't support ink-spinner). */
const TMUX_DOTS = [".  ", ".. ", "..."];

/** Animation interval in milliseconds for tmux dot animation. */
const TMUX_ANIMATION_MS = 750;

/**
 * Renders an animated status indicator adapted to standard, multiplexed (tmux), or screen-reader terminal environments.
 *
 * @remarks
 * Standard spinner components (from `ink-spinner`) can break rendering blocks in terminal multiplexers like tmux
 * or introduce high amounts of noise to accessibility software. This component evaluates the environment
 * capabilities using client utilities (`inTmux`, `isScreenReaderLikely`) and resolves appropriate fallbacks:
 * - tmux: falls back to simple ASCII character animation `.  ` -> `.. ` -> `...`
 * - Screen Reader: emits a static text block describing the action (avoiding refresh loops)
 * - Standard terminal: mounts the interactive dots spinner animation.
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { StatusSpinner } from "./Spinner.js";
 * 
 * const activeState = { active: true, mode: "thinking" as const, label: "Agent" };
 * render(<StatusSpinner state={activeState} />);
 * ```
 */
export const StatusSpinner: React.FC<Props> = ({ state }) => {
  // Query theme configuration to check if loading animations have been explicitly hidden.
  const showSpinner = loadConfig().ui.showSpinner !== false;

  // Local state to track tmux animation frames (ignored in other terminal environments).
  const [dotIndex, setDotIndex] = useState(0);

  /**
   * Registers a fallback animation loop when the client is running under tmux.
   *
   * @remarks
   * Cycles index positions to animate `TMUX_DOTS` at `TMUX_ANIMATION_MS` intervals.
   * This is disabled for standard terminals and screen-reader streams to preserve resources.
   */
  useEffect(() => {
    if (!state?.active || !inTmux() || isScreenReaderLikely()) return;

    const timerId = setInterval(() => {
      setDotIndex((previousIndex) => (previousIndex + 1) % TMUX_DOTS.length);
    }, TMUX_ANIMATION_MS);

    return () => clearInterval(timerId);
  }, [state?.active]);

  // Prevent rendering if spinner features have been disabled or no task is executing.
  if (!showSpinner || !state?.active) return null;

  // Switch display verb text depending on whether the system is analyzing (thinking) or executing (working).
  const verb = state.mode === "thinking" ? "thinking" : "working";

  // Screen Reader: returns a flat, static text description to prevent constant screen reader announcements.
  if (isScreenReaderLikely()) {
    return (
      <Text>
        {state.label} {verb}
      </Text>
    );
  }

  // tmux: renders the custom ASCII dot character sequence instead of the raw ansi-spin sequences.
  if (inTmux()) {
    return (
      <Box>
        <Text color="cyan">{TMUX_DOTS[dotIndex]}</Text>
        <Text dimColor>
          {" "}
          {state.label} {verb}…
        </Text>
      </Box>
    );
  }

  // Standard Terminal: mounts the standard animated Ink SVG dots spinner.
  return (
    <Box>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text dimColor>
        {" "}
        {state.label} {verb}…
      </Text>
    </Box>
  );
};
