/**
 * Unit tests — patternHelpers.ts (JSON extraction, diffs, scope, confidence).
 */

import { describe, expect, it } from "vitest";
import {
  errorKeywords,
  extractJsonArray,
  formatUserEditForPrompt,
  parseConfidence,
  plainDiffFromEdit,
  sampleUserEdits,
  scopeFromPath,
  topicsFromPath,
  truncate,
} from "../../../../packages/server/src/memory/pattern/patternHelpers.js";
import { MAX_USER_EDITS_IN_PROMPT } from "../../../../packages/server/src/memory/pattern/patternConstants.js";
import type { UserEditEntry } from "../../../../packages/server/src/memory/types.js";

const userEdit = (overrides: Partial<UserEditEntry> = {}): UserEditEntry => ({
  path: "src/foo.ts",
  before: "old",
  after: "new",
  timestamp: "2024-01-01T00:00:00.000Z",
  ...overrides,
});

describe("extractJsonArray", () => {
  it("extracts array from markdown json fence", () => {
    const raw = '```json\n[{"text": "rule"}]\n```';
    expect(extractJsonArray(raw)).toBe('[{"text": "rule"}]');
  });

  it("extracts array embedded in conversational text", () => {
    expect(extractJsonArray('Here: [{"a": 1}, {"b": 2}] end')).toBe(
      '[{"a": 1}, {"b": 2}]',
    );
  });

  it("returns body unchanged when no array brackets", () => {
    expect(extractJsonArray("not json at all")).toBe("not json at all");
  });
});

describe("truncate", () => {
  it("returns text unchanged when within max", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates with ellipsis when over max", () => {
    expect(truncate("abcdefghijklmnop", 5)).toBe("abcde…");
  });
});

describe("plainDiffFromEdit", () => {
  it("includes file path and diff lines", () => {
    const diff = plainDiffFromEdit("line-a", "line-b", "pkg/x.ts");
    expect(diff).toContain("pkg/x.ts");
    expect(diff).toContain("line-a");
    expect(diff).toContain("line-b");
  });

  it("applies maxLen via truncate", () => {
    const longBefore = "x".repeat(500);
    const longAfter = "y".repeat(500);
    const diff = plainDiffFromEdit(longBefore, longAfter, "big.txt", 20);
    expect(diff.endsWith("…")).toBe(true);
    expect(diff.length).toBeLessThanOrEqual(21);
  });
});

describe("formatUserEditForPrompt", () => {
  it("formats path and indented diff block", () => {
    const block = formatUserEditForPrompt(userEdit());
    expect(block).toMatch(/^- src\/foo\.ts\n  Diff:\n/);
    expect(block).toContain("    ");
  });
});

describe("sampleUserEdits", () => {
  it("returns all edits when within limit", () => {
    const edits = [userEdit({ path: "a.ts" }), userEdit({ path: "b.ts" })];
    expect(sampleUserEdits(edits)).toEqual({ edits, omitted: 0 });
  });

  it("samples first N and reports omitted count", () => {
    const edits = Array.from({ length: MAX_USER_EDITS_IN_PROMPT + 3 }, (_, i) =>
      userEdit({ path: `f${i}.ts` }),
    );
    const result = sampleUserEdits(edits);
    expect(result.edits).toHaveLength(MAX_USER_EDITS_IN_PROMPT);
    expect(result.omitted).toBe(3);
    expect(result.edits[0]?.path).toBe("f0.ts");
  });
});

describe("scopeFromPath", () => {
  it("maps TypeScript extensions", () => {
    expect(scopeFromPath("src/index.ts")).toBe("typescript");
    expect(scopeFromPath("App.tsx")).toBe("typescript");
  });

  it("falls back to all for unknown extensions", () => {
    expect(scopeFromPath("README.md")).toBe("all");
  });
});

describe("topicsFromPath", () => {
  it("returns language scope as single topic", () => {
    expect(topicsFromPath("main.py")).toEqual(["python"]);
  });

  it("returns empty array when scope is all", () => {
    expect(topicsFromPath("notes.txt")).toEqual([]);
  });
});

describe("errorKeywords", () => {
  it("extracts deduplicated lowercase tokens of length 3+", () => {
    expect(errorKeywords("TypeError: Cannot read property")).toEqual([
      "typeerror",
      "cannot",
      "read",
      "property",
    ]);
  });

  it("preserves c++ and limits to eight tokens", () => {
    const keywords = errorKeywords(
      "C++ compilation failed with many extra words here and there again",
    );
    expect(keywords[0]).toBe("c++");
    expect(keywords.length).toBeLessThanOrEqual(8);
  });
});

describe("parseConfidence", () => {
  it("accepts high, medium, low", () => {
    expect(parseConfidence("high")).toBe("high");
    expect(parseConfidence("medium")).toBe("medium");
    expect(parseConfidence("low")).toBe("low");
  });

  it("defaults invalid values to medium", () => {
    expect(parseConfidence("invalid")).toBe("medium");
    expect(parseConfidence(null)).toBe("medium");
  });
});
