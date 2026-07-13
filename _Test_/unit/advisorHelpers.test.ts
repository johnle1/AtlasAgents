import { describe, expect, it } from "vitest";
import {
  contextHasWorkspaceStructure,
  extractJsonObject,
  extractThinkTextForPlan,
  normaliseAdvisorPlan,
  summarizeWorkspaceStackHint,
  tryParseAdvisorJson,
} from "../../packages/server/src/orchestration/advisor/advisorHelpers.js";

describe("extractJsonObject", () => {
  it("extracts JSON from a markdown fence preceded by prose", () => {
    const raw = `Here is the plan:
\`\`\`json
{"subtasks":[{"id":1,"text":"do work","dependsOn":[]}],"execution":"sequential"}
\`\`\``;

    const extracted = extractJsonObject(raw);
    expect(JSON.parse(extracted)).toEqual({
      subtasks: [{ id: 1, text: "do work", dependsOn: [] }],
      execution: "sequential",
    });
  });

  it("extracts JSON anchored on subtasks when no fence is present", () => {
    const raw = `Some preamble {"subtasks":[{"id":1,"text":"step","dependsOn":[]}]} trailing`;

    const extracted = extractJsonObject(raw);
    expect(JSON.parse(extracted)).toEqual({
      subtasks: [{ id: 1, text: "step", dependsOn: [] }],
    });
  });
});

describe("tryParseAdvisorJson", () => {
  it("parses JSON with trailing commas after repair", () => {
    const raw = `{"subtasks":[{"id":1,"text":"do work","dependsOn":[],},],"execution":"sequential",}`;

    const parsed = tryParseAdvisorJson(raw);
    expect(parsed).toEqual({
      subtasks: [{ id: 1, text: "do work", dependsOn: [] }],
      execution: "sequential",
    });
  });

  it("returns null for completely invalid JSON", () => {
    expect(tryParseAdvisorJson("not json at all")).toBeNull();
  });
});

describe("extractThinkTextForPlan", () => {
  it("prefers advisor-think over redacted_thinking content", () => {
    const raw = `<advisor-think>
DRAFT PLAN:
  Agent 1 — setup:
    1. install deps
</advisor-think>
<think>
  1. ignored step
</think>`;

    expect(extractThinkTextForPlan(raw)).toContain("install deps");
    expect(extractThinkTextForPlan(raw)).not.toContain("ignored step");
  });

  it("falls back to redacted_thinking when advisor-think is missing", () => {
    const raw = `<think>
DRAFT PLAN:
  Agent 1 — setup:
    1. read package.json
</think>`;

    expect(extractThinkTextForPlan(raw)).toContain("read package.json");
  });
});

describe("normaliseAdvisorPlan", () => {
  it("accepts a top-level array of subtasks", () => {
    const plan = normaliseAdvisorPlan(
      [{ id: 1, text: "step one", dependsOn: [] }],
      3,
    );

    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]?.text).toBe("step one");
  });

  it("accepts tasks as an alias for subtasks", () => {
    const plan = normaliseAdvisorPlan(
      {
        tasks: [{ id: 1, text: "alias step", dependsOn: [] }],
        execution: "sequential",
      },
      3,
    );

    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]?.text).toBe("alias step");
  });

  it("coerces numeric-string ids and dependsOn entries", () => {
    const plan = normaliseAdvisorPlan(
      {
        subtasks: [
          { id: "1", text: "first", dependsOn: [] },
          { id: "2", text: "second", dependsOn: ["1"] },
        ],
      },
      3,
    );

    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks[1]?.dependsOn).toEqual([1]);
  });
});

describe("contextHasWorkspaceStructure", () => {
  it("returns true when Structure snapshot is present", () => {
    expect(
      contextHasWorkspaceStructure("[Prior session]\nStructure:\npackages/\n"),
    ).toBe(true);
  });

  it("returns false when no structure block exists", () => {
    expect(contextHasWorkspaceStructure("[User preferences]\n- use vitest")).toBe(
      false,
    );
  });
});

describe("summarizeWorkspaceStackHint", () => {
  it("returns a short hint for Node/TypeScript monorepos", () => {
    const hint = summarizeWorkspaceStackHint(
      "Structure:\npackage.json\ntsconfig.json\npackages/client/\n_Test_/\n",
    );
    expect(hint).toContain("Node.js");
    expect(hint).toContain("TypeScript");
  });

  it("detects Python projects", () => {
    const hint = summarizeWorkspaceStackHint(
      "Structure:\npyproject.toml\ntests/\nconftest.py\n",
    );
    expect(hint).toContain("Python");
    expect(hint).toContain("pytest");
  });

  it("detects Go projects", () => {
    const hint = summarizeWorkspaceStackHint(
      "Structure:\ngo.mod\ncmd/\ninternal/\nfoo_test.go\n",
    );
    expect(hint).toContain("Go");
    expect(hint).toContain("go test");
  });

  it("returns fallback when structure exists but stack is unclear", () => {
    const hint = summarizeWorkspaceStackHint("Structure:\nREADME.md\nsrc/\n");
    expect(hint).toContain("Structure snapshot present");
  });

  it("returns null when no structure snapshot exists", () => {
    expect(summarizeWorkspaceStackHint("[User preferences]\n- foo")).toBeNull();
  });
});
