/**
 * Unit tests — server memory/context/contextHelpers.ts
 */

import { describe, expect, it } from "vitest";
import {
  approxTokens,
  extractKeywords,
  resolveContextLength,
  sortRules,
  truncateToTokenBudget,
} from "../../../../packages/server/src/memory/context/contextHelpers.js";
import { DEFAULT_CONTEXT_WINDOW } from "../../../../packages/server/src/memory/context/contextConstants.js";
import type { LanguageHint } from "../../../../packages/server/src/orchestration/interfaces/preferenceInterfaces.js";
import type { PreferenceRule } from "../../../../packages/server/src/orchestration/interfaces/preferenceInterfaces.js";

describe("approxTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(approxTokens("")).toBe(0);
  });

  it("rounds up using one token per four characters", () => {
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
    expect(approxTokens("hello world")).toBe(3);
  });
});

describe("extractKeywords", () => {
  const hints: LanguageHint[] = [
    { needle: "typescript", tag: "typescript" },
    { needle: "react", tag: "react" },
  ];

  it("keeps meaningful words and drops short tokens and stop words", () => {
    const keywords = extractKeywords("Fix the bug in xy module", hints);
    expect(keywords.has("the")).toBe(false);
    expect(keywords.has("xy")).toBe(false); // length < 3
    expect(keywords.has("fix")).toBe(true);
    expect(keywords.has("bug")).toBe(true);
    expect(keywords.has("module")).toBe(true);
  });

  it("adds language tags when hints match the task text", () => {
    const keywords = extractKeywords("Refactor TypeScript component", hints);
    expect(keywords.has("typescript")).toBe(true);
    expect(keywords.has("refactor")).toBe(true);
  });

  it("preserves compound tokens with + (symbols kept in tokenisation)", () => {
    const keywords = extractKeywords("Upgrade C++ codebase", hints);
    expect(keywords.has("c++")).toBe(true);
    expect(keywords.has("codebase")).toBe(true);
  });
});

describe("resolveContextLength", () => {
  it("uses top-level context_length when valid", () => {
    expect(resolveContextLength({ context_length: 8192 } as never)).toBe(8192);
    expect(resolveContextLength({ context_length: 4096.9 } as never)).toBe(4096);
  });

  it("ignores invalid top-level values and falls through", () => {
    expect(
      resolveContextLength({
        context_length: 0,
        model_info: { "llama.context_length": 2048 },
      } as never),
    ).toBe(2048);
  });

  it("reads nested model_info keys ending with context_length", () => {
    expect(
      resolveContextLength({
        model_info: { "custom.context_length": 16384 },
      } as never),
    ).toBe(16384);
  });

  it("falls back to DEFAULT_CONTEXT_WINDOW when metadata is missing", () => {
    expect(resolveContextLength({} as never)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextLength({ context_length: -1 } as never)).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });
});

const rule = (overrides: Partial<PreferenceRule> = {}): PreferenceRule => ({
  id: "id",
  text: "rule text",
  topics: [],
  scope: "all",
  confidence: "medium",
  source: "outcome",
  timestamp: "2025-01-01T00:00:00Z",
  timesApplied: 1,
  ...overrides,
});

describe("sortRules", () => {
  it("ranks a cheap, less-used rule above an expensive, more-used one when density favors it", () => {
    // Old behavior (raw timesApplied) would put `expensive` first (5 > 2).
    // Density = timesApplied / tokens: expensive is long enough that its
    // density loses to the short rule's, even though its raw count is higher.
    const cheap = rule({
      id: "cheap",
      text: "short",
      timesApplied: 2,
      timestamp: "2025-01-01T00:00:00Z",
    });
    const expensive = rule({
      id: "expensive",
      text: "x".repeat(400), // ~100 tokens -> density 5/100 = 0.05
      timesApplied: 5,
      timestamp: "2025-01-02T00:00:00Z",
    });

    const sorted = sortRules([expensive, cheap]);

    expect(sorted.map((r) => r.id)).toEqual(["cheap", "expensive"]);
  });

  it("breaks exact density ties by oldest timestamp first", () => {
    const older = rule({
      id: "older",
      text: "same length text",
      timesApplied: 4,
      timestamp: "2025-01-01T00:00:00Z",
    });
    const newer = rule({
      id: "newer",
      text: "same length text",
      timesApplied: 4,
      timestamp: "2025-02-01T00:00:00Z",
    });

    const sorted = sortRules([newer, older]);

    expect(sorted.map((r) => r.id)).toEqual(["older", "newer"]);
  });

  it("does not mutate the input array", () => {
    const original = [
      rule({ id: "a", timesApplied: 1 }),
      rule({ id: "b", timesApplied: 9 }),
    ];
    const originalOrder = original.map((r) => r.id);

    sortRules(original);

    expect(original.map((r) => r.id)).toEqual(originalOrder);
  });

  it("ranks a high-confidence rule above a low-confidence one at equal usage and cost", () => {
    // Same text (same token cost) and same timesApplied => density differs
    // only by the confidence weight, isolating that one term.
    const low = rule({ id: "low", text: "same text", timesApplied: 0, confidence: "low" });
    const high = rule({ id: "high", text: "same text", timesApplied: 0, confidence: "high" });

    const sorted = sortRules([low, high]);

    expect(sorted.map((r) => r.id)).toEqual(["high", "low"]);
  });

  it("lets accumulated usage outrank a lower-confidence rule (log1p, not linear)", () => {
    // A "low" confidence rule applied many times should still be able to
    // outrank a "high" confidence rule that has never been applied — usage
    // is a real signal too, not just a tiebreaker under confidence.
    const provenLow = rule({
      id: "proven-low",
      text: "same text",
      timesApplied: 1000,
      confidence: "low",
    });
    const unprovenHigh = rule({
      id: "unproven-high",
      text: "same text",
      timesApplied: 0,
      confidence: "high",
    });

    const sorted = sortRules([unprovenHigh, provenLow]);

    expect(sorted.map((r) => r.id)).toEqual(["proven-low", "unproven-high"]);
  });

  it("still breaks exact ties by oldest timestamp when confidence and usage are both equal", () => {
    const older = rule({
      id: "older",
      text: "same length text",
      timesApplied: 4,
      confidence: "high",
      timestamp: "2025-01-01T00:00:00Z",
    });
    const newer = rule({
      id: "newer",
      text: "same length text",
      timesApplied: 4,
      confidence: "high",
      timestamp: "2025-02-01T00:00:00Z",
    });

    const sorted = sortRules([newer, older]);

    expect(sorted.map((r) => r.id)).toEqual(["older", "newer"]);
  });
});

describe("truncateToTokenBudget", () => {
  it("returns the body unchanged when it already fits the budget", () => {
    const body = "line one\nline two";
    const result = truncateToTokenBudget(body, "- doc.md\n", 1000);
    expect(result).toBe(body);
  });

  it("returns an empty string when the budget is exhausted entirely", () => {
    const result = truncateToTokenBudget(
      "line one\nline two",
      "- a-very-long-header-that-eats-the-whole-budget.md\n",
      1,
    );
    expect(result).toBe("");
  });

  it("cuts at the last newline within the character budget, never mid-line", () => {
    const body = "AAAA\nBBBB\nCCCC\nDDDD";
    // maxBodyChars = tokenBudget*4 - header.length = 3*4 - 0 = 12, which
    // lands inside "CCCC" (the 3rd line) — must back off to the newline
    // before it, keeping only the first two complete lines.
    const result = truncateToTokenBudget(body, "", 3);
    expect(result).toBe("AAAA\nBBBB");
  });

  it("returns an empty string when no newline exists within the budget", () => {
    const body = "a".repeat(500); // one unbroken line, far exceeds any small budget
    const result = truncateToTokenBudget(body, "", 5);
    expect(result).toBe("");
  });
});
