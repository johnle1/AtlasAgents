/**
 * Unit tests — runStepsParallelHandler.ts (`run_steps_parallel` tool)
 */

import { describe, expect, it, vi } from "vitest";
import { runStepsParallelTool } from "../../../../packages/server/src/orchestration/tools/runStepsParallelHandler.js";
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

describe("runStepsParallelTool", () => {
  it("reports unavailable when planTools is absent", async () => {
    const ctx = buildContext(undefined);
    const result = await runStepsParallelTool.execute({ stepIds: [1, 2] }, ctx);
    expect(result.done).toBe(false);
    expect(result.feedback).toContain("not available");
  });

  it("rejects a single step id — the tool exists for batches, not one-off dispatch", async () => {
    const runStepsParallel = vi.fn();
    const ctx = buildContext({ updatePlan: vi.fn(), runStepsParallel });

    const result = await runStepsParallelTool.execute({ stepIds: [1] }, ctx);

    expect(runStepsParallel).not.toHaveBeenCalled();
    expect(result.feedback).toContain("Invalid stepIds");
  });

  it("rejects duplicate step ids", async () => {
    const runStepsParallel = vi.fn();
    const ctx = buildContext({ updatePlan: vi.fn(), runStepsParallel });

    const result = await runStepsParallelTool.execute({ stepIds: [1, 1] }, ctx);

    expect(runStepsParallel).not.toHaveBeenCalled();
    expect(result.feedback).toContain("Invalid stepIds");
  });

  it("dispatches a valid batch and reports emitSubagentStatus before awaiting it", async () => {
    const runStepsParallel = vi.fn(async () => ({ ok: true, summary: "both steps done" }));
    const ctx = buildContext({ updatePlan: vi.fn(), runStepsParallel });

    const result = await runStepsParallelTool.execute({ stepIds: [1, 2] }, ctx);

    expect(runStepsParallel).toHaveBeenCalledWith([1, 2]);
    expect(ctx.emitSubagentStatus).toHaveBeenCalledWith(
      "running",
      "◌",
      expect.stringContaining("2 steps"),
    );
    expect(result.done).toBe(false);
    expect(result.feedback).toContain("both steps done");
  });

  it("still returns feedback (done: false) rather than throwing when the batch reports a failure", async () => {
    const runStepsParallel = vi.fn(async () => ({
      ok: false,
      summary: "Step 1: failed — see above. Step 2: done.",
    }));
    const ctx = buildContext({ updatePlan: vi.fn(), runStepsParallel });

    const result = await runStepsParallelTool.execute({ stepIds: [1, 2] }, ctx);

    expect(result.done).toBe(false);
    expect(result.feedback).toContain("failed");
  });
});
