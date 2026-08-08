/**
 * Unit tests — agent think-block parsers (SELF-CHECK, plan sections).
 */

import { describe, expect, it } from "vitest";
import {
  buildAgentThinkInstruction,
  buildPlanFromLines,
  parseCommandPlan,
  parseCommandPlanGaps,
  parseParallelismGaps,
  parsePlanLines,
  parseRisks,
  parseVerifyGaps,
  stripAgentThink,
} from "../../../../packages/server/src/orchestration/agent/agentThink.js";

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

describe("buildAgentThinkInstruction", () => {
  it("replaces max subagents and agent rules placeholders", () => {
    const instruction = buildAgentThinkInstruction(1);
    expect(instruction).not.toContain("{MAX_SUBAGENTS}");
    expect(instruction).not.toContain("{AGENT_RULES}");
    expect(instruction).toContain("1 (focus");
    expect(instruction).toContain("agentId 1");
  });

  it("includes unlimited guidance for max", () => {
    const instruction = buildAgentThinkInstruction("max");
    expect(instruction).toContain("as many agents");
  });
});

describe("stripAgentThink", () => {
  it("removes think block and trims remainder", () => {
    const raw =
      '<agent-think>\nCOMPLEXITY: simple\n</agent-think>\n{"subtasks":[]}';
    expect(stripAgentThink(raw)).toBe('{"subtasks":[]}');
  });

  it("returns trimmed text when no think block", () => {
    expect(stripAgentThink("  plain output  ")).toBe("plain output");
  });
});

describe("parseCommandPlan", () => {
  it("extracts setup and verify commands from COMMAND PLAN", () => {
    const think = `
COMMAND PLAN:
  setup commands:
    npm ci
    - npm run build
  verify commands:
    npm test
`;
    expect(parseCommandPlan(think)).toEqual({
      setupCommands: ["npm ci", "npm run build"],
      verifyCommands: ["npm test"],
      runProjectCommands: [],
    });
  });

  it("filters none placeholders and markdown fences", () => {
    const think = `
COMMAND PLAN:
  setup commands: none
  verify commands:
\`\`\`
npm run lint
\`\`\`
`;
    expect(parseCommandPlan(think).setupCommands).toEqual([]);
    expect(parseCommandPlan(think).verifyCommands).toEqual(["npm run lint"]);
  });
});

describe("parseCommandPlanGaps", () => {
  it("flags missing verify commands for non-trivial tasks", () => {
    const think = `COMPLEXITY: simple
PLAN:
  execution: sequential
SELF-CHECK:
  issues? none
COMMAND PLAN:
  setup commands: none
  verify commands: none
`;
    expect(parseCommandPlanGaps(think)).toEqual({
      hasGaps: true,
      missingSummary: "verify commands",
    });
  });

  it("passes trivial tasks without verify commands", () => {
    const trivial = `<agent-think>
COMPLEXITY: trivial
PLAN:
  agent count: 1
COMMAND PLAN:
  setup commands: none
  verify commands: none
</agent-think>`;
    expect(parseCommandPlanGaps(trivial)).toEqual({
      hasGaps: false,
      missingSummary: "",
    });
  });
});

describe("parseParallelismGaps", () => {
  const parallelThink = (wavesLine: string): string =>
    `<agent-think>
PLAN:
  execution: parallel
${wavesLine}
</agent-think>`;

  it("returns no gaps for sequential execution", () => {
    expect(
      parseParallelismGaps(
        "execution: sequential",
        { subtasks: [{ id: 1, dependsOn: [] }] },
      ),
    ).toEqual({ hasGaps: false, missingSummary: "" });
  });

  it("flags missing waves when execution is parallel", () => {
    const result = parseParallelismGaps(
      parallelThink(""),
      {
        subtasks: [
          { id: 1, dependsOn: [] },
          { id: 2, dependsOn: [1] },
        ],
      },
    );
    expect(result.hasGaps).toBe(true);
    expect(result.missingSummary).toContain("waves section missing");
  });

  it("flags parallel claim with fully sequential JSON chain", () => {
    const result = parseParallelismGaps(
      parallelThink("waves:\n  Wave 1: [1, 2]"),
      {
        subtasks: [
          { id: 1, dependsOn: [] },
          { id: 2, dependsOn: [1] },
        ],
      },
    );
    expect(result.hasGaps).toBe(true);
    expect(result.missingSummary).toContain("chains onto the previous");
  });
});

describe("parseRisks", () => {
  it("returns an empty array (stub)", () => {
    expect(parseRisks("risks? something")).toEqual([]);
  });
});

describe("parsePlanLines", () => {
  it("extracts numbered steps from PLAN section", () => {
    const think = `<agent-think>
PLAN:
  Agent 1 — work:
    1. First step
    2. Second step
SELF-CHECK:
  issues? none
</agent-think>`;
    expect(parsePlanLines(think)).toEqual(["First step", "Second step"]);
  });

  it("skips placeholder steps", () => {
    const think = `<agent-think>
PLAN:
    1. none
    2. Real work
</agent-think>`;
    expect(parsePlanLines(think)).toEqual(["Real work"]);
  });
});

describe("buildPlanFromLines", () => {
  it("chains dependsOn sequentially with maxSubagents 1", () => {
    expect(buildPlanFromLines(["a", "b"], 1)).toEqual([
      { id: 1, text: "a", dependsOn: [], agentId: 1, agentLabel: "all tasks" },
      { id: 2, text: "b", dependsOn: [1], agentId: 1, agentLabel: "all tasks" },
    ]);
  });

  it("uses two agents when maxSubagents is 2", () => {
    const plan = buildPlanFromLines(["s1", "s2", "s3", "s4"], 2);
    expect(plan.map((s) => s.agentId)).toEqual([1, 1, 2, 2]);
    expect(plan[2]?.agentLabel).toBe("implementation");
  });

  it("filters empty lines", () => {
    expect(buildPlanFromLines(["  do work  ", "", "  "], 1)).toHaveLength(1);
  });
});
