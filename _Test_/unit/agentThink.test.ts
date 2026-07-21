/**
 * Unit tests — agent think-block parsers (SELF-CHECK, plan sections).
 */

import { describe, expect, it } from "vitest";
import { parseVerifyGaps } from "../../packages/server/src/orchestration/agent/agentThink.js";

const thinkWithSelfCheck = (selfCheckBody: string): string =>
  `<agent-think>
COMPLEXITY: simple
  reasoning: a few sequential steps in one agent
PLAN:
  agent count: 1
  execution: sequential
  Agent 1 — work:
    1. do work
SELF-CHECK:
  ${selfCheckBody}
COMMAND PLAN:
  setup commands: none
  verify commands: npm test
</agent-think>`;

describe("parseVerifyGaps", () => {
  it("passes when issues? none", () => {
    expect(parseVerifyGaps(thinkWithSelfCheck("issues? none"))).toEqual({
      hasGaps: false,
      missingSummary: "",
    });
  });

  it("passes when file conflicts? none is present alongside issues? none", () => {
    expect(
      parseVerifyGaps(
        thinkWithSelfCheck(
          "issues? none\n  file conflicts? none\n  wave assumptions? none",
        ),
      ),
    ).toEqual({
      hasGaps: false,
      missingSummary: "",
    });
  });

  it("passes when the model notes an inline fix with [added ...]", () => {
    expect(
      parseVerifyGaps(
        thinkWithSelfCheck(
          "issues? [added verify command to COMMAND PLAN above]",
        ),
      ),
    ).toEqual({
      hasGaps: false,
      missingSummary: "",
    });
  });

  it("passes when the model says it fixed something in PLAN", () => {
    expect(
      parseVerifyGaps(
        thinkWithSelfCheck("issues? added npm test to verify commands"),
      ),
    ).toEqual({
      hasGaps: false,
      missingSummary: "",
    });
  });

  it("flags unresolved issues explicitly marked unresolved:", () => {
    const result = parseVerifyGaps(
      thinkWithSelfCheck("issues? unresolved: missing verify commands"),
    );
    expect(result.hasGaps).toBe(true);
    expect(result.missingSummary).toContain("unresolved");
  });

  it("flags legacy wording that still says something is missing", () => {
    const result = parseVerifyGaps(
      thinkWithSelfCheck("issues? still missing verify commands"),
    );
    expect(result.hasGaps).toBe(true);
  });

  it("skips SELF-CHECK for COMPLEXITY trivial tasks", () => {
    const trivial = `<agent-think>
COMPLEXITY: trivial
  reasoning: single typo fix
EXPLORATION: n/a — trivial, skipped
PLAN:
  agent count: 1
  execution: sequential
  Agent 1 — fix:
    1. fix typo
  waves: n/a — trivial, skipped
SELF-CHECK:
  issues? none
</agent-think>`;
    expect(parseVerifyGaps(trivial)).toEqual({
      hasGaps: false,
      missingSummary: "",
    });
  });

  it("still treats legacy TASK SIZE trivial as trivial", () => {
    const legacyTrivial = `<agent-think>
TASK SIZE: trivial
PLAN:
  agent count: 1
  execution: sequential
  Agent 1 — fix:
    1. fix typo
</agent-think>`;
    expect(parseVerifyGaps(legacyTrivial)).toEqual({
      hasGaps: false,
      missingSummary: "",
    });
  });
});
