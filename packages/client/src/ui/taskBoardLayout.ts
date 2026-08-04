/**
 * Task board layout styling and text wrapping helpers.
 *
 * @remarks
 * Computes border widths, wraps multi-line task description texts to fit terminal column budgets,
 * and tracks indentation for continued lines.
 */

/** Minimum inner width for agent task board content. */
export const TASK_BOARD_MIN_INNER_WIDTH = 44;

/** Minimum full border width including │ padding. */
export const TASK_BOARD_MIN_BORDER_WIDTH = 48;

const CONTINUATION_INDENT = "   ";

/**
 * Wraps text to fit within maxWidth, breaking on spaces when possible.
 *
 * @param text - The raw string of text to wrap.
 * @param maxWidth - Maximum number of characters allowed per line.
 * @returns Array of wrapped sub-strings.
 */
export const wrapTaskLine = (text: string, maxWidth: number): string[] => {
  if (maxWidth < 8 || text.length <= maxWidth) {
    return [text];
  }

  const lines: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxWidth) {
      lines.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf(" ", maxWidth);
    if (breakAt < Math.floor(maxWidth * 0.35)) {
      breakAt = maxWidth;
    }

    lines.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }

  return lines;
};

/**
 * Inner text width based on terminal size (capped for readability).
 *
 * @returns The optimal text block rendering width.
 */
export const taskBoardInnerWidth = (): number => {
  const columns = process.stdout.columns ?? 80;
  return Math.max(
    TASK_BOARD_MIN_INNER_WIDTH,
    Math.min(columns - 6, 100),
  );
};

/** A renderable line in the task board component. */
export type TaskBoardLine = {
  /** React key for map lists. */
  key: string;
  /** Prefix indentation spacing. */
  glyphPrefix: string;
  /** Content string. */
  text: string;
  /** True if the corresponding task is in a running state. */
  isRunning: boolean;
  /** True if this is an active status activity step message. */
  isActivity: boolean;
};

/**
 * Maps task status array into wrapped rendering lines.
 *
 * @param tasks - List of active tasks.
 * @param activityMessage - Current subagent activity (e.g. "Thinking…",
 *   "Running: npm test"), appended as a trailing line when non-empty.
 * @param innerWidth - Target column wrap width.
 * @returns Array of renderable lines.
 */
export const buildTaskBoardLines = (
  tasks: Array<{ id: number; text: string; state: string }>,
  activityMessage: string | undefined,
  innerWidth: number,
): TaskBoardLine[] => {
  const lines: TaskBoardLine[] = [];

  for (const task of tasks) {
    const wrapped = wrapTaskLine(`${task.id}. ${task.text}`, innerWidth);
    wrapped.forEach((segment, segmentIndex) => {
      lines.push({
        key: `task-${task.id}-${segmentIndex}`,
        glyphPrefix: segmentIndex === 0 ? "" : CONTINUATION_INDENT,
        text: segment,
        isRunning: task.state === "running",
        isActivity: false,
      });
    });
  }

  if (activityMessage && activityMessage.trim().length > 0) {
    lines.push({
      key: "activity",
      glyphPrefix: CONTINUATION_INDENT,
      text: activityMessage.trim(),
      isRunning: false,
      isActivity: true,
    });
  }

  return lines;
};

/**
 * Calculates the target border frame width based on titles and wrapped content widths.
 *
 * @param title - The title of the board frame.
 * @param contentLines - List of wrapped content rows.
 * @returns The full column width.
 */
export const taskBoardBorderWidth = (
  title: string,
  contentLines: TaskBoardLine[],
): number => {
  const longestContent = contentLines.reduce(
    (max, line) => Math.max(max, line.glyphPrefix.length + line.text.length),
    0,
  );

  return Math.max(
    TASK_BOARD_MIN_BORDER_WIDTH,
    title.length + 4,
    longestContent + 4,
  );
};

