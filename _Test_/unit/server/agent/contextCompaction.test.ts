/**
 * Unit tests — server orchestration/agent/contextCompaction.ts
 */

import { describe, expect, it } from "vitest";
import {
  applyCompaction,
  applyElisionFallback,
  buildCompactionRequest,
  COMPACTION_MARKER,
  DEFAULT_COMPACTION_BUDGET,
  ELISION_FALLBACK_TEXT,
  estimateMessagesTokens,
  selectCompactionRange,
  shouldCompact,
} from "../../../../packages/server/src/orchestration/agent/contextCompaction.js";
import type { Message } from "../../../../packages/server/src/orchestration/types.js";

const msg = (role: Message["role"], content: string): Message => ({ role, content });

describe("estimateMessagesTokens", () => {
  it("sums the 4-chars-per-token estimate across every message", () => {
    const messages = [msg("system", "a".repeat(40)), msg("user", "b".repeat(20))];
    // 40/4 + 20/4 = 15
    expect(estimateMessagesTokens(messages)).toBe(15);
  });

  it("returns 0 for an empty conversation", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

describe("shouldCompact", () => {
  it("is false under the 75% threshold, true at and above it", () => {
    expect(shouldCompact(74, 100)).toBe(false);
    expect(shouldCompact(75, 100)).toBe(false); // strictly greater-than
    expect(shouldCompact(76, 100)).toBe(true);
  });
});

describe("selectCompactionRange", () => {
  it("returns null when there aren't enough messages for a meaningful middle (boundary)", () => {
    // seed (protectedPrefixCount=2), plus up to 6 recent — 8 total is exactly the protected tail.
    const messages = Array.from({ length: 8 }, (_, i) => msg("user", `m${i}`));
    expect(selectCompactionRange(messages, 2)).toBeNull();
  });

  it("excludes the seed (system, task) and the last 6 messages, keeping only the true middle (normal)", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg("user", `m${i}`));
    const range = selectCompactionRange(messages, 2);
    expect(range).toEqual({ start: 2, end: 4 });
  });

  it("grows the compactable middle as the conversation grows further (normal)", () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg("user", `m${i}`));
    expect(selectCompactionRange(messages, 2)).toEqual({ start: 2, end: 14 });
  });

  it("respects a larger protectedPrefixCount when cross-turn history was seeded (normal)", () => {
    // seed = system + 2 history exchanges (4 messages) + current task = 6.
    const protectedPrefixCount = 6;
    const messages = Array.from({ length: 14 }, (_, i) => msg("user", `m${i}`));
    // Not enough middle yet: 14 - 6(protected) - 6(recent tail) = 2, so end
    // must be protectedPrefixCount + 2, not the old hardcoded start of 2.
    expect(selectCompactionRange(messages, protectedPrefixCount)).toEqual({
      start: 6,
      end: 8,
    });
  });

  it("returns null when the protected seed alone already covers everything but the recent tail (boundary)", () => {
    const protectedPrefixCount = 6;
    const messages = Array.from({ length: 12 }, (_, i) => msg("user", `m${i}`));
    expect(selectCompactionRange(messages, protectedPrefixCount)).toBeNull();
  });
});

describe("buildCompactionRequest", () => {
  it("builds a tool-less system+user pair summarizing the given messages", () => {
    const middle = [msg("assistant", "read a.ts"), msg("tool", "file contents...")];
    const request = buildCompactionRequest(middle);
    expect(request).toHaveLength(2);
    expect(request[0]?.role).toBe("system");
    expect(request[1]?.role).toBe("user");
    expect(request[1]?.content).toContain("read a.ts");
    expect(request[1]?.content).toContain("file contents...");
  });
});

describe("applyCompaction", () => {
  it("replaces the range with one marked summary message, leaving the rest untouched", () => {
    const messages = [
      msg("system", "sys"),
      msg("user", "task"),
      msg("assistant", "middle 1"),
      msg("tool", "middle 2"),
      msg("assistant", "recent"),
    ];
    applyCompaction(messages, { start: 2, end: 4 }, "did some stuff");
    expect(messages).toHaveLength(4);
    expect(messages[0]?.content).toBe("sys");
    expect(messages[1]?.content).toBe("task");
    expect(messages[2]?.content).toContain(COMPACTION_MARKER);
    expect(messages[2]?.content).toContain("did some stuff");
    expect(messages[3]?.content).toBe("recent");
  });

  it("caps an oversized summary rather than reinserting the same problem it exists to solve (boundary)", () => {
    const messages = [msg("system", "sys"), msg("user", "task"), msg("assistant", "middle")];
    const hugeSummary = "x".repeat(5000);
    applyCompaction(messages, { start: 2, end: 3 }, hugeSummary);
    expect(messages[2]!.content.length).toBeLessThan(hugeSummary.length);
  });
});

describe("applyElisionFallback", () => {
  it("replaces the range with the fallback marker and never throws", () => {
    const messages = [msg("system", "sys"), msg("user", "task"), msg("assistant", "middle")];
    applyElisionFallback(messages, { start: 2, end: 3 });
    expect(messages[2]?.content).toBe(ELISION_FALLBACK_TEXT);
  });
});

describe("DEFAULT_COMPACTION_BUDGET", () => {
  it("is a positive, sane fallback for an unresolved context window", () => {
    expect(DEFAULT_COMPACTION_BUDGET).toBeGreaterThan(0);
  });
});
