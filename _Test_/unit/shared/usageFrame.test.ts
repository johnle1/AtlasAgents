/**
 * Unit tests — shared usage TaskFrame encode/decode.
 *
 * Additive wire kind: old clients must keep decoding unknown kinds, and
 * the new `usage` kind must round-trip.
 *
 * Category checklist:
 * - Normal: usage frame round-trips
 * - Boundary: usedTokens = 0 and usedTokens = contextWindow
 * - Error: unknown-kind tolerance is unchanged
 */

import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, type TaskFrame } from "@atlasagents/shared";

const roundTrip = (frame: TaskFrame): TaskFrame | null =>
  decodeFrame(encodeFrame(frame));

describe("usage frame", () => {
  it("round-trips usedTokens and contextWindow (normal)", () => {
    const frame: TaskFrame = {
      kind: "usage",
      usedTokens: 1_200,
      contextWindow: 4_096,
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("round-trips a zero-used window (boundary)", () => {
    expect(
      roundTrip({ kind: "usage", usedTokens: 0, contextWindow: 4096 }),
    ).toEqual({ kind: "usage", usedTokens: 0, contextWindow: 4096 });
  });

  it("round-trips a full window (boundary)", () => {
    expect(
      roundTrip({ kind: "usage", usedTokens: 8192, contextWindow: 8192 }),
    ).toEqual({ kind: "usage", usedTokens: 8192, contextWindow: 8192 });
  });
});

describe("decodeFrame unknown-kind tolerance (preserved)", () => {
  it("still decodes a future kind rather than throwing (error / forward-compat)", () => {
    const decoded = decodeFrame(Buffer.from('{"kind":"future-kind","x":1}'));
    expect(decoded).toEqual({ kind: "future-kind", x: 1 });
  });
});
