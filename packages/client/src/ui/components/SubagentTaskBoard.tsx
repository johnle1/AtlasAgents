import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import {
  buildTaskBoardLines,
  buildTaskBoardProgress,
  TASK_BOARD_BORDER_RESERVED_COLUMNS,
  taskBoardInnerWidth,
} from "../taskBoardLayout.js";
import {
  getWorkingFrameMs,
  resolveTaskLifecycleVisual,
  shouldAnimateWorker,
} from "../statusVisual.js";
import type { SubagentTaskBoardProps as Props } from "./types.js";

/**
 * Maximum number of tasks to display simultaneously in the task board.
 *
 * @remarks
 * Caps the vertical size of the board inside the terminal view to avoid cluttering 
 * the console screen. Additional tasks are summarized dynamically.
 */
const MAX_VISIBLE_TASKS = 12;

/** Character width occupied by a resolved status glyph prefix (character + spacing). */
const GLYPH = 2;

/**
 * Renders a list-style task board for a single agent, indicating progress of sub-tasks.
 *
 * @remarks
 * Displays the current workflow status of an agent using clean terminal lines.
 * It animates active tasks using an internal interval tick (`pulseIndex`), maps task status
 * (e.g. `running`, `completed`, `failed`) to visual indicators, and gracefully truncates
 * the rendering if the tasks exceed layout height constraints.
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { SubagentTaskBoard } from "./SubagentTaskBoard.js";
 *
 * const boardState = {
 *   id: 3,
 *   label: "tester",
 *   tasks: [
 *     { id: "t1", state: "completed", label: "Lint codebase" },
 *     { id: "t2", state: "running", label: "Run unit tests" }
 *   ]
 * };
 *
 * render(<SubagentTaskBoard board={boardState} />);
 * ```
 */
export const SubagentTaskBoard: React.FC<Props> = ({ board }) => {
  // Drives terminal glyph animations by forcing state re-renders on a steady tick.
  const [pulseIndex, setPulseIndex] = useState(0);

  // Enforce screen height budgeting by clipping tasks exceeding the visibility threshold.
  const visibleTasks = board.tasks.slice(0, MAX_VISIBLE_TASKS);
  const hiddenTaskCount = board.tasks.length - visibleTasks.length;

  // We only run the pulse loop if the terminal context supports it and tasks are actively running.
  const hasRunningTasks = board.tasks.some((task) => task.state === "running");
  const shouldAnimate = shouldAnimateWorker() && hasRunningTasks;

  /**
   * Sets up the animation interval loop for any active task on this board.
   *
   * @remarks
   * Cleanly registers and destroys timers to prevent CPU consumption and frame rate drops
   * once all active task animations have finished or when the component unmounts.
   */
  useEffect(() => {
    if (!shouldAnimate) {
      return;
    }

    const timer = setInterval(() => {
      setPulseIndex((previousPulseIndex) => previousPulseIndex + 1);
    }, getWorkingFrameMs());

    return () => clearInterval(timer);
  }, [shouldAnimate]);

  // Interpolate agent identifier details into a standardized header label.
  const title =
    board.label.length > 0
      ? `Agent ${board.id} — ${board.label}`
      : `Agent ${board.id}`;

  // Reserve columns for the card's round border + horizontal padding so
  // wrapped lines never grow wide enough to get clipped against the border.
  const innerWidth = taskBoardInnerWidth(TASK_BOARD_BORDER_RESERVED_COLUMNS);

  // Current subagent activity (e.g. "Thinking…", "Running: npm test"),
  // appended as a trailing board line — see buildTaskBoardLines.
  const activityMessage = board.activity?.message;

  // Computes the formatted output lines, allocating text space dynamically.
  const contentLines = useMemo(
    () => buildTaskBoardLines(visibleTasks, activityMessage, innerWidth),
    [visibleTasks, activityMessage, innerWidth],
  );

  // Whole-board completion summary (uses all tasks, not just the visible
  // slice, so the percentage stays accurate once tasks scroll past
  // MAX_VISIBLE_TASKS).
  const completedCount = board.tasks.filter(
    (task) => task.state === "complete",
  ).length;
  const progressLine = buildTaskBoardProgress(
    completedCount,
    board.tasks.length,
  );

  return (
    <Box
      flexDirection="column"
      alignSelf="flex-start"
      marginLeft={2}
      marginBottom={1}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      {/* Group Title: acts as the header for the task list hierarchy */}
      <Text bold color="cyan">
        • {title}
      </Text>

      {/* Progress summary: "N/M [bar] NN.N%" — same block-character style as
          the model-pull download progress bar in renderer/modelOutput.ts */}
      {progressLine && (
        <Text color={completedCount === board.tasks.length ? "green" : "cyan"}>
          {progressLine}
        </Text>
      )}

      {/* Render each subtask line by applying state-specific colors and symbols */}
      {contentLines.map((line) => {
        // The trailing activity line (e.g. "Thinking…") has no source task to
        // match against — render it as a plain dim status line instead.
        if (line.isActivity) {
          return (
            <Text key={line.key} dimColor>
              {line.glyphPrefix.length === 0 ? "  ↳ " : "    "}
              {line.text}
            </Text>
          );
        }

        // Match the line back to the source task to resolve its active execution state.
        const task = visibleTasks.find((candidate) =>
          line.key.startsWith(`task-${candidate.id}-`),
        );

        // Convert status state to a theme-compliant color palette and text styling.
        const visual = resolveTaskLifecycleVisual(
          task?.state ?? "waiting",
          line.isRunning ? pulseIndex : 0,
        );

        // Prepend glyph symbols for root-level items, indent nested items.
        const glyph =
          line.glyphPrefix.length === 0
            ? `${visual.glyph} `
            : " ".repeat(GLYPH);

        return (
          <Text
            key={line.key}
            color={visual.color}
            dimColor={visual.dim && !line.isRunning}
            bold={line.isRunning}
          >
            {glyph}
            {line.glyphPrefix}
            {line.text}
          </Text>
        );
      })}

      {/* Overflow Indicator: tells the user if tasks were omitted due to space limits */}
      {hiddenTaskCount > 0 && (
        <Text dimColor>{`… and ${hiddenTaskCount} more`}</Text>
      )}
    </Box>
  );
};
