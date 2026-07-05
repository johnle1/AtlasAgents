import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { AgentStage, AdvisorStage, StatusIcon } from "../../frames.js";
import {
  getWorkingFrameMs,
  isWorkingStage,
  resolveWorkerVisual,
} from "../statusVisual.js";

/**
 * <Summary>
 * What it does:
 *   Defines the data structure for an individual agent or advisor status entry
 *   that will be displayed in the status board.
 *
 * Used by:
 *   - AgentStatusBox — receives this data as props to render status display.
 *   - AgentTaskBoard — creates arrays of these entries to track multiple agents.
 *
 * Produced by:
 *   - AgentTaskBoard — constructs status entries from agent state updates.
 * </Summary>
 */
export type AgentStatusEntry = {
  /** Unique identifier (number for agents, "advisor" for advisor). */
  id: number | "advisor";

  /** Human-readable label describing the agent's current task or role. */
  label: string;

  /** Icon indicating the current status (e.g., spinner, checkmark, error). */
  icon: StatusIcon;

  /** Detailed message describing what the agent is currently doing. */
  message: string;

  /** Current stage in the agent/advisor lifecycle (optional). */
  stage?: AgentStage | AdvisorStage;
};

/**
 * <Summary>
 * What it does:
 *   Props interface for AgentStatusBox component, identical to AgentStatusEntry.
 *
 * Used by:
 *   - AgentStatusBox — receives status data through these props.
 *
 * Produced by:
 *   - AgentTaskBoard — passes AgentStatusEntry objects as props.
 * </Summary>
 */
type Props = AgentStatusEntry;

/**
 * <Summary>
 * What it does:
 *   Renders a bordered status box for a single agent or advisor with animated
 *   visual indicators and formatted message display.
 *
 * How it fits in the system:
 *   Sits within the AgentTaskBoard to display individual agent status.
 *   Each box shows the agent's icon, current message, and handles animation
 *   for working states. The visual representation updates based on stage and
 *   animation state.
 * </Summary>
 */
export const AgentStatusBox: React.FC<Props> = ({
  id,
  label,
  icon,
  message,
  stage,
}) => {
  // ===== STATE MANAGEMENT =====
  // Track animation frame index for pulsing/rotating visual effects
  const [pulseIndex, setPulseIndex] = useState(0);

  // ===== DERIVED VALUES =====
  // Check if this status box represents the advisor (vs. a regular agent)
  const isAdvisor = id === "advisor";

  // Resolve the visual representation (glyph, color, animation state) based on current stage
  const visual = resolveWorkerVisual(stage, icon, pulseIndex, isAdvisor);

  /**
   * <Summary>
   * What it does:
   *   Manages animation loop for working states by incrementing pulse index
   *   on a timer when the agent is actively working.
   *
   * How it does it (step by step):
   *   1. Check if visual should animate and agent is in working stage.
   *   2. If not animating, return early (cleanup function not needed).
   *   3. Set up interval timer that increments pulse index each frame.
   *   4. Use getWorkingFrameMs to determine animation timing.
   *   5. Return cleanup function to clear interval on unmount or state change.
   *
   * Parameters:
   *   None — uses closure variables (visual.animate, stage).
   *
   * Returns:
   *   void — called for side effects (timer management and state updates).
   *
   *   None (React useEffect hook, called by React on render).
   * </Summary>
   */
  useEffect(() => {
    // ===== STEP 1: Check if Animation is Needed =====
    // Only animate if visual indicates animation is required AND agent is in working stage
    if (!visual.animate || !isWorkingStage(stage)) {
      return;
    }

    // ===== STEP 2: Set Up Animation Timer =====
    // Create interval that increments pulse index for each animation frame
    const timer = setInterval(() => {
      // Increment pulse index to advance animation frame
      setPulseIndex((previousPulseIndex) => previousPulseIndex + 1);
    }, getWorkingFrameMs());

    // ===== STEP 3: Cleanup Function =====
    // Clear interval when component unmounts or dependencies change
    return () => clearInterval(timer);
  }, [visual.animate, stage]);

  // ===== TITLE FORMATTING =====
  // Construct display title based on whether this is advisor or agent
  const title = isAdvisor
    ? "Advisor"
    : label.length > 0
      ? `Agent ${id} — ${label}`
      : `Agent ${id}`;

  // Border box formatting constants
  const borderWidth = 48;
  const titlePadding = Math.max(0, borderWidth - title.length - 4);

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={0}>
      {/* ===== TOP BORDER ROW ===== */}
      <Box>
        <Text dimColor>┌─ </Text>
        <Text dimColor>{title} </Text>
        <Text dimColor>{"─".repeat(titlePadding)}┐</Text>
      </Box>

      {/* ===== CONTENT ROW WITH ICON AND MESSAGE ===== */}
      <Box>
        <Text dimColor>│ </Text>
        <Text color={visual.color} dimColor={visual.dim}>
          {visual.glyph}{" "}
        </Text>
        <Text dimColor={visual.dim} color={visual.color}>
          {message.padEnd(44)}
        </Text>
        <Text dimColor> │</Text>
      </Box>

      {/* ===== BOTTOM BORDER ROW ===== */}
      <Box>
        <Text dimColor>└{"─".repeat(borderWidth)}┘</Text>
      </Box>
    </Box>
  );
};
