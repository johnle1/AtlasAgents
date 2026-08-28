/**
 * Unit tests — updatePlanHandler.ts (`update_plan` tool)
 */

import { describe, expect, it, vi } from "vitest";
import { updatePlanTool } from "../../../../packages/server/src/orchestration/tools/updatePlanHandler.js";
import type { ToolHandlerContext } from "../../../../packages/server/src/orchestration/tools/types.js";
import { emptyCommandPlan } from "../../../../packages/server/src/orchestration/types.js";
import { fakeExperienceRecorder } from "../../../helpers/fakeExperienceRecorder.js";

const buildContext = (
  planTools?: ToolHandlerContext["planTools"],
): ToolHandlerContext => ({
  taskId: "task-1",
  subtask: "do the thing",
  agentSource: { agentId: 0, agentLabel: "agent" },
  emitSubagentStatus: vi.fn(),
  messages: [],
  workspace: {} as ToolHandlerContext["workspace"],
  terminal: {} as ToolHandlerContext["terminal"],
  recorder: fakeExperienceRecorder(),
  escalationCount: 0,
  maxEscalations: 0,
  trackers: {
    filesReadThisTask: new Set(),
    filesWrittenThisTask: new Set(),
    filesVerifiedThisTask: new Set(),
    verifyCommandPassed: false,
    completedSetupCommands: new Set(),
    failedCommandAttempts: new Map(),
  },
  thinkText: null,
  commandPlan: emptyCommandPlan(),
  planTools,
});

const validSteps = {
  steps: [
    { id: 1, text: "read the config", status: "done" },
    { id: 2, text: "wire the flag", status: "in_progress" },
  ],
};

describe("updatePlanTool", () => {
  it("reports unavailable when planTools is absent (e.g. called from a dispatched subagent)", async () => {
    const ctx = buildContext(undefined);
    const result = await updatePlanTool.execute(validSteps, ctx);
    expect(result.done).toBe(false);
    expect(result.feedback).toContain("not available");
  });

  it("rejects steps with a duplicate id before ever calling planTools.updatePlan", async () => {
    const updatePlan = vi.fn();
    const ctx = buildContext({ updatePlan, runStepsParallel: vi.fn() });

    const result = await updatePlanTool.execute(
      { steps: [{ id: 1, text: "a", status: "pending" }, { id: 1, text: "b", status: "pending" }] },
      ctx,
    );

    expect(updatePlan).not.toHaveBeenCalled();
    expect(result.done).toBe(false);
    expect(result.feedback).toContain("Invalid steps");
  });

  it("rejects a step with empty text", async () => {
    const updatePlan = vi.fn();
    const ctx = buildContext({ updatePlan, runStepsParallel: vi.fn() });

    const result = await updatePlanTool.execute(
      { steps: [{ id: 1, text: "  ", status: "pending" }] },
      ctx,
    );

    expect(updatePlan).not.toHaveBeenCalled();
    expect(result.feedback).toContain("Invalid steps");
  });

  it("defaults a step's status to pending when omitted", async () => {
    const updatePlan = vi.fn(async () => ({ decision: "continue" as const }));
    const ctx = buildContext({ updatePlan, runStepsParallel: vi.fn() });

    await updatePlanTool.execute({ steps: [{ id: 1, text: "a step" }] }, ctx);

    expect(updatePlan).toHaveBeenCalledWith(
      [{ id: 1, text: "a step", status: "pending", dependsOn: undefined }],
      undefined,
    );
  });

  it("passes the note through and reports the checklist recorded on continue", async () => {
    const updatePlan = vi.fn(async () => ({ decision: "continue" as const }));
    const ctx = buildContext({ updatePlan, runStepsParallel: vi.fn() });

    const result = await updatePlanTool.execute(
      { ...validSteps, note: "starting work" },
      ctx,
    );

    expect(updatePlan).toHaveBeenCalledWith(validSteps.steps, "starting work");
    expect(result.done).toBe(false);
    expect(result.feedback).toContain("Checklist recorded");
  });

  it("ends the turn cleanly (done: true, ok: true) when the plan-review decision is stop", async () => {
    const updatePlan = vi.fn(async () => ({ decision: "stop" as const }));
    const ctx = buildContext({ updatePlan, runStepsParallel: vi.fn() });

    const result = await updatePlanTool.execute(validSteps, ctx);

    expect(result.done).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("surfaces the user's revise feedback as corrective tool feedback, not a turn end", async () => {
    const updatePlan = vi.fn(async () => ({
      decision: "revise" as const,
      feedback: "also add a test step",
    }));
    const ctx = buildContext({ updatePlan, runStepsParallel: vi.fn() });

    const result = await updatePlanTool.execute(validSteps, ctx);

    expect(result.done).toBe(false);
    expect(result.feedback).toContain("also add a test step");
  });
});
