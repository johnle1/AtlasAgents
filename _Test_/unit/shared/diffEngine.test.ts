/**
 * Unit tests — packages/shared/src/diffEngine.ts
 */

import { describe, expect, it } from "vitest";
import {
  computeDiff,
  formatDiffPlain,
  getDiffDisplayLines,
} from "@loopycode/shared";

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
