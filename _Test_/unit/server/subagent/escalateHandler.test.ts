/**
 * Unit tests — orchestration/tools/escalateHandler.ts
 */

import { describe, expect, it, vi } from "vitest";
import { createEscalateTool } from "../../../../packages/server/src/orchestration/tools/escalateHandler.js";
import type { ToolHandlerContext } from "../../../../packages/server/src/orchestration/tools/types.js";
import { emptyCommandPlan } from "../../../../packages/server/src/orchestration/types.js";
import { fakeExperienceRecorder } from "../../../helpers/fakeExperienceRecorder.js";

const baseContext = (): ToolHandlerContext => ({
  taskId: "t1",
  subtask: "debug",
  agentSource: { agentId: 1, agentLabel: "Agent 1" },
  emitSubagentStatus: vi.fn(),
  messages: [],
  workspace: {} as ToolHandlerContext["workspace"],
  terminal: {} as ToolHandlerContext["terminal"],
  recorder: fakeExperienceRecorder(),
  escalationCount: 0,
  maxEscalations: 2,
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
});

describe("createEscalateTool", () => {
  it("returns guidance from the lead agent when under budget", async () => {
    const advise = vi.fn().mockResolvedValue("Try mocking the API client.");
    const tool = createEscalateTool({ advise } as never);
    const ctx = baseContext();

    const result = await tool.execute({ reason: "stuck on mocks" }, ctx);

    expect(advise).toHaveBeenCalled();
    expect(result.done).toBe(false);
    expect(result.escalationCount).toBe(1);
    expect(result.feedback).toContain("Try mocking");
  });

  it("fails the subtask when escalation budget is exceeded", async () => {
    const tool = createEscalateTool({ advise: vi.fn() } as never);
    const ctx = { ...baseContext(), escalationCount: 2 };

    const result = await tool.execute({ reason: "still stuck" }, ctx);

    expect(result.done).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/failed after 2 escalations/);
  });
});
