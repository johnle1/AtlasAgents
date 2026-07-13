import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import {
  getWorkingFrameMs,
  isWorkingStage,
  resolveWorkerVisual,
} from "../statusVisual.js";
import type { AgentStatusBoxProps as Props } from "./types.js";

/**
 * Renders a stylized status container for an individual agent or advisor using Ink.
 *
 * @remarks
 * This component visualizes the agent's progress, state transitions, and messages.
 * It encapsulates the terminal animation logic using local tick counters (`pulseIndex`)
 * driven by the resolved worker visual metadata.
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { AgentStatusBox } from "./AgentStatusBox.js";
 * 
 * render(
 *   <AgentStatusBox
 *     id={2}
 *     label="file-writer"
 *     icon="spinner"
 *     message="Creating index.css"
 *     stage="working"
 *   />
 * );
 * ```
 */
export const AgentStatusBox: React.FC<Props> = ({
  id,
  label,
  icon,
  message,
  stage,
}) => {
  // Drives terminal glyph animations by forcing state re-renders on a steady tick.
  const [pulseIndex, setPulseIndex] = useState(0);

  // Advisor has unique styling and labels distinct from numerical sub-agents.
  const isAdvisor = id === "advisor";

  // Maps high-level stages and status icons to terminal formatting (color, dim, character glyph).
  const visual = resolveWorkerVisual(stage, icon, pulseIndex, isAdvisor);

  /**
   * Sets up the animation tick loop for active tasks.
   *
   * @remarks
   * We only start the interval if the task is actively running (`isWorkingStage`) and
   * the resolved visual demands animation (e.g. spinners or pulsing effects).
   * This prevents background intervals from leaking and consuming CPU when idle or completed.
   */
  useEffect(() => {
    if (!visual.animate || !isWorkingStage(stage)) {
      return;
    }

    const timer = setInterval(() => {
      setPulseIndex((previousPulseIndex) => previousPulseIndex + 1);
    }, getWorkingFrameMs());

    return () => clearInterval(timer);
  }, [visual.animate, stage]);

  // Format a friendly display title. Advisor gets a static name, agents show ID and custom label.
  const title = isAdvisor
    ? "Advisor"
    : label.length > 0
      ? `Agent ${id} — ${label}`
      : `Agent ${id}`;

  // Fixed layout constraints to keep the box borders aligned across different agent logs.
  const borderWidth = 48;
  const titlePadding = Math.max(0, borderWidth - title.length - 4);

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={0}>
      {/* Top border row: embeds the component name/title directly into the upper border frame */}
      <Box>
        <Text dimColor>┌─ </Text>
        <Text dimColor>{title} </Text>
        <Text dimColor>{"─".repeat(titlePadding)}┐</Text>
      </Box>

      {/* Main body: renders the dynamic status glyph alongside the trailing status message */}
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

      {/* Bottom border row: closes the bordered card container */}
      <Box>
        <Text dimColor>└{"─".repeat(borderWidth)}┘</Text>
      </Box>
    </Box>
  );
};
