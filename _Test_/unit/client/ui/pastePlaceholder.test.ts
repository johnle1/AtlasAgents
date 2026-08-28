/**
 * Unit tests — client ui/multiline/paste.ts
 *
 * Paste detection and collapse/expand are pure so they can be tested
 * without Ink's bracketed-paste path. The submitted value must equal
 * the original paste even after the display is collapsed to a token.
 *
 * Category checklist:
 * - Normal: detect large paste, collapse above threshold, expand on submit
 * - Boundary: small paste is left as-is; threshold equality; atomic delete
 * - Error: expand with no matching placeholder is a no-op
 */

import { describe, expect, it } from "vitest";
import {
  collapsePaste,
  detectPaste,
  expandPlaceholders,
  placeholderRangeAt,
  PASTE_CHAR_THRESHOLD,
} from "../../../../packages/client/src/ui/multiline/paste.js";

describe("detectPaste", () => {
  it("treats a length delta greater than 1 as a paste (normal)", () => {
    expect(detectPaste("hi", "hi\nthere\nworld")).toBe(true);
  });

  it("does not treat a single-character insert as a paste (boundary)", () => {
    expect(detectPaste("hi", "hit")).toBe(false);
  });

  it("does not treat a deletion as a paste (boundary)", () => {
    expect(detectPaste("hello", "hell")).toBe(false);
  });

  it("does not treat an identical string as a paste (boundary)", () => {
    expect(detectPaste("same", "same")).toBe(false);
  });
});

describe("collapsePaste", () => {
  it("collapses text longer than the threshold into a numbered placeholder (normal)", () => {
    const pasted = Array.from({ length: 8 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    expect(pasted.length).toBeGreaterThan(PASTE_CHAR_THRESHOLD);

    const result = collapsePaste(pasted, PASTE_CHAR_THRESHOLD, 1);

    expect(result.fullText).toBe(pasted);
    expect(result.placeholder).toBe("[Pasted text #1: 8 lines]");
    expect(result.display).toBe(result.placeholder);
  });

  it("leaves text at or below the threshold unchanged (boundary)", () => {
    const pasted = "short";
    const result = collapsePaste(pasted, PASTE_CHAR_THRESHOLD, 1);
    expect(result.display).toBe(pasted);
    expect(result.placeholder).toBe(pasted);
    expect(result.fullText).toBe(pasted);
  });

  it("does not collapse text exactly at the threshold (boundary)", () => {
    const pasted = "x".repeat(PASTE_CHAR_THRESHOLD);

    expect(collapsePaste(pasted, PASTE_CHAR_THRESHOLD, 4)).toEqual({
      display: pasted,
      placeholder: pasted,
      fullText: pasted,
    });
  });

  it("uses a singular 'line' label for a one-line paste above threshold (boundary)", () => {
    const pasted = "x".repeat(PASTE_CHAR_THRESHOLD + 1);
    const result = collapsePaste(pasted, PASTE_CHAR_THRESHOLD, 2);
    expect(result.placeholder).toBe("[Pasted text #2: 1 line]");
  });
});

describe("expandPlaceholders — round-trip", () => {
  it("restores the original paste from a collapsed display (normal)", () => {
    const pasted = Array.from({ length: 6 }, (_, i) => `row ${i} ${"y".repeat(30)}`).join("\n");
    const collapsed = collapsePaste(pasted, PASTE_CHAR_THRESHOLD, 1);
    const submitted = expandPlaceholders(collapsed.display, [
      { placeholder: collapsed.placeholder, fullText: collapsed.fullText },
    ]);
    expect(submitted).toBe(pasted);
  });

  it("expands a placeholder embedded in surrounding text (normal)", () => {
    const pasted = "a".repeat(PASTE_CHAR_THRESHOLD + 10);
    const collapsed = collapsePaste(pasted, PASTE_CHAR_THRESHOLD, 3);
    const display = `prefix ${collapsed.placeholder} suffix`;
    const submitted = expandPlaceholders(display, [
      { placeholder: collapsed.placeholder, fullText: collapsed.fullText },
    ]);
    expect(submitted).toBe(`prefix ${pasted} suffix`);
  });

  it("expands every occurrence of a repeated placeholder (boundary)", () => {
    const pasted = "z".repeat(PASTE_CHAR_THRESHOLD + 1);
    const collapsed = collapsePaste(pasted, PASTE_CHAR_THRESHOLD, 5);
    const display = `${collapsed.placeholder} + ${collapsed.placeholder}`;

    expect(
      expandPlaceholders(display, [
        { placeholder: collapsed.placeholder, fullText: collapsed.fullText },
      ]),
    ).toBe(`${pasted} + ${pasted}`);
  });

  it("returns the display unchanged when no placeholder matches (error)", () => {
    expect(
      expandPlaceholders("plain text", [
        { placeholder: "[Pasted text #9: 2 lines]", fullText: "nope" },
      ]),
    ).toBe("plain text");
  });
});

describe("placeholderRangeAt — atomic delete", () => {
  it("returns the full placeholder span when the cursor is inside it (normal)", () => {
    const token = "[Pasted text #1: 4 lines]";
    const display = `go ${token} now`;
    const cursorInside = `go ${token}`.length - 2;
    const range = placeholderRangeAt(display, cursorInside, [token]);
    expect(range).toEqual({
      start: 3,
      end: 3 + token.length,
      placeholder: token,
    });
  });

  it("returns the span when the cursor sits just after the token (boundary — backspace)", () => {
    const token = "[Pasted text #1: 4 lines]";
    const display = `go ${token}`;
    const range = placeholderRangeAt(display, display.length, [token]);
    expect(range).toEqual({
      start: 3,
      end: display.length,
      placeholder: token,
    });
  });

  it("returns null when the cursor is not on a placeholder (boundary)", () => {
    const token = "[Pasted text #1: 4 lines]";
    expect(placeholderRangeAt(`go ${token}`, 1, [token])).toBeNull();
  });

  it("does not select a placeholder when the caret is immediately before it (boundary)", () => {
    const token = "[Pasted text #1: 4 lines]";

    expect(placeholderRangeAt(token, 0, [token])).toBeNull();
  });

  it("finds the correct occurrence when a placeholder is repeated (boundary)", () => {
    const token = "[Pasted text #1: 4 lines]";
    const display = `${token} + ${token}`;
    const secondStart = token.length + 3;

    expect(placeholderRangeAt(display, display.length, [token])).toEqual({
      start: secondStart,
      end: secondStart + token.length,
      placeholder: token,
    });
  });
});
