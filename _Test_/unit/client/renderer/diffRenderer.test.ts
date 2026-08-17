/**
 * Unit tests — packages/client/src/diff/diffRenderer.ts
 */

import { describe, expect, it, vi } from "vitest";
import { computeDiff } from "@atlasagents/shared";
import {
  injectBackground,
  parseDisplayLine,
  renderDiff,
  renderDiffFromChunks,
  stripAnsi,
  visibleLength,
} from "../../../../packages/client/src/diff/diffRenderer.js";

vi.mock("../../../../packages/client/src/diff/shikiHighlighter.js", () => ({
  highlightLine: vi.fn(async (code: string) => code),
  initShiki: vi.fn(async () => {}),
}));

describe("stripAnsi", () => {
  it("removes CSI color sequences", () => {
    expect(stripAnsi("\x1b[32mhi\x1b[0m")).toBe("hi");
  });
});

describe("visibleLength", () => {
  it("counts characters without escape codes", () => {
    expect(visibleLength("\x1b[31mx\x1b[0m")).toBe(1);
  });
});

describe("injectBackground", () => {
  it("returns background only for empty highlighted text", () => {
    expect(injectBackground("", "\x1b[42m")).toBe("\x1b[42m");
  });

  it("re-injects background after each reset", () => {
    const bg = "\x1b[42m";
    expect(injectBackground("\x1b[32mfoo\x1b[0mbar", bg)).toBe(
      `\x1b[32mfoo\x1b[0m${bg}bar`,
    );
  });
});

describe("parseDisplayLine", () => {
  it("parses added lines", () => {
    expect(parseDisplayLine("  12  + const x = 1")).toEqual({
      kind: "added",
      lineNum: 12,
      text: "const x = 1",
    });
  });

  it("parses removed lines", () => {
    expect(parseDisplayLine("   3  - old")).toEqual({
      kind: "removed",
      lineNum: 3,
      text: "old",
    });
  });

  it("parses context lines", () => {
    expect(parseDisplayLine("  10    context")).toEqual({
      kind: "context",
      lineNum: 10,
      text: "context",
    });
  });

  it("returns null for headers", () => {
    expect(parseDisplayLine("@@ -1,1 +1,1 @@")).toBeNull();
    expect(parseDisplayLine("+++ b/file.ts")).toBeNull();
  });
});

describe("renderDiffFromChunks", () => {
  it("renders ANSI output for a simple change", async () => {
    const chunks = computeDiff("old", "new");
    const out = await renderDiffFromChunks("file.ts", chunks);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/\+|new|-/);
  });
});

describe("renderDiff", () => {
  it("renders plain diff text with fallback for headers", async () => {
    const plain = "+++ a\n--- b\n  1  + added\n";
    const out = await renderDiff("x.ts", plain);
    expect(out).toContain("+++");
    expect(stripAnsi(out)).toContain("added");
  });

  it("preserves empty lines", async () => {
    const out = await renderDiff("x.ts", "line one\n\nline two");
    expect(out.split("\n").length).toBeGreaterThanOrEqual(2);
  });
});
