/**
 * Width-aware pacing helpers for the live "thinking" view.
 *
 * @remarks
 * Server-side coalescing (`createThinkFrameEmitter` in the server package)
 * only protects the wire — it has no way to know how wide the user's
 * terminal is, or how many agents are thinking at once. This module supplies
 * the other half: how often the client should actually repaint, and how
 * much of a single live block to keep on screen, both derived from the
 * *live* terminal dimensions rather than a fixed constant.
 *
 * Both helpers take dimensions as parameters (with `process.stdout` reads as
 * defaults) specifically so they're testable without touching global state,
 * and so callers can read `process.stdout.columns`/`.rows` fresh at each
 * call site — matching the existing pattern in `taskBoardLayout.ts` and
 * `diffRenderer.ts` — rather than caching a value that goes stale on resize.
 */

/**
 * Reference point the threshold formula is scaled from: at 80 columns
 * (the traditional terminal default), buffer 10 characters between
 * repaints.
 */
const REFERENCE_COLUMNS = 80;
const REFERENCE_THRESHOLD = 10;

/**
 * Characters to buffer before triggering a repaint of a live think block.
 *
 * @remarks
 * A narrower terminal wraps the same text into more visual rows, so each
 * repaint costs more reconciler work at exactly the width where there's
 * least room for it. The threshold scales *inversely* with width — more
 * characters accumulate before a narrow terminal repaints, so it happens
 * less often (fewer events for a given stream of generated text), and each
 * one lands a bigger, less-frequent update rather than many small, costly
 * ones. A wide terminal does the opposite: its repaints are cheap (mostly
 * one row), so it can afford to fire more often.
 *
 * @param columns - Terminal width in columns. Defaults to the live
 *   `process.stdout.columns`, falling back to 80 when unavailable (e.g. not
 *   a TTY).
 * @returns Character threshold, never below 8.
 *
 * @example
 * ```ts
 * thinkDisplayThreshold(80);  // 10 (reference point)
 * thinkDisplayThreshold(40);  // 20 (narrower — repaints less often)
 * thinkDisplayThreshold(160); // 8 (wider — floor, repaints more often)
 * ```
 */
export const thinkDisplayThreshold = (
  columns: number = process.stdout.columns ?? 80,
): number =>
  Math.max(
    8,
    Math.round((REFERENCE_COLUMNS * REFERENCE_THRESHOLD) / Math.max(1, columns)),
  );

/**
 * Clamps `text` to (approximately) its last `maxRows` wrapped visual rows at
 * a given terminal width, prefixing an elision marker when anything was cut.
 *
 * @remarks
 * This does not itself wrap text for display — Ink already wraps `<Text>`
 * content to the container width. It only decides how much of a long,
 * still-growing think block to keep live on screen so N concurrent blocks
 * can't push the input prompt off screen. The full, untruncated text is
 * always what gets committed to scrollback on `think-end`; this only bounds
 * the transient live view.
 *
 * Rows are approximated by `ceil(line.length / columns)` per `\n`-delimited
 * line (an empty line counts as one row). When even the final line alone
 * exceeds the row budget, it's sliced from the right so the most recent
 * characters remain visible rather than the block disappearing entirely.
 *
 * @param text - The live (untruncated) think text so far.
 * @param columns - Terminal width in columns to wrap against.
 * @param maxRows - Maximum visual rows to keep.
 * @returns `text` unchanged if it already fits within `maxRows`, otherwise
 *   its trailing rows with a leading `"…"` marker.
 *
 * The leading `"…"` marker itself always occupies at least one row, so it's
 * reserved up front (`maxRows - 1` available for actual content) rather than
 * appended after the row accounting is already done — appending it after
 * the fact was exactly the bug this reserve avoids: a kept line that
 * exactly filled its row budget would gain one extra character (and
 * sometimes one extra wrapped row) the moment the marker was prefixed to
 * it, silently pushing the result to `maxRows + 1`.
 *
 * @example
 * ```ts
 * tailRows("line1\nline2\nline3", 80, 2); // "…\nline3"
 * tailRows("short", 80, 5);               // "short" (fits, unchanged)
 * ```
 */
export const tailRows = (
  text: string,
  columns: number,
  maxRows: number,
): string => {
  const safeColumns = Math.max(1, columns);
  const safeMaxRows = Math.max(1, maxRows);
  const lines = text.split("\n");
  const rowsForLine = (line: string): number =>
    line.length === 0 ? 1 : Math.ceil(line.length / safeColumns);

  const totalRows = lines.reduce((sum, line) => sum + rowsForLine(line), 0);
  if (totalRows <= safeMaxRows) {
    return text;
  }

  // One row reserved for the "…" marker every return path below emits —
  // see the remark above for why this has to happen before accumulating
  // kept lines, not after.
  let rowsBudget = safeMaxRows - 1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const lineRows = rowsForLine(line);

    if (lineRows <= rowsBudget) {
      rowsBudget -= lineRows;
      continue;
    }

    // The remaining budget is smaller than this line needs: keep only its
    // last `rowsBudget` wrapped rows worth of characters (possibly zero),
    // drop everything before it, and mark the cut with an ellipsis.
    const keptChars = rowsBudget * safeColumns;
    const partial = keptChars > 0 ? line.slice(-keptChars) : "";
    const rest = lines.slice(i + 1).join("\n");
    return [`…${partial}`, rest].filter((part) => part.length > 0).join("\n");
  }

  // Unreachable: totalRows > safeMaxRows (checked above) guarantees the loop
  // returns from its partial-line branch before exhausting all lines. Kept
  // only to satisfy the function's return type.
  return text;
};
