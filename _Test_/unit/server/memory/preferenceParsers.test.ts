/**
 * Unit tests — server memory/preference/preferenceParsers.ts
 */

import { describe, expect, it } from "vitest";
import {
  higherConfidence,
  normaliseFile,
  normaliseRule,
  parseConfidence,
  parseSource,
} from "../../../../packages/server/src/memory/preference/preferenceParsers.js";

describe("parseConfidence", () => {
  it("accepts valid confidence levels", () => {
    expect(parseConfidence("high")).toBe("high");
    expect(parseConfidence("medium")).toBe("medium");
    expect(parseConfidence("low")).toBe("low");
  });

  it("defaults to medium for invalid or missing values", () => {
    expect(parseConfidence("INVALID")).toBe("medium");
    expect(parseConfidence(null)).toBe("medium");
    expect(parseConfidence(42)).toBe("medium");
  });
});

describe("parseSource", () => {
  it("accepts valid sources", () => {
    expect(parseSource("explicit")).toBe("explicit");
    expect(parseSource("outcome")).toBe("outcome");
    expect(parseSource("fix")).toBe("fix");
    expect(parseSource("style")).toBe("style");
  });

  it("defaults to explicit for invalid or missing values", () => {
    expect(parseSource("unknown")).toBe("explicit");
    expect(parseSource(undefined)).toBe("explicit");
  });
});

describe("higherConfidence", () => {
  it("returns the greater of two levels", () => {
    expect(higherConfidence("low", "high")).toBe("high");
    expect(higherConfidence("high", "medium")).toBe("high");
  });

  it("returns the first argument on a tie", () => {
    expect(higherConfidence("medium", "medium")).toBe("medium");
    expect(higherConfidence("low", "low")).toBe("low");
  });
});

describe("normaliseRule", () => {
  const valid = {
    id: "rule-1",
    text: "Use strict mode",
    timestamp: "2025-01-01T00:00:00Z",
  };

  it("returns a fully normalised rule for valid input", () => {
    const rule = normaliseRule({
      ...valid,
      topics: ["typescript", 42, "react"],
      scope: "typescript",
      confidence: "high",
      source: "outcome",
      timesApplied: 3.7,
    });
    expect(rule).toEqual({
      id: "rule-1",
      text: "Use strict mode",
      topics: ["typescript", "react"],
      scope: "typescript",
      confidence: "high",
      source: "outcome",
      timestamp: "2025-01-01T00:00:00Z",
      timesApplied: 3,
    });
  });

  it("accepts createdAt instead of timestamp", () => {
    const rule = normaliseRule({
      id: "a",
      text: "rule",
      createdAt: "2025-06-01T00:00:00Z",
    });
    expect(rule?.timestamp).toBe("2025-06-01T00:00:00Z");
  });

  it("returns null when required fields are missing", () => {
    expect(normaliseRule(null)).toBeNull();
    expect(normaliseRule({ text: "no id" })).toBeNull();
    expect(normaliseRule({ id: "x", text: "", timestamp: "t" })).toBeNull();
  });
});

describe("normaliseFile", () => {
  it("normalises valid rules and drops invalid rows", () => {
    const file = normaliseFile({
      rules: [
        { id: "a", text: "ok", timestamp: "2025-01-01T00:00:00Z" },
        { text: "missing id" },
      ],
    });
    expect(file.version).toBe(1);
    expect(file.rules).toHaveLength(1);
    expect(file.rules[0]?.id).toBe("a");
  });

  it("returns an empty rules array for invalid structure", () => {
    expect(normaliseFile({ invalid: true }).rules).toEqual([]);
    expect(normaliseFile(null).rules).toEqual([]);
  });
});
