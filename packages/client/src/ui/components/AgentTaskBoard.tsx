import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { AgentBoardState } from "../types.js";
import {
  getWorkingFrameMs,
  resolveTaskLifecycleVisual,
} from "../statusVisual.js";

/** Maximum number of tasks to display simultaneously in the task board. */
const MAX_VISIBLE_TASKS = 8;

/** Width of the task board border in characters. */
const BORDER_WIDTH = 48;

/**
 * <Summary>
 * What it does:
 *   Defines the props interface for the AgentTaskBoard component.
 *
 * Used by:
 *   - AgentTaskBoard — receives agent board state through these props.
 *
 * Produced by:
 *   - Parent UI components — pass AgentBoardState objects as props.
 * </Summary>
 */
type Props = {
  /** Complete state of the agent's task board including tasks and activity. */
  board: AgentBoardState;
};

/**
 * <Summary>
 * What it does:
 *   Renders a task board for a single agent, displaying individual tasks
 *   with status indicators and current activity in a bordered box format.
 *
 * How it fits in the system:
 *   Sits alongside AgentStatusBox to provide detailed task-level view of
 *   an agent's work. Shows the task queue, completion status, and current
 *   activity message. Limits display to prevent UI overcrowding.
 *
 * Dependencies:
 *   - React/ink — for terminal UI rendering and state management.
 *   - resolveTaskLifecycleVisual — determines visual indicators per task state.
 *   - getWorkingFrameMs — provides animation timing for running tasks.
 *
 * Dependants:
 *   - Main UI components — render AgentTaskBoard for each active agent.
 * </Summary>
 */
export const AgentTaskBoard: React.FC<Props> = ({ board }) => {
  // ===== STATE MANAGEMENT =====
  // Track animation frame index for pulsing visual effects on running tasks
  const [pulseIndex, setPulseIndex] = useState(0);

  // ===== DERIVED STATE =====
  // Check if any tasks are currently in running state
  const hasRunningTasks = board.tasks.some((task) => task.state === "running");

  // Check if animation should be active (same as hasRunningTasks but semantically distinct)
  const hasAnimatedTasks = board.tasks.some((task) => task.state === "running");

  /**
   * <Summary>
   * What it does:
   *   Manages animation loop for running tasks by incrementing pulse index
   *   on a timer when any task is in running state.
   *
   * How it does it (step by step):
   *   1. Check if any tasks are animated (running state).
   *   2. If no animated tasks, return early (no timer needed).
   *   3. Set up interval timer that increments pulse index each frame.
   *   4. Use getWorkingFrameMs to determine animation timing.
   *   5. Return cleanup function to clear interval on unmount or state change.
   *
   * Parameters:
   *   None — uses closure variable (hasAnimatedTasks).
   *
   * Returns:
   *   void — called for side effects (timer management and state updates).
   *
   * Dependencies:
   *   - getWorkingFrameMs — provides animation interval timing.
   *
   * Dependants:
   *   None (React useEffect hook, called by React on render).
   * </Summary>
   */
  useEffect(() => {
    // ===== STEP 1: Check if Animation is Needed =====
    // Only animate if there are tasks in running state
    if (!hasAnimatedTasks) {
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
  }, [hasAnimatedTasks]);

  // ===== TASK DISPLAY CALCULATIONS =====
  // Slice tasks to only show maximum visible tasks
  const visibleTasks = board.tasks.slice(0, MAX_VISIBLE_TASKS);

  // Calculate how many tasks are hidden beyond the visible limit
  const hiddenTaskCount = board.tasks.length - visibleTasks.length;

  // Construct display title based on agent ID and label
  const title =
    board.label.length > 0
      ? `Agent ${board.id} — ${board.label}`
      : `Agent ${board.id}`;

  // Calculate padding needed to align title within border width
  const titlePadding = Math.max(0, BORDER_WIDTH - title.length - 4);

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={0}>
      {/* ===== TOP BORDER ROW ===== */}
      <Box>
        <Text dimColor>┌─ </Text>
        <Text dimColor>{title} </Text>
        <Text dimColor>{"─".repeat(titlePadding)}┐</Text>
      </Box>

      {/* ===== VISIBLE TASKS ROWS ===== */}
      {visibleTasks.map((task) => {
        // Resolve visual representation (glyph, color, animation) based on task state
        const visual = resolveTaskLifecycleVisual(task.state, pulseIndex);

        // Format task display text with ID and description
        const rawTaskText = `${task.id}. ${task.text}`;

        // Truncate task text to fit within 44 character limit
        const truncatedTaskLine = rawTaskText.slice(0, 44);

        return (
          <Box key={task.id}>
            <Text dimColor>│ </Text>
            <Text color={visual.color} dimColor={visual.dim}>
              {visual.glyph}{" "}
            </Text>
            <Text dimColor={visual.dim} color={visual.color}>
              {truncatedTaskLine.padEnd(44)}
            </Text>
            <Text dimColor> │</Text>
          </Box>
        );
      })}

      {/* ===== HIDDEN TASKS INDICATOR ===== */}
      {hiddenTaskCount > 0 && (
        <Box>
          <Text dimColor>│ </Text>
          <Text dimColor>
            {"… and " + hiddenTaskCount + " more".padEnd(44)}
          </Text>
          <Text dimColor> │</Text>
        </Box>
      )}

      {/* ===== ACTIVITY MESSAGE ROW ===== */}
      {hasRunningTasks && board.activity && (
        <Box>
          <Text dimColor>│ </Text>
          <Text dimColor>{board.activity.message.slice(0, 39).padEnd(39)}</Text>
          <Text dimColor> │</Text>
        </Box>
      )}

      {/* ===== BOTTOM BORDER ROW ===== */}
      <Box>
        <Text dimColor>└{"─".repeat(BORDER_WIDTH)}┘</Text>
      </Box>
    </Box>
  );
};
