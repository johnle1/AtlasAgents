/**
 * Unit tests — orchestratorPipelineHelpers.ts
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { AbortError } from "../../../../packages/server/src/errors/index.js";
import { OrchestrationError } from "../../../../packages/server/src/errors/orchestrationError.js";
import {
  PlanRevisionRequestedError,
  TaskSkippedError,
} from "../../../../packages/server/src/orchestration/agent/agentErrors.js";
import { emptyCommandPlan } from "../../../../packages/server/src/orchestration/types.js";
import type { Subagent } from "../../../../packages/server/src/orchestration/subagent/subagent.js";
import type { Agent } from "../../../../packages/server/src/orchestration/agent/agent.js";
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
  emitFinalResult,
  preparePlanningContext,
  runAgentPool,
  runPlanningWithRevisions,
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

describe("runPlanningWithRevisions", () => {
  it("returns skipped when agent.plan throws TaskSkippedError", async () => {
    const agent = {
      plan: vi.fn(async () => {
        throw new TaskSkippedError();
      }),
    } as unknown as Agent;

    const result = await runPlanningWithRevisions(agent, {
      taskText: "t",
      contextHeader: "",
      skillBody: "",
      modelOverrides: undefined,
      maxSubagents: 3,
      modeLabel: null,
      perConn: { planBroker: {}, workspace: {}, tokenSaveTools: [] } as never,
      sessionManager: { saveSnapshot: vi.fn() } as never,
      emit: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ skipped: true });
  });

  it("re-plans with folded feedback after PlanRevisionRequestedError", async () => {
    const plan = basePlan();
    const agent = {
      plan: vi
        .fn()
        .mockRejectedValueOnce(new PlanRevisionRequestedError("more tests"))
        .mockResolvedValueOnce(plan),
    } as unknown as Agent;

    const result = await runPlanningWithRevisions(agent, {
      taskText: "build feature",
      contextHeader: "ctx",
      skillBody: "skill",
      modelOverrides: undefined,
      maxSubagents: 3,
      modeLabel: "fast",
      perConn: {
        planBroker: { request: vi.fn() },
        workspace: { callMcpTool: vi.fn() },
        tokenSaveTools: [],
      } as never,
      sessionManager: { saveSnapshot: vi.fn() } as never,
      emit: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ skipped: false, plan });
    expect(agent.plan).toHaveBeenCalledTimes(2);
    const secondTaskArg = (agent.plan as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(secondTaskArg).toContain("more tests");
  });

  it("closes the think stream via finally when agent.plan throws after streaming a partial delta (regression guard)", async () => {
    // agent.plan()'s own onThinkEnd hook only fires at the natural end of an
    // iteration. If plan() throws first instead — an aborted chatStream, an
    // OrchestrationError from an auxiliary tool call, a provider error — the
    // emitter used to keep this round's id/streamed state, since nothing
    // called finish(). The next planning attempt's deltas would then stream
    // under a stale id the client had already torn down, and its reasoning
    // would never render. Subagent.runIteration guards the same emitter with
    // try/finally for exactly this reason; this proves the pipeline does now
    // too.
    const frames: TaskFrame[] = [];
    const emit = (frame: TaskFrame) => frames.push(frame);
    const agent = {
      plan: vi.fn(
        async (
          _task: string,
          _ctx: string,
          _skill: string,
          _overrides: unknown,
          hooks: { onThinkDelta?: (text: string) => void },
        ) => {
          hooks.onThinkDelta?.("partial reasoning before the failure");
          throw new Error("provider error mid-turn");
        },
      ),
    } as unknown as Agent;

    await expect(
      runPlanningWithRevisions(agent, {
        taskText: "t",
        contextHeader: "",
        skillBody: "",
        modelOverrides: undefined,
        maxSubagents: 3,
        modeLabel: null,
        perConn: { planBroker: {}, workspace: {}, tokenSaveTools: [] } as never,
        sessionManager: { saveSnapshot: vi.fn() } as never,
        emit,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("provider error mid-turn");

    const kinds = frames.map((frame) => frame.kind);
    expect(kinds).toContain("think-start");
    // Exactly one think-end: the finally's safety-net finish(null) must
    // close the stream the throw left open, without duplicating a close
    // that already happened on some other path.
    expect(kinds.filter((kind) => kind === "think-end")).toHaveLength(1);
  });
});

describe("runAgentPool", () => {
  it("runs subtasks and fills resultMap", async () => {
    const plan = basePlan();
    const resultMap = new Map();
    const subagent = {
      run: vi.fn(async () => ({
        ok: true,
        summary: "done",
        keyFindings: ["finding"],
        filesTouched: ["a.ts"],
      })),
    } as unknown as Subagent;
    const statusFrames: TaskFrame[] = [];

    const ordered = await runAgentPool(subagent, {
      taskId: "task-1",
      plan,
      skillBody: "",
      maxSubagents: 1,
      experienceRecorder: {} as never,
      perConn: { workspace: {}, terminal: {} } as never,
      modelOverrides: undefined,
      resultMap,
      emit: vi.fn(),
      emitStatus: (frame) => statusFrames.push(frame),
      signal: new AbortController().signal,
    });

    expect(subagent.run).toHaveBeenCalledOnce();
    expect(resultMap.get(1)?.summary).toBe("done");
    expect(ordered).toHaveLength(1);
    expect(ordered[0]?.content).toContain("done");
    expect(statusFrames.some((f) => f.kind === "status" && f.icon === "✓")).toBe(
      true,
    );
  });

  it("throws OrchestrationError when a subtask fails", async () => {
    const subagent = {
      run: vi.fn(async () => ({
        ok: false,
        summary: "boom",
        keyFindings: [],
        filesTouched: [],
      })),
    } as unknown as Subagent;

    await expect(
      runAgentPool(subagent, {
        taskId: "t",
        plan: basePlan(),
        skillBody: "",
        maxSubagents: 1,
        experienceRecorder: {} as never,
        perConn: { workspace: {}, terminal: {} } as never,
        modelOverrides: undefined,
        resultMap: new Map(),
        emit: vi.fn(),
        emitStatus: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(OrchestrationError);
  });

  it("throws AbortError when signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const subagent = { run: vi.fn() } as unknown as Subagent;

    await expect(
      runAgentPool(subagent, {
        taskId: "t",
        plan: basePlan(),
        skillBody: "",
        maxSubagents: 1,
        experienceRecorder: {} as never,
        perConn: { workspace: {}, terminal: {} } as never,
        modelOverrides: undefined,
        resultMap: new Map(),
        emit: vi.fn(),
        emitStatus: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AbortError);
  });
});

describe("emitFinalResult", () => {
  it("emits a single subtask result directly without combine", async () => {
    const tokens: string[] = [];
    const agent = { combine: vi.fn() } as unknown as Agent;

    await emitFinalResult(agent, {
      taskText: "t",
      plan: basePlan(),
      ordered: [{ id: 1, content: "final body" }],
      modelOverrides: undefined,
      emitToken: (text) => tokens.push(text),
      emitStatus: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(tokens).toEqual(["final body"]);
    expect(agent.combine).not.toHaveBeenCalled();
  });

  it("streams combine tokens for multi-subtask plans", async () => {
    const plan = {
      ...basePlan(),
      subtasks: [
        { id: 1, text: "a", dependsOn: [], agentId: 1, agentLabel: "w" },
        { id: 2, text: "b", dependsOn: [], agentId: 1, agentLabel: "w" },
      ],
      agentCount: 1,
    };
    const tokens: string[] = [];
    const agent = {
      combine: vi.fn(async function* () {
        yield "part ";
        yield "two";
      }),
    } as unknown as Agent;

    await emitFinalResult(agent, {
      taskText: "t",
      plan,
      ordered: [
        { id: 1, content: "r1" },
        { id: 2, content: "r2" },
      ],
      modelOverrides: undefined,
      emitToken: (text) => tokens.push(text),
      emitStatus: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(tokens.join("")).toBe("part two");
  });
});
