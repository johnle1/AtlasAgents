/**
 * Unit tests — Agent helper methods referenced by the coverage gap list.
 */

import { describe, expect, it } from "vitest";
import {
  buildPlanRevisionTask,
  defaultAgentFields,
  stripModelThinkingBlocks,
} from "../../../../packages/server/src/orchestration/agent/agentHelpers.js";
import { emptyCommandPlan } from "../../../../packages/server/src/orchestration/types.js";

describe("stripModelThinkingBlocks", () => {
  it("removes thinking tag blocks", () => {
    const raw = "before <think>secret</think> after";
    const cleaned = stripModelThinkingBlocks(raw);
    expect(cleaned).toContain("before");
    expect(cleaned).toContain("after");
    expect(cleaned).not.toContain("secret");
  });
});

describe("defaultAgentFields", () => {
  it("fills missing agentId/agentLabel on subtasks", () => {
    const fields = defaultAgentFields([
      {
        id: 1,
        text: "work",
        dependsOn: [],
        agentId: 0 as never,
        agentLabel: "",
      },
    ]);
    expect(fields[0]?.agentId).toBeGreaterThan(0);
    expect(fields[0]?.agentLabel.length).toBeGreaterThan(0);
  });
});

describe("buildPlanRevisionTask", () => {
  it("folds feedback into the revised task text", () => {
    const revised = buildPlanRevisionTask("original task", "add tests");
    expect(revised).toContain("original task");
    expect(revised).toContain("add tests");
  });
});

// silence unused import if emptyCommandPlan becomes needed
void emptyCommandPlan;
