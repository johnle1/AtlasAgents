/**
 * Unit tests — editFileHandler.ts accept / decline / revise outcomes
 */

import { describe, expect, it, vi } from "vitest";
import { editFileTool } from "../../../packages/server/src/orchestration/tools/editFileHandler.js";
import type { ToolHandlerContext } from "../../../packages/server/src/orchestration/tools/types.js";
import { emptyCommandPlan } from "../../../packages/server/src/orchestration/types.js";

const buildContext = (
  editFile: ToolHandlerContext["workspace"]["editFile"],
  filesReadThisTask: Set<string> = new Set(["src/a.ts"]),
): ToolHandlerContext => ({
  taskId: "task-1",
  subtask: "setup",
  agentSource: { agentId: 0, agentLabel: "Agent 1" },
  emitSubagentStatus: vi.fn(),
  messages: [],
  workspace: { editFile } as unknown as ToolHandlerContext["workspace"],
  terminal: {} as ToolHandlerContext["terminal"],
  recorder: { logCommand: vi.fn(), logEscalation: vi.fn() } as ToolHandlerContext["recorder"],
  escalationCount: 0,
  maxEscalations: 3,
  trackers: {
    filesReadThisTask,
    filesWrittenThisTask: new Set(),
    filesVerifiedThisTask: new Set(),
    verifyCommandPassed: false,
    completedSetupCommands: new Set(),
    failedCommandAttempts: new Map(),
  },
  thinkText: null,
  commandPlan: emptyCommandPlan(),
});

const args = { path: "src/a.ts", old: "foo", new: "bar" };

describe("editFileTool", () => {
  it("requires the file to have been read first", async () => {
    const editFile = vi.fn();
    const ctx = buildContext(editFile, new Set());

    const result = await editFileTool.execute(args, ctx);

    expect(editFile).not.toHaveBeenCalled();
    expect(result.feedback).toContain("must read_file");
  });

  it("records the file as written and includes the diff on acceptance", async () => {
    const editFile = vi
      .fn()
      .mockResolvedValue({ accepted: true, diff: "-foo\n+bar" });
    const ctx = buildContext(editFile);

    const result = await editFileTool.execute(args, ctx);

    expect(ctx.trackers.filesWrittenThisTask.has("src/a.ts")).toBe(true);
    expect(result.feedback).toContain("accepted");
    expect(result.feedback).toContain("-foo\n+bar");
  });

  it("reports a plain decline without touching trackers", async () => {
    const editFile = vi.fn().mockResolvedValue({ accepted: false });
    const ctx = buildContext(editFile);

    const result = await editFileTool.execute(args, ctx);

    expect(ctx.trackers.filesWrittenThisTask.has("src/a.ts")).toBe(false);
    expect(result.feedback).toContain("user declined");
  });

  it("tells the agent to revise instead of repeating the same edit", async () => {
    const editFile = vi.fn().mockResolvedValue({
      accepted: false,
      feedback: "keep the old error message wording",
    });
    const ctx = buildContext(editFile);

    const result = await editFileTool.execute(args, ctx);

    expect(ctx.trackers.filesWrittenThisTask.has("src/a.ts")).toBe(false);
    expect(result.feedback).toContain("User requested changes");
    expect(result.feedback).toContain("keep the old error message wording");
    expect(result.feedback).toContain("Do not repeat the same edit");
  });
});
