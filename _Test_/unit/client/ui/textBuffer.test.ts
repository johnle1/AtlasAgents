/**
 * Unit tests — client ui/multiline/textBuffer.ts
 *
 * Pure cli reducer: every op returns new `{ lines, cursor }` state.
 * No Ink, no React — cursor math and line joins are the whole contract.
 *
 * Category checklist:
 * - Normal: insert, newline, backspace, cursor, home/end, replaceRange
 * - Boundary: empty buffer, cursor clamped at edges, backspace at start of line
 * - Error: unknown action is a no-op (state identity)
 */

import { describe, expect, it } from "vitest";
import {
  bufferFromString,
  bufferToString,
  cursorFromOffset,
  cursorOffset,
  emptyBuffer,
  hasTrailingBackslash,
  normalizeNewlines,
  stripTrailingBackslash,
  textBufferReducer,
  type TextBufferState,
} from "../../../../packages/client/src/ui/multiline/textBuffer.js";

const apply = (
  state: TextBufferState,
  ...actions: Parameters<typeof textBufferReducer>[1][]
): TextBufferState =>
  actions.reduce(
    (current, action) => textBufferReducer(current, action),
    state,
  );

describe("emptyBuffer / bufferFromString / bufferToString", () => {
  it("starts as a single empty line with cursor at 0,0 (normal)", () => {
    expect(emptyBuffer()).toEqual({
      lines: [""],
      cursor: { row: 0, col: 0 },
    });
  });

  it("round-trips a multiline string (normal)", () => {
    const text = "hello\nworld";
    expect(bufferToString(bufferFromString(text))).toBe(text);
  });

  it("treats an empty string as one empty line (boundary)", () => {
    const state = bufferFromString("");
    expect(state.lines).toEqual([""]);
    expect(bufferToString(state)).toBe("");
  });
});

describe("insertText", () => {
  it("inserts at the cursor and advances it (normal)", () => {
    const next = apply(emptyBuffer(), { type: "insertText", text: "ab" });
    expect(bufferToString(next)).toBe("ab");
    expect(next.cursor).toEqual({ row: 0, col: 2 });
  });

  it("inserts in the middle of a line (normal)", () => {
    const start = apply(emptyBuffer(), { type: "insertText", text: "ac" });
    const mid = textBufferReducer(start, {
      type: "moveCursor",
      direction: "left",
    });
    const next = textBufferReducer(mid, { type: "insertText", text: "b" });
    expect(bufferToString(next)).toBe("abc");
    expect(next.cursor).toEqual({ row: 0, col: 2 });
  });

  it("splits inserted text on newlines (boundary)", () => {
    const next = apply(emptyBuffer(), { type: "insertText", text: "a\nb" });
    expect(next.lines).toEqual(["a", "b"]);
    expect(next.cursor).toEqual({ row: 1, col: 1 });
  });
});

describe("newline", () => {
  it("splits the current line at the cursor (normal)", () => {
    const start = apply(emptyBuffer(), { type: "insertText", text: "ab" });
    const mid = textBufferReducer(start, {
      type: "moveCursor",
      direction: "left",
    });
    const next = textBufferReducer(mid, { type: "newline" });
    expect(next.lines).toEqual(["a", "b"]);
    expect(next.cursor).toEqual({ row: 1, col: 0 });
  });

  it("appends an empty line when the cursor is at end of text (boundary)", () => {
    const start = apply(emptyBuffer(), { type: "insertText", text: "hi" });
    const next = textBufferReducer(start, { type: "newline" });
    expect(next.lines).toEqual(["hi", ""]);
    expect(next.cursor).toEqual({ row: 1, col: 0 });
  });
});

describe("backspace", () => {
  it("deletes the character before the cursor (normal)", () => {
    const start = apply(emptyBuffer(), { type: "insertText", text: "ab" });
    const next = textBufferReducer(start, { type: "backspace" });
    expect(bufferToString(next)).toBe("a");
    expect(next.cursor).toEqual({ row: 0, col: 1 });
  });

  it("joins the current line with the previous when at column 0 (boundary)", () => {
    const start = bufferFromString("ab\ncd");
    const atStartOfSecond = {
      ...start,
      cursor: { row: 1, col: 0 },
    };
    const next = textBufferReducer(atStartOfSecond, { type: "backspace" });
    expect(next.lines).toEqual(["abcd"]);
    expect(next.cursor).toEqual({ row: 0, col: 2 });
  });

  it("is a no-op at the start of the buffer (boundary)", () => {
    const start = bufferFromString("ab");
    const next = textBufferReducer(start, { type: "backspace" });
    expect(next).toEqual(start);
  });
});

describe("delete", () => {
  it("deletes the character at the cursor and leaves the cursor in place (normal)", () => {
    const start = {
      ...bufferFromString("abcd"),
      cursor: { row: 0, col: 2 },
    };

    const next = textBufferReducer(start, { type: "delete" });

    expect(bufferToString(next)).toBe("abd");
    expect(next.cursor).toEqual({ row: 0, col: 2 });
  });

  it("joins with the following line when deleting at the end of a row (boundary)", () => {
    const start = {
      ...bufferFromString("ab\ncd"),
      cursor: { row: 0, col: 2 },
    };

    const next = textBufferReducer(start, { type: "delete" });

    expect(next.lines).toEqual(["abcd"]);
    expect(next.cursor).toEqual({ row: 0, col: 2 });
  });

  it("is a no-op at the end of the final line (boundary)", () => {
    const start = {
      ...bufferFromString("ab\ncd"),
      cursor: { row: 1, col: 2 },
    };

    expect(textBufferReducer(start, { type: "delete" })).toBe(start);
  });
});

describe("moveCursor", () => {
  it("moves left and right within a line (normal)", () => {
    const start = apply(emptyBuffer(), { type: "insertText", text: "ab" });
    const left = textBufferReducer(start, {
      type: "moveCursor",
      direction: "left",
    });
    expect(left.cursor).toEqual({ row: 0, col: 1 });
    const right = textBufferReducer(left, {
      type: "moveCursor",
      direction: "right",
    });
    expect(right.cursor).toEqual({ row: 0, col: 2 });
  });

  it("wraps left from col 0 onto the previous line (boundary)", () => {
    const start = bufferFromString("ab\ncd");
    const atStartOfSecond = { ...start, cursor: { row: 1, col: 0 } };
    const next = textBufferReducer(atStartOfSecond, {
      type: "moveCursor",
      direction: "left",
    });
    expect(next.cursor).toEqual({ row: 0, col: 2 });
  });

  it("wraps right from end of a line onto the next (boundary)", () => {
    const start = bufferFromString("ab\ncd");
    const atEndOfFirst = { ...start, cursor: { row: 0, col: 2 } };
    const next = textBufferReducer(atEndOfFirst, {
      type: "moveCursor",
      direction: "right",
    });
    expect(next.cursor).toEqual({ row: 1, col: 0 });
  });

  it("clamps up/down to the shorter line's end (boundary)", () => {
    const start = bufferFromString("abcd\nxy");
    const atEndOfFirst = { ...start, cursor: { row: 0, col: 4 } };
    const down = textBufferReducer(atEndOfFirst, {
      type: "moveCursor",
      direction: "down",
    });
    expect(down.cursor).toEqual({ row: 1, col: 2 });
    const up = textBufferReducer(down, {
      type: "moveCursor",
      direction: "up",
    });
    expect(up.cursor).toEqual({ row: 0, col: 2 });
  });

  it("clamps at the first and last line (boundary)", () => {
    const start = bufferFromString("ab");
    const up = textBufferReducer(start, {
      type: "moveCursor",
      direction: "up",
    });
    expect(up.cursor).toEqual({ row: 0, col: 0 });
    const atEnd = { ...start, cursor: { row: 0, col: 2 } };
    const down = textBufferReducer(atEnd, {
      type: "moveCursor",
      direction: "down",
    });
    expect(down.cursor).toEqual({ row: 0, col: 2 });
  });
});

describe("home / end", () => {
  it("home jumps to column 0 of the current row (normal)", () => {
    const start = apply(emptyBuffer(), { type: "insertText", text: "hello" });
    const next = textBufferReducer(start, { type: "home" });
    expect(next.cursor).toEqual({ row: 0, col: 0 });
    expect(next.lines).toEqual(["hello"]);
  });

  it("end jumps to the end of the current row (normal)", () => {
    const start = bufferFromString("hello");
    const next = textBufferReducer(start, { type: "end" });
    expect(next.cursor).toEqual({ row: 0, col: 5 });
  });
});

describe("replaceRange", () => {
  it("replaces a span with new text (normal — paste seam)", () => {
    const start = bufferFromString("hello world");
    const next = textBufferReducer(start, {
      type: "replaceRange",
      start: { row: 0, col: 6 },
      end: { row: 0, col: 11 },
      text: "there",
    });
    expect(bufferToString(next)).toBe("hello there");
    expect(next.cursor).toEqual({ row: 0, col: 11 });
  });

  it("can insert across a line break (boundary)", () => {
    const start = bufferFromString("ab\ncd");
    const next = textBufferReducer(start, {
      type: "replaceRange",
      start: { row: 0, col: 1 },
      end: { row: 1, col: 1 },
      text: "XY",
    });
    expect(bufferToString(next)).toBe("aXYd");
  });
});

describe("setText", () => {
  it("replaces the whole buffer and parks the cursor at the end (normal)", () => {
    const next = textBufferReducer(emptyBuffer(), {
      type: "setText",
      text: "one\ntwo",
    });
    expect(next.lines).toEqual(["one", "two"]);
    expect(next.cursor).toEqual({ row: 1, col: 3 });
  });
});

describe("cursorOffset / cursorFromOffset", () => {
  it("maps cursor positions across multiline newline boundaries (normal)", () => {
    const state = bufferFromString("ab\ncde\n");
    const positions = [
      { cursor: { row: 0, col: 0 }, offset: 0 },
      { cursor: { row: 0, col: 2 }, offset: 2 },
      { cursor: { row: 1, col: 0 }, offset: 3 },
      { cursor: { row: 1, col: 3 }, offset: 6 },
      { cursor: { row: 2, col: 0 }, offset: 7 },
    ];

    for (const { cursor, offset } of positions) {
      expect(cursorOffset({ ...state, cursor })).toBe(offset);
      expect(cursorFromOffset(state, offset)).toEqual(cursor);
    }
  });

  it("clamps out-of-range offsets and cursors to the buffer bounds (boundary)", () => {
    const state = bufferFromString("ab\nc");

    expect(cursorFromOffset(state, -10)).toEqual({ row: 0, col: 0 });
    expect(cursorFromOffset(state, 99)).toEqual({ row: 1, col: 1 });
    expect(
      cursorOffset({ ...state, cursor: { row: 99, col: 99 } }),
    ).toBe(4);
  });
});

describe("trailing continuation helpers", () => {
  it("recognizes a trailing backslash and removes exactly one on continuation (normal)", () => {
    expect(hasTrailingBackslash("echo hello\\")).toBe(true);
    expect(stripTrailingBackslash("echo hello\\")).toBe("echo hello");
    expect(stripTrailingBackslash("echo hello\\\\")).toBe("echo hello\\");
  });

  it("leaves text without a trailing backslash unchanged (boundary)", () => {
    expect(hasTrailingBackslash("echo hello")).toBe(false);
    expect(hasTrailingBackslash("")).toBe(false);
    expect(stripTrailingBackslash("echo hello")).toBe("echo hello");
  });
});

describe("normalizeNewlines", () => {
  it("converts CRLF and bare CR to LF (normal)", () => {
    expect(normalizeNewlines("a\r\nb")).toBe("a\nb");
    expect(normalizeNewlines("a\rb")).toBe("a\nb");
    expect(normalizeNewlines("a\r\nb\rc\r\nd")).toBe("a\nb\nc\nd");
  });

  it("leaves text with only LF or no line breaks unchanged (boundary)", () => {
    expect(normalizeNewlines("a\nb")).toBe("a\nb");
    expect(normalizeNewlines("plain text")).toBe("plain text");
    expect(normalizeNewlines("")).toBe("");
  });
});

describe("carriage returns in insertText / bufferFromString", () => {
  it("normalizes a pasted CRLF block inserted via insertText (normal)", () => {
    const next = textBufferReducer(emptyBuffer(), {
      type: "insertText",
      text: "line1\r\nline2\r\nline3",
    });
    expect(next.lines).toEqual(["line1", "line2", "line3"]);
    expect(bufferToString(next)).toBe("line1\nline2\nline3");
  });

  it("normalizes bare CR line breaks in bufferFromString (boundary)", () => {
    const state = bufferFromString("a\rb\rc");
    expect(state.lines).toEqual(["a", "b", "c"]);
  });
});

describe("unknown action (error)", () => {
  it("returns the same state for an unrecognized action type", () => {
    const start = bufferFromString("keep");
    const next = textBufferReducer(start, {
      type: "not-a-real-action",
    } as never);
    expect(next).toEqual(start);
  });
});
