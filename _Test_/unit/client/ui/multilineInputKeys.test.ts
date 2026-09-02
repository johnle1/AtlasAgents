/**
 * Unit tests — client ui/components/MultilineInput.tsx (key routing)
 *
 * @remarks
 * `textBuffer.test.ts` proves the reducer is correct in isolation, but the
 * reported bug ("cannot delete") lives one layer up, in how Ink's raw key
 * flags get routed to reducer actions. Ink 5 reports the physical Backspace
 * key (`\x7f`) as `key.delete`, not `key.backspace` — a synthetic
 * `{ backspace: true }` object would hide that split entirely. These tests
 * drive real byte sequences through `stdin.write()` so Ink's own
 * `parseKeypress` runs, the same way a terminal would deliver them.
 *
 * `useInput` resubscribes its stdin listener from a `useEffect` keyed on the
 * handler's identity, and that effect is passive — it flushes on the next
 * tick, not synchronously with the state update. A real terminal delivers
 * each keystroke as its own I/O event, giving that tick plenty of room; a
 * synchronous test loop does not, so two `stdin.write()` calls back to back
 * would both fire against the same pre-update closure and the second write
 * would clobber the first. `send()` awaits one tick after every write so
 * each keystroke is processed against the current buffer, matching real
 * terminal timing instead of a test-only race.
 *
 * Category checklist:
 * - Normal: typing, Backspace deletes, Enter submits, paste collapses
 * - Boundary: Backspace at empty buffer, line-join backspace, Ctrl+D/A/E,
 *   trailing-backslash continuation, CR-only paste, atomic placeholder delete
 * - Error: `disabled` swallows all keys
 */

import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";

import { MultilineInput } from "../../../../packages/client/src/ui/components/MultilineInput.js";
import type { MultilineInputProps } from "../../../../packages/client/src/ui/components/MultilineInput.js";

type Tree = ReturnType<typeof render>;

const frame = (tree: Tree) => stripAnsi(tree.lastFrame() ?? "");

const lastChange = (onChange: ReturnType<typeof vi.fn>): string =>
  onChange.mock.calls.at(-1)?.[0];

const tick = () => new Promise((resolve) => setImmediate(resolve));

const mount = async (props: MultilineInputProps): Promise<Tree> => {
  const tree = render(React.createElement(MultilineInput, props));
  // useInput's stdin listener attaches from a useEffect, which React flushes
  // one tick after the initial commit — wait for it before sending keys.
  await tick();
  return tree;
};

/** Writes each chunk as its own stdin event, one event-loop tick apart. */
const send = async (tree: Tree, ...chunks: string[]): Promise<void> => {
  for (const chunk of chunks) {
    tree.stdin.write(chunk);
    await tick();
  }
};

// Raw byte sequences a terminal sends, matching node_modules/ink's
// parse-keypress.js.
const BACKSPACE = "\x7f"; // physical Backspace key (macOS/Linux)
const CTRL_D = "\x04";
const CTRL_A = "\x01";
const CTRL_E = "\x05";
const ENTER = "\r";
const LEFT = "\x1b[D";

describe("MultilineInput — typing and Enter", () => {
  it("emits typed characters and submits on Enter (normal)", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const tree = await mount({ value: "", onChange, onSubmit });

    await send(tree, "h", "i");
    expect(lastChange(onChange)).toBe("hi");
    expect(frame(tree)).toContain("hi");

    await send(tree, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("hi");
    expect(onChange.mock.calls.some((call) => call[0].includes("\n"))).toBe(
      false,
    );

    tree.unmount();
  });
});

describe("MultilineInput — Backspace (reported bug)", () => {
  it("deletes the character before the caret (normal)", async () => {
    const onChange = vi.fn();
    const tree = await mount({ value: "", onChange, onSubmit: vi.fn() });

    await send(tree, "a", "b", "c");
    expect(lastChange(onChange)).toBe("abc");

    await send(tree, BACKSPACE);

    expect(lastChange(onChange)).toBe("ab");

    tree.unmount();
  });

  it("is a no-op on an empty buffer and does not throw (boundary)", async () => {
    const onChange = vi.fn();
    const tree = await mount({ value: "", onChange, onSubmit: vi.fn() });

    await expect(send(tree, BACKSPACE)).resolves.not.toThrow();
    expect(lastChange(onChange)).toBe("");
    expect(frame(tree)).not.toContain("undefined");

    tree.unmount();
  });

  it("joins with the previous line at the start of a row (boundary)", async () => {
    const onChange = vi.fn();
    const tree = await mount({ value: "", onChange, onSubmit: vi.fn() });

    // Trailing-backslash + Enter inserts a newline without submitting.
    await send(tree, "a", "b", "\\", ENTER);
    expect(lastChange(onChange)).toBe("ab\n");

    await send(tree, "c", "d");
    expect(lastChange(onChange)).toBe("ab\ncd");

    await send(tree, CTRL_A); // home — caret to start of "cd"
    await send(tree, BACKSPACE);

    expect(lastChange(onChange)).toBe("abcd");

    tree.unmount();
  });

  it("removes an entire paste placeholder in one keystroke (boundary — atomic delete)", async () => {
    const onChange = vi.fn();
    const tree = await mount({ value: "", onChange, onSubmit: vi.fn() });

    await send(tree, "x".repeat(200)); // one bracketed-paste-sized chunk
    expect(frame(tree)).toMatch(/\[Pasted text #1: 1 line\]/);

    await send(tree, BACKSPACE);

    expect(lastChange(onChange)).toBe("");
    expect(frame(tree)).not.toContain("Pasted");

    tree.unmount();
  });
});

describe("MultilineInput — Ctrl+D / Ctrl+A / Ctrl+E", () => {
  it("Ctrl+D forward-deletes the character under the caret (normal)", async () => {
    const onChange = vi.fn();
    const tree = await mount({ value: "", onChange, onSubmit: vi.fn() });

    await send(tree, "a", "b", "c", LEFT, LEFT, CTRL_D);

    expect(lastChange(onChange)).toBe("ac");

    tree.unmount();
  });

  it("Ctrl+A moves the caret home so typed text prepends (normal)", async () => {
    const onChange = vi.fn();
    const tree = await mount({ value: "", onChange, onSubmit: vi.fn() });

    await send(tree, "x", "y", CTRL_A, "a");

    expect(lastChange(onChange)).toBe("axy");

    tree.unmount();
  });

  it("Ctrl+E moves the caret to end so typed text appends (normal)", async () => {
    const onChange = vi.fn();
    const tree = await mount({ value: "", onChange, onSubmit: vi.fn() });

    await send(tree, "x", "y", LEFT, CTRL_E, "z");

    expect(lastChange(onChange)).toBe("xyz");

    tree.unmount();
  });
});

describe("MultilineInput — trailing-backslash continuation", () => {
  it("inserts a newline and strips exactly one backslash instead of submitting (normal)", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const tree = await mount({ value: "", onChange, onSubmit });

    await send(tree, "a", "b", "c", "\\", ENTER);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastChange(onChange)).toBe("abc\n");

    tree.unmount();
  });
});

describe("MultilineInput — paste round-trip and CR normalization", () => {
  it("submits the verbatim pasted text, not the collapsed placeholder (normal)", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const pasted = "x".repeat(200);
    const tree = await mount({ value: "", onChange, onSubmit });

    await send(tree, pasted);
    expect(frame(tree)).toMatch(/\[Pasted text #1/);

    await send(tree, ENTER);

    expect(onSubmit).toHaveBeenCalledWith(pasted);

    tree.unmount();
  });

  it("normalizes CR line breaks from a paste to LF (boundary)", async () => {
    const onChange = vi.fn();
    const tree = await mount({ value: "", onChange, onSubmit: vi.fn() });

    await send(tree, "a\rb");

    expect(lastChange(onChange)).toBe("a\nb");

    tree.unmount();
  });
});

describe("MultilineInput — disabled (error)", () => {
  it("swallows all keys while disabled", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const tree = await mount({
      value: "",
      onChange,
      onSubmit,
      disabled: true,
    });

    await send(tree, "a", ENTER, BACKSPACE);

    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    tree.unmount();
  });
});
