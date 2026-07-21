/**
 * Unit tests — writeFileHandler.ts accept / decline / revise outcomes
 */

import { describe, expect, it, vi } from "vitest";
import { writeFileTool } from "../../packages/server/src/orchestration/tools/writeFileHandler.js";
import type { ToolHandlerContext } from "../../packages/server/src/orchestration/tools/types.js";
import { emptyCommandPlan } from "../../packages/server/src/orchestration/types.js";

const buildContext = (
  writeFile: ToolHandlerContext["workspace"]["writeFile"],
): ToolHandlerContext => ({
  taskId: "task-1",
  subtask: "setup",
  agentSource: { agentId: 0, agentLabel: "Agent 1" },
  emitSubagentStatus: vi.fn(),
  messages: [],
  workspace: { writeFile } as unknown as ToolHandlerContext["workspace"],
  terminal: {} as ToolHandlerContext["terminal"],
  recorder: { logCommand: vi.fn(), logEscalation: vi.fn() } as ToolHandlerContext["recorder"],
  escalationCount: 0,
  maxEscalations: 3,
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

describe("writeFileTool", () => {
  it("records the file as written and includes the diff on acceptance", async () => {
    const writeFile = vi
      .fn()
      .mockResolvedValue({ accepted: true, diff: "+added line" });
    const ctx = buildContext(writeFile);

    const result = await writeFileTool.execute(
      { path: "src/a.ts", content: "export {}\n" },
      ctx,
    );

    expect(ctx.trackers.filesWrittenThisTask.has("src/a.ts")).toBe(true);
    expect(result.feedback).toContain("accepted");
    expect(result.feedback).toContain("+added line");
  });

  it("reports a plain decline without touching trackers", async () => {
    const writeFile = vi.fn().mockResolvedValue({ accepted: false });
    const ctx = buildContext(writeFile);

    const result = await writeFileTool.execute(
      { path: "src/a.ts", content: "export {}\n" },
      ctx,
    );

    expect(ctx.trackers.filesWrittenThisTask.has("src/a.ts")).toBe(false);
    expect(result.feedback).toContain("user declined");
  });

  it("tells the agent to revise instead of repeating the same write", async () => {
    const writeFile = vi.fn().mockResolvedValue({
      accepted: false,
      feedback: "use a named export instead of default",
    });
    const ctx = buildContext(writeFile);

    const result = await writeFileTool.execute(
      { path: "src/a.ts", content: "export default {}\n" },
      ctx,
    );

    expect(ctx.trackers.filesWrittenThisTask.has("src/a.ts")).toBe(false);
    expect(result.feedback).toContain("User requested changes");
    expect(result.feedback).toContain("use a named export instead of default");
    expect(result.feedback).toContain("Do not repeat the same write");
  });
});
