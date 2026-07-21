/**
 * Unit tests — server orchestration/orchestrator/orchestratorPipelineHelpers.ts
 *
 * @remarks
 * These helpers previously lived in `orchestratorPipelineTypes.ts` (hence this
 * file's name) but were moved to `orchestratorPipelineHelpers.ts` when the
 * pure formatting/plan helpers were split out from the type definitions.
 */

import { describe, expect, it } from "vitest";
import {
  buildSessionContext,
  emptyPlan,
  formatPoolProgress,
  formatPoolStart,
  toOrderedResults,
} from "../../packages/server/src/orchestration/orchestrator/orchestratorPipelineHelpers.js";
import type { ToolResultSummary } from "../../packages/server/src/orchestration/types.js";
import { emptyCommandPlan } from "../../packages/server/src/orchestration/types.js";

describe("buildSessionContext", () => {
  it("formats structured dependency results", () => {
    const results = new Map<number, ToolResultSummary>([
      [
        1,
        {
          summary: "Added handler",
          keyFindings: ["Uses registry pattern"],
          filesTouched: ["src/handler.ts"],
          ok: true,
        },
      ],
    ]);

    const context = buildSessionContext(results, [1]);
    expect(context).toMatch(/Added handler/);
    expect(context).toMatch(/Uses registry pattern/);
    expect(context).toMatch(/src\/handler\.ts/);
  });

  it("returns empty string when no dependencies", () => {
    expect(buildSessionContext(new Map(), [])).toBe("");
  });

  it("includes heading only for missing dependency results", () => {
    const context = buildSessionContext(new Map(), [42]);
    expect(context).toContain("### Prior subtask 42");
    expect(context).not.toContain("Files:");
  });
});

describe("emptyPlan", () => {
  it("returns plan with no subtasks", () => {
    const plan = emptyPlan();
    expect(plan.subtasks).toEqual([]);
    expect(plan.agentCount).toBe(0);
    expect(plan.execution).toBe("sequential");
  });
});

describe("formatPoolProgress", () => {
  it("formats progress string", () => {
    expect(formatPoolProgress(3, 10, 2, 2)).toBe(
      "3/10 done · 2 running · 2 groups",
    );
  });
});

describe("formatPoolStart", () => {
  it("pluralizes labels correctly", () => {
    expect(formatPoolStart(2, 3, 10)).toBe(
      "2 groups · 3 workers · 10 tasks",
    );
    expect(formatPoolStart(1, 1, 1)).toBe(
      "1 group · 1 worker · 1 task",
    );
  });
});

describe("toOrderedResults", () => {
  it("orders results by subtask id", () => {
    const plan = {
      subtasks: [
        { id: 2, text: "second", dependsOn: [], agentId: 0, agentLabel: "A" },
        { id: 1, text: "first", dependsOn: [], agentId: 0, agentLabel: "A" },
      ],
      risks: [],
      commandPlan: emptyCommandPlan(),
      execution: "sequential" as const,
      agentCount: 1,
    };
    const resultMap = new Map<number, ToolResultSummary>([
      [1, { summary: "done one", keyFindings: [], filesTouched: [], ok: true }],
      [2, { summary: "done two", keyFindings: [], filesTouched: [], ok: true }],
    ]);
    const ordered = toOrderedResults(plan, resultMap);
    expect(ordered.map((r) => r.id)).toEqual([1, 2]);
    expect(ordered[0]?.content).toContain("done one");
    expect(ordered[1]?.content).toContain("done two");
  });
});
