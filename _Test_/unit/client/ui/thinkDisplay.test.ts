/**
 * Unit tests — packages/client/src/ui/thinkDisplay.ts
 *
 * Both helpers take dimensions as explicit parameters specifically so they
 * can be tested without touching `process.stdout` — see thinkDisplay.ts.
 */

import { describe, expect, it } from "vitest";
import {
  tailRows,
  thinkDisplayThreshold,
} from "../../../../packages/client/src/ui/thinkDisplay.js";

describe("thinkDisplayThreshold", () => {
  it("uses 10 chars at the 80-column reference point", () => {
    expect(thinkDisplayThreshold(80)).toBe(10);
  });

  it("scales UP for a narrower terminal, so it repaints less often (regression guard)", () => {
    // A narrow terminal wraps the same text into more rows, so each repaint
    // is more expensive — the threshold must grow, not shrink, as columns
    // drops, so fewer (bigger) repaints happen rather than more of them.
    expect(thinkDisplayThreshold(40)).toBe(20);
    expect(thinkDisplayThreshold(20)).toBe(40);
  });

  it("scales down for a wider terminal, where repaints are cheap", () => {
    expect(thinkDisplayThreshold(160)).toBe(8); // floor, not 20
  });

  it("never drops below the floor of 8, even for a very wide terminal", () => {
    expect(thinkDisplayThreshold(1000)).toBe(8);
  });

  it("never throws or produces a nonsensical value for degenerate widths", () => {
    expect(thinkDisplayThreshold(0)).toBeGreaterThanOrEqual(8);
    expect(thinkDisplayThreshold(-5)).toBeGreaterThanOrEqual(8);
  });
});

describe("tailRows", () => {
  /** Same row-counting rule tailRows itself uses, for assertions below. */
  const countRows = (text: string, columns: number): number =>
    text
      .split("\n")
      .reduce(
        (sum, line) =>
          sum +
          (line.length === 0
            ? 1
            : Math.ceil(line.length / Math.max(1, columns))),
        0,
      );

  it("returns the text unchanged when it already fits within maxRows", () => {
    expect(tailRows("short", 80, 5)).toBe("short");
    expect(tailRows("line1\nline2", 80, 5)).toBe("line1\nline2");
  });

  it("never returns more rows than maxRows, even accounting for the ellipsis marker's own row (regression guard)", () => {
    // The leading "…" was appended AFTER the row budget was already spent,
    // so a kept line that exactly filled maxRows gained one extra
    // character — and sometimes one extra wrapped row — the moment the
    // marker was prefixed to it. Sweep a range of shapes rather than one
    // fixed case, since the bug only showed up when the kept content
    // landed on an exact row boundary.
    for (const columns of [1, 2, 5, 10, 80]) {
      for (const maxRows of [1, 2, 3, 5]) {
        for (const totalChars of [1, 5, 10, 19, 20, 21, 30, 50, 100]) {
          const text = "x".repeat(totalChars);
          const result = tailRows(text, columns, maxRows);
          expect(countRows(result, columns)).toBeLessThanOrEqual(maxRows);
        }
      }
    }
  });

  it("keeps as many trailing whole lines as fit after reserving a row for the ellipsis", () => {
    expect(tailRows("a\nb\nc\nd", 80, 2)).toBe("…\nd");
  });

  it("treats each blank line as occupying one row", () => {
    expect(tailRows("a\n\n\n\nb", 80, 2)).toBe("…\nb");
  });

  it("handles text with no newlines at all (a single long paragraph)", () => {
    // 20 chars at 10 columns = 2 wrapped rows — fits exactly in maxRows=2.
    expect(tailRows("a".repeat(20), 10, 2)).toBe("a".repeat(20));
    // 30 chars at 10 columns = 3 wrapped rows — doesn't fit in maxRows=2.
    // Only 1 row (10 chars) is available for kept content once the
    // ellipsis's own row is reserved, so the result is 11 chars — not the
    // 21-char (3-row) result the pre-fix version returned.
    const result = tailRows("a".repeat(30), 10, 2);
    expect(result).toBe(`…${"a".repeat(10)}`);
    expect(countRows(result, 10)).toBe(2);
  });

  it("slices within a single line that alone exceeds the row budget", () => {
    // "aaaaaaaaaa" (10 chars) at 2 columns = 5 rows; maxRows=2 reserves 1
    // row for the marker, leaving 1 row = 2 chars for kept content.
    const result = tailRows("aaaaaaaaaa", 2, 2);
    expect(result).toBe("…aa");
    expect(countRows(result, 2)).toBe(2);
  });

  it("is a no-op on an empty string", () => {
    expect(tailRows("", 80, 5)).toBe("");
  });

  it("never negatively indexes for degenerate columns/maxRows inputs", () => {
    expect(() => tailRows("some text", 0, 0)).not.toThrow();
    expect(() => tailRows("some text", -5, -5)).not.toThrow();
  });
});
