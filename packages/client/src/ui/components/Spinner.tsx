import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { SpinnerState } from "../types.js";
import { inTmux, isScreenReaderLikely } from "../terminalEnv.js";
import { loadConfig } from "../../config.js";

/** Dot animation patterns for tmux compatibility (tmux doesn't support ink-spinner). */
const TMUX_DOTS = [".  ", ".. ", "..."];

/** Animation interval in milliseconds for tmux dot animation. */
const TMUX_ANIMATION_MS = 750;

/**
 * <Summary>
 * What it does:
 *   Defines the props interface for the StatusSpinner component.
 *
 * Used by:
 *   - StatusSpinner — receives spinner state through these props.
 *
 * Produced by:
 *   - Parent UI components — pass SpinnerState objects as props.
 * </Summary>
 */
type Props = {
  /** Current spinner state containing mode, label, and active status. */
  state: SpinnerState | null;
};

/**
 * <Summary>
 * What it does:
 *   Renders an animated status spinner with adaptive behavior for different
 *   terminal environments (tmux, screen readers, standard terminals).
 *
 * How it fits in the system:
 *   Provides visual feedback during long-running operations (thinking, working).
 *   Adapts to terminal capabilities: uses dots for tmux, simple text for
 *   screen readers, and animated spinner for standard terminals.
 *
 * Dependencies:
 *   - React/ink — for terminal UI rendering.
 *   - ink-spinner — provides standard spinner animation.
 *   - loadConfig — checks if spinner display is enabled.
 *   - inTmux — detects if running in tmux environment.
 *   - isScreenReaderLikely — detects if screen reader is likely in use.
 *
 * Dependants:
 *   - Main UI components — render StatusSpinner during active operations.
 * </Summary>
 */
export const StatusSpinner: React.FC<Props> = ({ state }) => {
  // ===== CONFIGURATION CHECK =====
  // Check if spinner display is enabled in user configuration
  const showSpinner = loadConfig().ui.showSpinner !== false;

  // ===== STATE MANAGEMENT =====
  // Track current dot animation index for tmux compatibility
  const [dotIndex, setDotIndex] = useState(0);

  /**
   * <Summary>
   * What it does:
   *   Manages tmux-specific dot animation when running in tmux environment.
   *
   * How it does it (step by step):
   *   1. Check if spinner is active, running in tmux, and not for screen reader.
   *   2. If conditions not met, return early (no animation needed).
   *   3. Set up interval timer that cycles through dot patterns.
   *   4. Update dot index using modulo to cycle through TMUX_DOTS array.
   *   5. Return cleanup function to clear interval on unmount or state change.
   *
   * Parameters:
   *   None — uses closure variable (state?.active).
   *
   * Returns:
   *   void — called for side effects (timer management and state updates).
   *
   * Dependencies:
   *   - inTmux — detects tmux environment.
   *   - isScreenReaderLikely — detects screen reader usage.
   *
   * Dependants:
   *   None (React useEffect hook, called by React on render).
   * </Summary>
   */
  useEffect(() => {
    // Only animate in tmux when spinner is active and screen reader not detected
    if (!state?.active || !inTmux() || isScreenReaderLikely()) return;

    // Set up interval to cycle through dot animation patterns
    const timerId = setInterval(() => {
      setDotIndex((previousIndex) => (previousIndex + 1) % TMUX_DOTS.length);
    }, TMUX_ANIMATION_MS);

    // Clean up interval when component unmounts or dependencies change
    return () => clearInterval(timerId);
  }, [state?.active]);

  // Don't render if spinner is disabled or not active
  if (!showSpinner || !state?.active) return null;

  // Determine verb based on spinner mode
  const verb = state.mode === "thinking" ? "thinking" : "working";

  // ===== SCREEN READER MODE =====
  // Simple text output without animation for screen reader compatibility
  if (isScreenReaderLikely()) {
    return (
      <Text>
        {state.label} {verb}
      </Text>
    );
  }

  // ===== TMUX MODE =====
  // Use dot animation instead of ink-spinner (tmux doesn't support complex animations)
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

  // ===== STANDARD TERMINAL MODE =====
  // Use full ink-spinner animation with standard terminal support
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
