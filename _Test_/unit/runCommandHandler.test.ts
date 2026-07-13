/**
 * Unit tests — runCommandHandler.ts repeated-failure tracking
 */

import { describe, expect, it, vi } from "vitest";
import { runCommandTool } from "../../packages/server/src/orchestration/tools/runCommandHandler.js";
import type { ToolHandlerContext } from "../../packages/server/src/orchestration/tools/toolHandler.js";
import { emptyCommandPlan } from "../../packages/server/src/orchestration/types.js";

const buildContext = (
  runWithConfirmation: ToolHandlerContext["terminal"]["runWithConfirmation"],
): ToolHandlerContext => ({
  taskId: "task-1",
  subtask: "setup",
  agentSource: { agentId: 0, agentLabel: "Agent 1" },
  emitAgentStatus: vi.fn(),
  messages: [],
  workspace: {} as ToolHandlerContext["workspace"],
  terminal: { runWithConfirmation } as ToolHandlerContext["terminal"],
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

describe("runCommandTool — repeated command failures", () => {
  it("nudges escalation after the same command fails twice", async () => {
    const command = "npm create vite@latest worldTime -- --template react-ts";
    const runWithConfirmation = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "network error",
      exitCode: 1,
    });

    const ctx = buildContext(runWithConfirmation);
    const args = { command, purpose: "setup", background: false };

    const first = await runCommandTool.execute(args, ctx);
    expect(first.feedback).not.toContain("failed twice in a row");

    const second = await runCommandTool.execute(args, ctx);
    expect(second.feedback).toContain("failed twice in a row");
    expect(second.feedback).toContain(command);
    expect(ctx.trackers.failedCommandAttempts.get(command.toLowerCase())).toBe(2);
  });

  it("clears failure count after a successful run", async () => {
    const command = "npm install";
    const normalized = command.toLowerCase();
    const runWithConfirmation = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "error",
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: "installed",
        stderr: "",
        exitCode: 0,
      });

    const ctx = buildContext(runWithConfirmation);
    const args = { command, purpose: "setup", background: false };

    await runCommandTool.execute(args, ctx);
    expect(ctx.trackers.failedCommandAttempts.get(normalized)).toBe(1);

    await runCommandTool.execute(args, ctx);
    expect(ctx.trackers.failedCommandAttempts.has(normalized)).toBe(false);
    expect(ctx.trackers.completedSetupCommands.has(normalized)).toBe(true);
  });
});
