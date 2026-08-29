/**
 * Unit tests — orchestratorPipelineHelpers.ts
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { AbortError } from "../../../../packages/server/src/errors/index.js";
import { OrchestrationError } from "../../../../packages/server/src/errors/orchestrationError.js";
import { emptyCommandPlan } from "../../../../packages/server/src/orchestration/types.js";
import type { TaskFrame } from "../../../../packages/server/src/transport/frames.js";

const exploreCodebaseMock = vi.hoisted(() =>
  vi.fn(async () => ({
    snapshot: "Structure:\npackages/\n",
  })),
);

vi.mock("../../../../packages/server/src/orchestration/exploreCodebase.js", () => ({
  exploreCodebase: exploreCodebaseMock,
}));

import {
  preparePlanningContext,
  runAgentPool,
} from "../../../../packages/server/src/orchestration/orchestrator/orchestratorPipelineHelpers.js";

const basePlan = () => ({
  subtasks: [
    {
      id: 1,
      text: "step one",
      dependsOn: [] as number[],
      agentId: 1,
      agentLabel: "worker",
    },
  ],
  risks: [] as string[],
  commandPlan: emptyCommandPlan(),
  execution: "sequential" as const,
  agentCount: 1,
});

describe("preparePlanningContext", () => {
  beforeEach(() => {
    exploreCodebaseMock.mockClear();
  });

  it("builds context header, stack hint, and skill body without workspace snapshot when tools are supported", async () => {
    const contextBuilder = {
      build: vi.fn(async () => "memory header"),
      detectStack: vi.fn(async () => "typescript"),
    };
    const skillManager = {
      selectForTask: vi.fn(async () => [
        { name: "ts-skill", content: "use vitest" },
      ]),
    };
    const sessionManager = { saveSnapshot: vi.fn() };
    const config = {
      getAgentModelSupportsTools: vi.fn(async () => true),
      getAgentModelSupportsThinking: vi.fn(async () => true),
      getAgentProvider: vi.fn(async () => "ollama"),
    };
    const emit = vi.fn();

    const result = await preparePlanningContext(
      { contextBuilder, skillManager, sessionManager, config } as never,
      {
        taskText: "fix tests",
        agentModel: "agent-model",
        modelOverrides: { agentModelSupportsTools: true },
        perConn: { workspace: {} } as never,
        emit,
        signal: new AbortController().signal,
      },
    );

    expect(contextBuilder.build).toHaveBeenCalledWith(
      "fix tests",
      "agent-model",
      "ollama",
    );
    expect(exploreCodebaseMock).not.toHaveBeenCalled();
    expect(result.contextHeader).toContain("memory header");
    expect(result.contextHeader).not.toContain("[Workspace structure]");
    expect(result.skillBody).toContain("[Stack skill: ts-skill.md]");
    expect(skillManager.selectForTask).toHaveBeenCalledWith("fix tests", {
      detectedStack: "typescript",
    });
  });

  it("appends workspace snapshot when agent lacks tools and context has no structure", async () => {
    const contextBuilder = {
      build: vi.fn(async () => ""),
      detectStack: vi.fn(async () => null),
    };
    const skillManager = { selectForTask: vi.fn(async () => []) };
    const sessionManager = { saveSnapshot: vi.fn() };
    const config = {
      getAgentModelSupportsTools: vi.fn(async () => false),
      getAgentModelSupportsThinking: vi.fn(async () => true),
      getAgentProvider: vi.fn(async () => "ollama"),
    };
    const workspace = { listStructure: vi.fn() };

    const result = await preparePlanningContext(
      { contextBuilder, skillManager, sessionManager, config } as never,
      {
        taskText: "task",
        agentModel: "m",
        modelOverrides: { agentModelSupportsTools: false },
        perConn: { workspace } as never,
        emit: vi.fn(),
        signal: new AbortController().signal,
      },
    );

    expect(exploreCodebaseMock).toHaveBeenCalled();
    expect(sessionManager.saveSnapshot).toHaveBeenCalledWith(
      "Structure:\npackages/\n",
    );
    expect(result.contextHeader).toContain("[Workspace structure]");
  });

  it("passes the resolved agent provider (override or config) through to contextBuilder.build (regression guard)", async () => {
    // ContextBuilder.build uses this third argument to decide whether to
    // budget against resolveNumCtx (Ollama only) or the default context
    // window. Before this was threaded through, build() always resolved
    // num_ctx regardless of provider — for an OpenAI-compatible role that
    // queries the local Ollama for a tag it never pulled, throws, and
    // collapses the memory header budget from ~25,600 tokens to ~819.
    const contextBuilder = {
      build: vi.fn(async () => ""),
      detectStack: vi.fn(async () => null),
    };
    const skillManager = { selectForTask: vi.fn(async () => []) };
    const sessionManager = { saveSnapshot: vi.fn() };
    const config = {
      getAgentModelSupportsTools: vi.fn(async () => true),
      getAgentModelSupportsThinking: vi.fn(async () => true),
      getAgentProvider: vi.fn(async () => "ollama"), // must be ignored: override wins
    };

    await preparePlanningContext(
      { contextBuilder, skillManager, sessionManager, config } as never,
      {
        taskText: "task",
        agentModel: "gpt-oss-120b",
        modelOverrides: { agentProvider: "vllm-gpu" },
        perConn: { workspace: {} } as never,
        emit: vi.fn(),
        signal: new AbortController().signal,
      },
    );

    expect(contextBuilder.build).toHaveBeenCalledWith(
      "task",
      "gpt-oss-120b",
      "vllm-gpu",
    );
    expect(config.getAgentProvider).not.toHaveBeenCalled();
  });
});

describe("runAgentPool", () => {
  it("runs subtasks through runSubtask and fills resultMap", async () => {
    const plan = basePlan();
    const resultMap = new Map();
    const runSubtask = vi.fn(async () => ({
      ok: true,
      summary: "done",
      keyFindings: ["finding"],
      filesTouched: ["a.ts"],
    }));
    const statusFrames: TaskFrame[] = [];

    const ordered = await runAgentPool({
      plan,
      maxSubagents: 1,
      resultMap,
      runSubtask,
      emitStatus: (frame) => statusFrames.push(frame),
      signal: new AbortController().signal,
    });

    expect(runSubtask).toHaveBeenCalledOnce();
    expect(resultMap.get(1)?.summary).toBe("done");
    expect(ordered).toHaveLength(1);
    expect(ordered[0]?.content).toContain("done");
    expect(statusFrames.some((f) => f.kind === "status" && f.icon === "✓")).toBe(
      true,
    );
  });

  it("throws OrchestrationError when a subtask fails", async () => {
    const runSubtask = vi.fn(async () => ({
      ok: false,
      summary: "boom",
      keyFindings: [],
      filesTouched: [],
    }));

    await expect(
      runAgentPool({
        plan: basePlan(),
        maxSubagents: 1,
        resultMap: new Map(),
        runSubtask,
        emitStatus: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(OrchestrationError);
  });

  it("throws AbortError when signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const runSubtask = vi.fn();

    await expect(
      runAgentPool({
        plan: basePlan(),
        maxSubagents: 1,
        resultMap: new Map(),
        runSubtask,
        emitStatus: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AbortError);
  });
});
