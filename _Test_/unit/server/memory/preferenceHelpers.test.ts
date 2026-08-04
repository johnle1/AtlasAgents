/**
 * Unit tests — server memory/preference/preferenceHelpers.ts
 *
 * Covers the token-set similarity primitives introduced for the inverted-index
 * dedup search: jaccardFromTokenSets (extracted from textSimilarity) and
 * passesLengthFilter (the O(1) pre-filter before an exact Jaccard check).
 *
 * Category checklist:
 * - Normal: identical/partial/disjoint token sets, mid-range length filter
 * - Boundary: both-empty, one-empty, exact threshold sizes
 */

import { describe, expect, it } from "vitest";
import {
  jaccardFromTokenSets,
  passesLengthFilter,
  textSimilarity,
  tokenise,
} from "../../../../packages/server/src/memory/preference/preferenceHelpers.js";

describe("jaccardFromTokenSets", () => {
  it("returns 1 for identical non-empty sets", () => {
    const set = new Set(["typescript", "strict"]);
    expect(jaccardFromTokenSets(set, new Set(set))).toBe(1);
  });

  it("returns 1 when both sets are empty", () => {
    expect(jaccardFromTokenSets(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when exactly one set is empty", () => {
    expect(jaccardFromTokenSets(new Set(["a"]), new Set())).toBe(0);
    expect(jaccardFromTokenSets(new Set(), new Set(["a"]))).toBe(0);
  });

  it("computes partial overlap correctly regardless of argument order", () => {
    const a = new Set(["alpha", "bravo", "charlie"]);
    const b = new Set(["alpha", "bravo", "delta"]);
    // intersection={alpha,bravo}=2, union={alpha,bravo,charlie,delta}=4 => 0.5
    expect(jaccardFromTokenSets(a, b)).toBe(0.5);
    expect(jaccardFromTokenSets(b, a)).toBe(0.5);
  });

  it("returns 0 for completely disjoint sets", () => {
    expect(jaccardFromTokenSets(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
});

describe("textSimilarity", () => {
  it("delegates to jaccardFromTokenSets via tokenise", () => {
    const textA = "Use TypeScript strict mode";
    const textB = "Use TypeScript loose mode";
    expect(textSimilarity(textA, textB)).toBe(
      jaccardFromTokenSets(tokenise(textA), tokenise(textB)),
    );
  });
});

describe("passesLengthFilter", () => {
  it("accepts a candidate whose size could reach the threshold", () => {
    // For target=10, threshold=0.8: valid range is [8, 12]
    expect(passesLengthFilter(10, 10, 0.8)).toBe(true);
    expect(passesLengthFilter(8, 10, 0.8)).toBe(true);
    expect(passesLengthFilter(12, 10, 0.8)).toBe(true);
  });

  it("rejects a candidate outside the size range for the threshold", () => {
    expect(passesLengthFilter(7, 10, 0.8)).toBe(false);
    expect(passesLengthFilter(13, 10, 0.8)).toBe(false);
  });

  it("only accepts an empty candidate when the target is also empty", () => {
    expect(passesLengthFilter(0, 0, 0.8)).toBe(true);
    expect(passesLengthFilter(0, 5, 0.8)).toBe(false);
  });

  it("is a valid pre-filter: never rejects a pair that actually clears the threshold", () => {
    // Property-style spot check across a range of set-size combinations.
    for (let targetSize = 1; targetSize <= 20; targetSize += 1) {
      for (let candidateSize = 1; candidateSize <= 20; candidateSize += 1) {
        // Best-case Jaccard for these sizes: full overlap of the smaller into the larger.
        const bestCaseJaccard =
          Math.min(targetSize, candidateSize) / Math.max(targetSize, candidateSize);
        if (bestCaseJaccard >= 0.8) {
          expect(passesLengthFilter(candidateSize, targetSize, 0.8)).toBe(true);
        }
      }
    }
  });
});
