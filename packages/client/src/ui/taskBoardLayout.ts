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

/**
 * Columns reserved for the task board's bordered-card chrome when computing
 * wrap width, so lines pre-wrapped by {@link wrapTaskLine} always fit inside
 * the border and never trigger Ink's own fallback re-wrap.
 *
 * @remarks
 * Breakdown: 2 for the round border's left/right characters, 2 for
 * `paddingX={1}`, and 2 more so continuation rows — which carry a 3-column
 * indent rather than the 2-column glyph gutter root rows use — still fit
 * with a column of headroom to spare.
 */
export const TASK_BOARD_BORDER_RESERVED_COLUMNS = 6;

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
 * @param reservedColumns - Extra columns to subtract beyond the base
 *   margin/glyph budget, e.g. {@link TASK_BOARD_BORDER_RESERVED_COLUMNS}
 *   when the caller wraps the board in a bordered card. Defaults to 0 so
 *   existing callers are unaffected.
 * @returns The optimal text block rendering width.
 */
export const taskBoardInnerWidth = (reservedColumns = 0): number => {
  const columns = process.stdout.columns ?? 80;
  return Math.max(
    TASK_BOARD_MIN_INNER_WIDTH,
    Math.min(columns - 6 - reservedColumns, 100),
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

  const trimmedActivity = activityMessage?.trim();
  if (trimmedActivity && trimmedActivity.length > 0) {
    const wrappedActivity = wrapTaskLine(trimmedActivity, innerWidth);
    wrappedActivity.forEach((segment, segmentIndex) => {
      lines.push({
        key: `activity-${segmentIndex}`,
        glyphPrefix: segmentIndex === 0 ? "" : CONTINUATION_INDENT,
        text: segment,
        isRunning: false,
        isActivity: true,
      });
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

/** Width, in block characters, of the progress bar in the board header. */
const PROGRESS_BAR_WIDTH = 12;

/**
 * Builds a "N/M [bar] NN.N%" progress summary line for a task board header.
 *
 * @remarks
 * Mirrors the block-character style used for model-pull download progress
 * (`formatPullProgressLine` in `renderer/modelOutput.ts`) — filled `█` /
 * empty `░` blocks with a one-decimal percentage — so the CLI's two
 * progress indicators read consistently.
 *
 * @param completed - Number of tasks currently in the `complete` state.
 * @param total - Total number of tasks on the board.
 * @returns The formatted progress line, or `null` when the board has no tasks yet.
 */
export const buildTaskBoardProgress = (
  completed: number,
  total: number,
): string | null => {
  if (total <= 0) {
    return null;
  }

  const ratio = Math.min(1, Math.max(0, completed / total));
  const filledWidth = Math.floor(ratio * PROGRESS_BAR_WIDTH);
  const bar =
    "█".repeat(filledWidth) + "░".repeat(PROGRESS_BAR_WIDTH - filledWidth);
  const percentage = (ratio * 100).toFixed(1);

  return `${completed}/${total} ${bar} ${percentage}%`;
};

