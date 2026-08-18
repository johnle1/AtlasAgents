/**
 * Text buffer reducer for the multiline prompt.
 *
 * @remarks
 * Mirrors `textBufferReducer`: state is `{ lines, cursor }`,
 * every operation is a pure function that returns a new state. The Ink
 * {@link MultilineInput} component is a thin view over this reducer —
 * unit tests never need to render a tree.
 *
 * Out of scope (intentionally, vs full buffer): undo history,
 * vim mode, visual selection. Paste collapse lives in `paste.ts`.
 *
 * @example
 * ```ts
 * let state = emptyBuffer();
 * state = textBufferReducer(state, { type: "insertText", text: "ab" });
 * state = textBufferReducer(state, { type: "newline" });
 * bufferToString(state); // "ab\n"
 * ```
 */

/**
 * Zero-based caret position inside {@link TextBufferState.lines}.
 */
export type Cursor = {
  /** Line index; `0` is the first line. */
  row: number;
  /** Column index; `0` is before the first character. */
  col: number;
};

/**
 * Multiline prompt state. `lines` is never empty — a blank prompt is `[""]`.
 */
export type TextBufferState = {
  /** Prompt lines, without trailing newlines. */
  lines: string[];
  /** Caret position; always clamped to a valid cell in `lines`. */
  cursor: Cursor;
};

/**
 * Discriminated union of buffer operations.
 *
 * @remarks
 * `replaceRange` is the paste seam: the view collapses a large paste to a
 * placeholder token, then asks the reducer to splice that token in.
 */
export type TextBufferAction =
  | { type: "insertText"; text: string }
  | { type: "newline" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "moveCursor"; direction: "left" | "right" | "up" | "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "replaceRange"; start: Cursor; end: Cursor; text: string }
  | { type: "setText"; text: string };

/**
 * Returns a blank one-line buffer with the caret at the origin.
 */
export const emptyBuffer = (): TextBufferState => ({
  lines: [""],
  cursor: { row: 0, col: 0 },
});

/**
 * Builds buffer state from a (possibly multiline) string.
 *
 * @param text - Source text; `""` becomes a single empty line.
 * @returns Buffer with the caret parked at the start (row 0, col 0).
 */
export const bufferFromString = (text: string): TextBufferState => {
  const lines = text.split("\n");
  return {
    lines: lines.length > 0 ? lines : [""],
    cursor: { row: 0, col: 0 },
  };
};

/**
 * Joins buffer lines with `\n`. An empty single line becomes `""`.
 *
 * @param state - Buffer to serialize.
 * @returns The prompt text, including embedded newlines.
 */
export const bufferToString = (state: TextBufferState): string =>
  state.lines.join("\n");

const clampCol = (line: string, col: number): number =>
  Math.max(0, Math.min(col, line.length));

const clampCursor = (lines: string[], cursor: Cursor): Cursor => {
  const row = Math.max(0, Math.min(cursor.row, lines.length - 1));
  const line = lines[row] ?? "";
  return { row, col: clampCol(line, cursor.col) };
};

const offsetOf = (lines: string[], cursor: Cursor): number => {
  let offset = 0;
  for (let row = 0; row < cursor.row; row += 1) {
    offset += (lines[row] ?? "").length + 1;
  }
  return offset + cursor.col;
};

const cursorAtOffset = (lines: string[], offset: number): Cursor => {
  let remaining = Math.max(0, offset);
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? "";
    if (remaining <= line.length) {
      return { row, col: remaining };
    }
    remaining -= line.length + 1;
  }
  const last = lines.length - 1;
  return { row: last, col: (lines[last] ?? "").length };
};

/**
 * Byte offset of the caret in {@link bufferToString} output.
 *
 * @param state - Buffer whose caret to measure.
 * @returns Offset from the start of the serialized prompt.
 */
export const cursorOffset = (state: TextBufferState): number =>
  offsetOf(state.lines, clampCursor(state.lines, state.cursor));

/**
 * Caret position corresponding to a byte offset in the serialized prompt.
 *
 * @param state - Buffer providing the line map.
 * @param offset - Offset in {@link bufferToString} output.
 * @returns Clamped cursor.
 */
export const cursorFromOffset = (
  state: TextBufferState,
  offset: number,
): Cursor => cursorAtOffset(state.lines, offset);

/**
 * Applies one buffer operation and returns a new state.
 *
 * @param state - Current buffer.
 * @param action - Operation to apply.
 * @returns Next state. Unknown action types return `state` unchanged.
 *
 * @example
 * ```ts
 * const next = textBufferReducer(emptyBuffer(), {
 *   type: "insertText",
 *   text: "hello",
 * });
 * ```
 */
export const textBufferReducer = (
  state: TextBufferState,
  action: TextBufferAction,
): TextBufferState => {
  const { lines, cursor } = state;

  switch (action.type) {
    case "insertText": {
      const { row, col } = clampCursor(lines, cursor);
      const line = lines[row] ?? "";
      const before = line.slice(0, col);
      const after = line.slice(col);
      const incoming = action.text.split("\n");
      if (incoming.length === 1) {
        const nextLine = `${before}${incoming[0]}${after}`;
        const nextLines = [...lines];
        nextLines[row] = nextLine;
        return {
          lines: nextLines,
          cursor: { row, col: col + (incoming[0] ?? "").length },
        };
      }
      const first = `${before}${incoming[0] ?? ""}`;
      const last = `${incoming[incoming.length - 1] ?? ""}${after}`;
      const middle = incoming.slice(1, -1);
      const nextLines = [
        ...lines.slice(0, row),
        first,
        ...middle,
        last,
        ...lines.slice(row + 1),
      ];
      const lastRow = row + incoming.length - 1;
      return {
        lines: nextLines,
        cursor: {
          row: lastRow,
          col: (incoming[incoming.length - 1] ?? "").length,
        },
      };
    }

    case "newline": {
      const { row, col } = clampCursor(lines, cursor);
      const line = lines[row] ?? "";
      const nextLines = [
        ...lines.slice(0, row),
        line.slice(0, col),
        line.slice(col),
        ...lines.slice(row + 1),
      ];
      return { lines: nextLines, cursor: { row: row + 1, col: 0 } };
    }

    case "backspace": {
      const { row, col } = clampCursor(lines, cursor);
      if (row === 0 && col === 0) {
        return state;
      }
      if (col === 0) {
        const prev = lines[row - 1] ?? "";
        const current = lines[row] ?? "";
        const nextLines = [
          ...lines.slice(0, row - 1),
          `${prev}${current}`,
          ...lines.slice(row + 1),
        ];
        return {
          lines: nextLines,
          cursor: { row: row - 1, col: prev.length },
        };
      }
      const line = lines[row] ?? "";
      const nextLines = [...lines];
      nextLines[row] = `${line.slice(0, col - 1)}${line.slice(col)}`;
      return { lines: nextLines, cursor: { row, col: col - 1 } };
    }

    case "delete": {
      const { row, col } = clampCursor(lines, cursor);
      const line = lines[row] ?? "";
      if (col < line.length) {
        const nextLines = [...lines];
        nextLines[row] = `${line.slice(0, col)}${line.slice(col + 1)}`;
        return { lines: nextLines, cursor: { row, col } };
      }
      if (row >= lines.length - 1) {
        return state;
      }
      const next = lines[row + 1] ?? "";
      const nextLines = [
        ...lines.slice(0, row),
        `${line}${next}`,
        ...lines.slice(row + 2),
      ];
      return { lines: nextLines, cursor: { row, col } };
    }

    case "moveCursor": {
      const { row, col } = clampCursor(lines, cursor);
      if (action.direction === "left") {
        if (col > 0) {
          return { lines, cursor: { row, col: col - 1 } };
        }
        if (row === 0) {
          return { lines, cursor: { row, col } };
        }
        const prev = lines[row - 1] ?? "";
        return { lines, cursor: { row: row - 1, col: prev.length } };
      }
      if (action.direction === "right") {
        const line = lines[row] ?? "";
        if (col < line.length) {
          return { lines, cursor: { row, col: col + 1 } };
        }
        if (row >= lines.length - 1) {
          return { lines, cursor: { row, col } };
        }
        return { lines, cursor: { row: row + 1, col: 0 } };
      }
      if (action.direction === "up") {
        if (row === 0) {
          return { lines, cursor: { row, col: 0 } };
        }
        const prev = lines[row - 1] ?? "";
        return { lines, cursor: { row: row - 1, col: clampCol(prev, col) } };
      }
      if (row >= lines.length - 1) {
        return { lines, cursor: { row, col } };
      }
      const next = lines[row + 1] ?? "";
      return { lines, cursor: { row: row + 1, col: clampCol(next, col) } };
    }

    case "home": {
      const { row } = clampCursor(lines, cursor);
      return { lines, cursor: { row, col: 0 } };
    }

    case "end": {
      const { row } = clampCursor(lines, cursor);
      const line = lines[row] ?? "";
      return { lines, cursor: { row, col: line.length } };
    }

    case "replaceRange": {
      const start = clampCursor(lines, action.start);
      const end = clampCursor(lines, action.end);
      const startOff = offsetOf(lines, start);
      const endOff = offsetOf(lines, end);
      const from = Math.min(startOff, endOff);
      const to = Math.max(startOff, endOff);
      const text = bufferToString({ lines, cursor });
      const nextText = `${text.slice(0, from)}${action.text}${text.slice(to)}`;
      const nextLines = nextText.split("\n");
      const safeLines = nextLines.length > 0 ? nextLines : [""];
      return {
        lines: safeLines,
        cursor: cursorAtOffset(safeLines, from + action.text.length),
      };
    }

    case "setText": {
      const next = bufferFromString(action.text);
      const last = next.lines.length - 1;
      return {
        lines: next.lines,
        cursor: { row: last, col: (next.lines[last] ?? "").length },
      };
    }

    default:
      return state;
  }
};

/**
 * True when `text` ends with a single trailing backslash, meaning Enter
 * should insert a newline instead of submitting (shell-style continuation).
 *
 * @param text - Current prompt contents.
 * @returns `true` when the last character is `\`.
 */
export const hasTrailingBackslash = (text: string): boolean =>
  text.endsWith("\\");

/**
 * Drops a trailing continuation backslash so a newline can replace it.
 *
 * @param text - Prompt that {@link hasTrailingBackslash} accepted.
 * @returns Text without the final `\`.
 */
export const stripTrailingBackslash = (text: string): string =>
  text.endsWith("\\") ? text.slice(0, -1) : text;
