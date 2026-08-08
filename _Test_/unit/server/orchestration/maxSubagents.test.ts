/**
 * Unit tests — server orchestration/maxSubagents.ts
 */

import { describe, expect, it } from "vitest";
import {
  clampSubagentCap,
  isNumericCap,
  maxSubagentsConstraintText,
  parseMaxSubagentsPayload,
} from "../../../../packages/server/src/orchestration/maxSubagents.js";

describe("clampSubagentCap", () => {
  it("floors decimals and enforces minimum of 1", () => {
    expect(clampSubagentCap(4.9)).toBe(4);
    expect(clampSubagentCap(0)).toBe(1);
    expect(clampSubagentCap(-3)).toBe(1);
  });
});

describe("parseMaxSubagentsPayload", () => {
  it("parses special values", () => {
    expect(parseMaxSubagentsPayload(1)).toBe(1);
    expect(parseMaxSubagentsPayload("1")).toBe(1);
    expect(parseMaxSubagentsPayload(2)).toBe(2);
    expect(parseMaxSubagentsPayload("2")).toBe(2);
    expect(parseMaxSubagentsPayload("max")).toBe("max");
  });

  it("parses numeric and string numeric caps", () => {
    expect(parseMaxSubagentsPayload(5)).toBe(5);
    expect(parseMaxSubagentsPayload("7")).toBe(7);
  });

  it("defaults invalid values to 3", () => {
    expect(parseMaxSubagentsPayload("nope")).toBe(3);
    expect(parseMaxSubagentsPayload(null)).toBe(3);
    expect(parseMaxSubagentsPayload("")).toBe(3);
  });
});

describe("maxSubagentsConstraintText", () => {
  it("describes each cap style", () => {
    expect(maxSubagentsConstraintText(1)).toContain("focus");
    expect(maxSubagentsConstraintText(2)).toContain("collab");
    expect(maxSubagentsConstraintText("max")).toContain("unlimited");
    expect(maxSubagentsConstraintText(6)).toContain("up to 6 subagents");
  });
});

describe("isNumericCap", () => {
  it("is true only for numbers greater than 2", () => {
    expect(isNumericCap(3)).toBe(true);
    expect(isNumericCap(1)).toBe(false);
    expect(isNumericCap(2)).toBe(false);
    expect(isNumericCap("max")).toBe(false);
  });
});
