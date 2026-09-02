/**
 * Unit tests — server orchestration/planHelpers.ts
 */

import { describe, expect, it } from "vitest";
import {
  applyMaxAgentsConstraint,
  deriveExecution,
  modeLabelFromMaxAgents,
  validateNoCycles,
} from "../../../../packages/server/src/orchestration/planHelpers.js";
import type { PlannedSubtask, SubagentPlan } from "../../../../packages/server/src/orchestration/types.js";
import { emptyCommandPlan } from "../../../../packages/server/src/orchestration/types.js";

const subtask = (
  partial: Partial<PlannedSubtask> & Pick<PlannedSubtask, "id" | "text">,
): PlannedSubtask => ({
  dependsOn: [],
  agentId: 1,
  agentLabel: "setup",
  ...partial,
});

const basePlan = (subtasks: PlannedSubtask[]): SubagentPlan => ({
  subtasks,
  risks: [],
  commandPlan: emptyCommandPlan(),
  execution: "parallel",
  agentCount: new Set(subtasks.map((s) => s.agentId)).size,
});

describe("modeLabelFromMaxAgents", () => {
  it("maps special caps to labels", () => {
    expect(modeLabelFromMaxAgents(1)).toBe("focus mode");
    expect(modeLabelFromMaxAgents(2)).toBe("collab mode");
    expect(modeLabelFromMaxAgents("max")).toBe("max mode — no agent cap");
    expect(modeLabelFromMaxAgents(5)).toBe("up to 5 agents");
  });
});

describe("deriveExecution", () => {
  it('returns "parallel" when every subtask is independent', () => {
    const subtasks = [
      subtask({ id: 1, text: "a" }),
      subtask({ id: 2, text: "b", agentId: 2, agentLabel: "impl" }),
    ];
    expect(deriveExecution(subtasks)).toBe("parallel");
  });

  it('returns "sequential" when every subtask depends on another', () => {
    const subtasks = [
      subtask({ id: 1, text: "a", dependsOn: [2] }),
      subtask({ id: 2, text: "b", dependsOn: [1] }),
    ];
    expect(deriveExecution(subtasks)).toBe("sequential");
  });

  it('returns "mixed" when some subtasks are independent and some are not', () => {
    const subtasks = [
      subtask({ id: 1, text: "a" }),
      subtask({ id: 2, text: "b", dependsOn: [1] }),
    ];
    expect(deriveExecution(subtasks)).toBe("mixed");
  });
});

describe("validateNoCycles", () => {
  it("returns true for acyclic graphs", () => {
    const subtasks = [
      subtask({ id: 1, text: "a" }),
      subtask({ id: 2, text: "b", dependsOn: [1] }),
    ];
    expect(validateNoCycles(subtasks)).toBe(true);
  });

  it("returns false when a cycle exists", () => {
    const subtasks = [
      subtask({ id: 1, text: "a", dependsOn: [2] }),
      subtask({ id: 2, text: "b", dependsOn: [1] }),
    ];
    expect(validateNoCycles(subtasks)).toBe(false);
  });
});

describe("applyMaxAgentsConstraint", () => {
  it("collapses to a single sequential agent when max is 1", () => {
    const plan = basePlan([
      subtask({ id: 1, text: "a", agentId: 1 }),
      subtask({ id: 2, text: "b", agentId: 2, agentLabel: "impl" }),
    ]);

    const constrained = applyMaxAgentsConstraint(plan, 1);
    expect(constrained.agentCount).toBe(1);
    expect(constrained.execution).toBe("sequential");
    expect(constrained.subtasks.every((s) => s.agentId === 1)).toBe(true);
    expect(constrained.subtasks[1]?.dependsOn).toEqual([1]);
  });

  it("maps to two agents in collab mode", () => {
    const plan = basePlan([
      subtask({ id: 1, text: "a", agentId: 5, agentLabel: "prep" }),
      subtask({ id: 2, text: "b", agentId: 9, agentLabel: "work" }),
    ]);

    const constrained = applyMaxAgentsConstraint(plan, 2);
    expect(constrained.agentCount).toBe(2);
    expect(constrained.subtasks.map((s) => s.agentId).sort()).toEqual([1, 2]);
  });

  it("linearizes cyclic dependencies before applying caps", () => {
    const plan = basePlan([
      subtask({ id: 1, text: "a", dependsOn: [2] }),
      subtask({ id: 2, text: "b", dependsOn: [1] }),
    ]);

    const constrained = applyMaxAgentsConstraint(plan, "max");
    expect(validateNoCycles(constrained.subtasks)).toBe(true);
    expect(constrained.subtasks[0]?.dependsOn).toEqual([]);
    expect(constrained.subtasks[1]?.dependsOn).toEqual([1]);
  });

  it("merges excess agents when numeric cap is below unique agent count", () => {
    const plan = basePlan([
      subtask({ id: 1, text: "a", agentId: 1 }),
      subtask({ id: 2, text: "b", agentId: 2, agentLabel: "two" }),
      subtask({ id: 3, text: "c", agentId: 3, agentLabel: "three" }),
      subtask({ id: 4, text: "d", agentId: 4, agentLabel: "four" }),
    ]);

    const constrained = applyMaxAgentsConstraint(plan, 3);
    expect(constrained.agentCount).toBe(3);
    const agentIds = new Set(constrained.subtasks.map((s) => s.agentId));
    expect(agentIds.size).toBe(3);
  });
});
