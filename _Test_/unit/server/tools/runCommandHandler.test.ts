/**
 * Unit tests — runCommandHandler.ts repeated-failure tracking
 */

import { describe, expect, it, vi } from "vitest";
import { runCommandTool } from "../../../../packages/server/src/orchestration/tools/runCommandHandler.js";
import type { ToolHandlerContext } from "../../../../packages/server/src/orchestration/tools/types.js";
import { emptyCommandPlan } from "../../../../packages/server/src/orchestration/types.js";
import { fakeExperienceRecorder } from "../../../helpers/fakeExperienceRecorder.js";

const buildContext = (
  runWithConfirmation: ToolHandlerContext["terminal"]["runWithConfirmation"],
): ToolHandlerContext => ({
  taskId: "task-1",
  subtask: "setup",
  agentSource: { agentId: 0, agentLabel: "Agent 1" },
  emitSubagentStatus: vi.fn(),
  messages: [],
  workspace: {} as ToolHandlerContext["workspace"],
  terminal: { runWithConfirmation } as ToolHandlerContext["terminal"],
  recorder: fakeExperienceRecorder(),
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

describe("runCommandTool — silent exit-0 does not report unconditional success", () => {
  it("tells the agent to verify instead of asserting the command succeeded", async () => {
    // exit 0 with no captured output — e.g. a scaffold command that stalled
    // on an interactive prompt (npm create's "Ok to proceed?") and exited
    // early without writing anything. Nothing here proves the command's
    // actual effect happened, so the feedback must not claim it did.
    const command = "npm create vite@latest tic-tac-toe -- --template react-ts";
    const runWithConfirmation = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const ctx = buildContext(runWithConfirmation);
    const args = { command, purpose: "setup", background: false };

    const result = await runCommandTool.execute(args, ctx);
    expect(result.feedback).not.toContain("completed successfully");
    expect(result.feedback).toContain("exit 0");
    expect(result.feedback).toMatch(/does not confirm|check its expected effect/i);
  });
});

describe("runCommandTool — user requested changes (Revise)", () => {
  it("tells the agent to revise instead of repeating the command", async () => {
    const command = "rm -rf node_modules";
    const runWithConfirmation = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "skipped by user — command was not executed",
      exitCode: -1,
      feedback: "use npm ci instead, don't wipe node_modules",
    });

    const ctx = buildContext(runWithConfirmation);
    const args = { command, purpose: "setup", background: false };

    const result = await runCommandTool.execute(args, ctx);
    expect(result.feedback).toContain("User requested changes");
    expect(result.feedback).toContain(
      "use npm ci instead, don't wipe node_modules",
    );
    expect(result.feedback).toContain(
      "Do not run the same command again",
    );
  });

  it("does not count a revise as a command failure", async () => {
    const command = "rm -rf node_modules";
    const runWithConfirmation = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: -1,
      feedback: "don't do this",
    });

    const ctx = buildContext(runWithConfirmation);
    const args = { command, purpose: "setup", background: false };

    await runCommandTool.execute(args, ctx);
    await runCommandTool.execute(args, ctx);

    expect(ctx.trackers.failedCommandAttempts.has(command)).toBe(false);
  });

  it("does not mark a revised setup command as completed", async () => {
    const command = "npm install";
    const normalized = command.toLowerCase();
    const runWithConfirmation = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: -1,
      feedback: "hold off on installing",
    });

    const ctx = buildContext(runWithConfirmation);
    const args = { command, purpose: "setup", background: false };

    await runCommandTool.execute(args, ctx);
    expect(ctx.trackers.completedSetupCommands.has(normalized)).toBe(false);
  });
});
