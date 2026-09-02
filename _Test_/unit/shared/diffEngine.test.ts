/**
 * Unit tests — packages/shared/src/diffEngine.ts
 */

import { describe, expect, it } from "vitest";
import {
  computeDiff,
  formatDiffPlain,
  getDiffDisplayLines,
  getDiffStats,
} from "@atlasagents/shared";

describe("computeDiff", () => {
  it("returns equal chunks for identical content", () => {
    const chunks = computeDiff("line1\nline2", "line1\nline2");
    expect(chunks.every((c) => !c.added && !c.removed)).toBe(true);
  });

  it("detects pure addition", () => {
    const chunks = computeDiff("", "new line");
    expect(chunks.some((c) => c.added)).toBe(true);
  });

  it("detects pure deletion", () => {
    const chunks = computeDiff("old line", "");
    expect(chunks.some((c) => c.removed)).toBe(true);
  });

  it("detects mixed changes", () => {
    const chunks = computeDiff("keep\nold", "keep\nnew");
    expect(chunks.some((c) => c.added || c.removed)).toBe(true);
  });
});

describe("formatDiffPlain", () => {
  it("includes file header when filePath is provided", () => {
    const chunks = computeDiff("a", "b");
    const output = formatDiffPlain(chunks, "foo.ts");
    expect(output.startsWith("File: foo.ts\n\n")).toBe(true);
  });

  it("omits header when filePath is omitted", () => {
    const chunks = computeDiff("a", "b");
    const output = formatDiffPlain(chunks);
    expect(output.startsWith("File:")).toBe(false);
  });

  it("returns empty body for identical content", () => {
    const chunks = computeDiff("same", "same");
    expect(formatDiffPlain(chunks)).toBe("");
  });

  it("shows context lines within 3-line radius", () => {
    const prefix = Array.from(
      { length: 10 },
      (_, i) => `line-${String(i + 1).padStart(3, "0")}`,
    );
    const original = [...prefix, "ctx-near", "old", "ctx-after"].join("\n");
    const proposed = [...prefix, "ctx-near", "new", "ctx-after"].join("\n");
    const output = formatDiffPlain(computeDiff(original, proposed));
    expect(output).toContain("ctx-near");
    expect(output).toContain("ctx-after");
    expect(output).not.toContain("line-001");
    expect(output).not.toContain("line-005");
    expect(output).toContain("line-010");
  });
});

describe("getDiffDisplayLines", () => {
  it("returns added, removed, and context kinds", () => {
    const original = ["ctx-before", "old", "ctx-after"].join("\n");
    const proposed = ["ctx-before", "new", "ctx-after"].join("\n");
    const lines = getDiffDisplayLines(computeDiff(original, proposed));
    expect(lines.some((l) => l.kind === "added")).toBe(true);
    expect(lines.some((l) => l.kind === "removed")).toBe(true);
    expect(lines.some((l) => l.kind === "context")).toBe(true);
  });

  it("assigns line numbers on added rows", () => {
    const lines = getDiffDisplayLines(computeDiff("", "only"));
    const added = lines.find((l) => l.kind === "added");
    expect(added?.lineNum).toBe(1);
  });

  it("omits equal rows far from changes", () => {
    const original = [
      "far1",
      "far2",
      "far3",
      "far4",
      "far5",
      "far6",
      "far7",
      "near",
      "old",
      "after",
    ].join("\n");
    const proposed = [
      "far1",
      "far2",
      "far3",
      "far4",
      "far5",
      "far6",
      "far7",
      "near",
      "new",
      "after",
    ].join("\n");
    const lines = getDiffDisplayLines(computeDiff(original, proposed));
    expect(lines.some((l) => l.text === "far1")).toBe(false);
    expect(lines.some((l) => l.text === "near")).toBe(true);
  });
});

describe("getDiffStats", () => {
  it("returns zero for identical content", () => {
    const stats = getDiffStats(computeDiff("a\nb\n", "a\nb\n"));
    expect(stats).toEqual({ added: 0, removed: 0 });
  });

  it("counts a pure addition", () => {
    const stats = getDiffStats(computeDiff("a\n", "a\nb\nc\n"));
    expect(stats).toEqual({ added: 2, removed: 0 });
  });

  it("counts a pure deletion", () => {
    const stats = getDiffStats(computeDiff("a\nb\nc\n", "a\n"));
    expect(stats).toEqual({ added: 0, removed: 2 });
  });

  it("counts mixed additions and removals across multiple hunks", () => {
    const original = "keep1\nold1\nold2\nkeep2\nold3\n";
    const proposed = "keep1\nnew1\nkeep2\nnew2\nnew3\nnew4\n";
    const stats = getDiffStats(computeDiff(original, proposed));
    // old1, old2, old3 removed (3); new1, new2, new3, new4 added (4).
    expect(stats).toEqual({ added: 4, removed: 3 });
  });

  it("counts total added/removed lines regardless of getDiffDisplayLines's context-window trimming (regression guard)", () => {
    // A change far from any other change would have its surrounding equal
    // rows trimmed by getDiffDisplayLines's 3-line radius, but the changed
    // row itself is never trimmed — getDiffStats must agree on the total
    // either way, since it counts straight from the raw chunks.
    const original = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const proposed = original.replace("line10", "changed");
    const stats = getDiffStats(computeDiff(original, proposed));
    expect(stats).toEqual({ added: 1, removed: 1 });
  });
});
