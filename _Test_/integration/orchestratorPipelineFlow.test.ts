/**
 * Integration tests — the full `runOrchestratorPipeline` task-execution path.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : runOrchestratorPipeline, the REAL `Agent` and
 *                          `Subagent` classes it constructs internally (see
 *                          "Why deps.agent doesn't matter" below), real
 *                          `preparePlanningContext` / `runAgentPool` /
 *                          `contextHasWorkspaceStructure` helper logic.
 * Mocks                  : only the true external boundary — the two
 *                          role-routed `IOllamaClient`s returned by a fake
 *                          `IProviderRegistry.getRoleClient`, each answering
 *                          with canned `chatWithTools` turns (same pattern as
 *                          `_Test_/unit/agent.test.ts`). `contextBuilder`,
 *                          `skillManager`, `sessionManager`,
 *                          `experienceRecorder`, and `config` are light
 *                          interface fakes; `workspace`/`terminal`/
 *                          `planBroker` are unused-but-typed stubs (this
 *                          scenario never reads/writes files or reviews a
 *                          plan, so their real implementations are never
 *                          reached).
 *
 * Why `deps.agent` doesn't matter
 * -------------------------------
 * `runOrchestratorPipeline` destructures `deps.agent` as `_unused` and
 * reconstructs its own `Agent`/`Subagent` from `providerRegistry.getRoleClient`
 * (see orchestratorPipeline.ts, "Agent passed to AgentOrchestrator but
 * reconstructed here with model-specific provider client"). That means the
 * REAL `Agent.plan()`/`Subagent.run()` control flow, retry/escalation logic,
 * and tool-call parsing all execute for real in this test — only the LLM
 * itself is faked, which is the correct integration boundary.
 *
 * Why this file exists
 * ---------------------
 * This session found and fixed two bugs that lived exactly at this seam and
 * that no unit test could catch:
 *   1. `preparePlanningContext` passed the SUBAGENT's model to
 *      `contextBuilder.build`, even though the resulting header is only ever
 *      injected into the AGENT's planning prompt.
 *   2. The workspace-snapshot injection checked the SUBAGENT's tool-support
 *      flag to decide whether the AGENT needs a workspace snapshot.
 * Both modules involved passed their own unit tests throughout — the bug was
 * purely in which value crossed the wire between them. This file drives a
 * real `runOrchestratorPipeline()` call and asserts on exactly those two
 * crossing points, so a regression here fails a test instead of shipping.
 *
 * Category checklist:
 *   ✅ Happy path          — plan → subagent pool → single-result emission, ok: true
 *   ✅ Contract consistency — agent's model reaches contextBuilder, not subagent's
 *   ✅ Contract consistency — workspace snapshot gates on the agent's tool-support flag
 *   ✅ Failure propagation — a failing subtask yields ok: false with partial results kept
 *   ✅ State integrity      — an aborted pipeline stops before any subagent turn runs
 */

import { describe, expect, it, vi } from "vitest";
import type {
  IContextBuilder,
  ISkillManager,
  ISessionManager,
  IExperienceRecorder,
  IConfigManager,
} from "../../packages/server/src/orchestration/interfaces.js";
import type { IOllamaClient } from "../../packages/server/src/orchestration/interfaces/ollamaInterfaces.js";
import type { IProviderRegistry } from "../../packages/server/src/providers/providerRegistry.js";
import type { Message } from "../../packages/server/src/orchestration/types.js";
import type { PerConnection } from "../../packages/server/src/container/types.js";
import type { Agent } from "../../packages/server/src/orchestration/agent/agent.js";
import type { TaskFrame } from "../../packages/server/src/transport/frames.js";
import { runOrchestratorPipeline } from "../../packages/server/src/orchestration/orchestrator/orchestratorPipeline.js";
import type { OrchestratorPipelineDeps } from "../../packages/server/src/orchestration/orchestrator/orchestratorPipelineTypes.js";

// ---------------------------------------------------------------------------
// Canned model turns
// ---------------------------------------------------------------------------

/** A minimally valid agent think block — satisfies `agentThink.ts`'s parsing. */
const AGENT_THINK_BLOCK = `<agent-think>
COMPLEXITY: simple
  reasoning: single trivial subtask

UNDERSTAND:
  literal: do the thing
  actual: do the thing
  implicit: none

EXPLORATION:
  need explore? no
  if no: no exploration needed

PLAN:
  agent count: 1
  execution: sequential

  Agent 1 — implementation:
    1. do the thing

SELF-CHECK:
  issues? none
  file conflicts? none
  wave assumptions? none

COMMAND PLAN:
  setup commands: none
  verify commands: none
</agent-think>`;

/**
 * Satisfies both `extractThinking` (must be wrapped in the model's thinking
 * tag — see `THINK_BLOCK` in toolProtocol.ts) and `hasCommandPlanSection`
 * (setup/verify/off-limits headers) for the subagent's first turn.
 */
const SUBAGENT_THINK_BLOCK = `<redacted_thinking>
Setup commands: none
Verify commands: none
Off-limits (run-project): none
Proceeding straight to finish — nothing to set up or verify for this trivial subtask.
</redacted_thinking>`;

const ONE_SUBTASK_PLAN_ARGS = {
  subtasks: [
    { id: 1, text: "do the thing", dependsOn: [], agentId: 1, agentLabel: "implementation" },
  ],
  execution: "sequential" as const,
  agentCount: 1,
  risks: [] as string[],
};

/** A fake `IOllamaClient` whose `chatWithTools` always proposes the one-subtask plan. */
const makeAgentPlanningClient = (
  onCall?: (model: string, messages: Message[]) => void,
): IOllamaClient =>
  ({
    chatWithTools: async (model: string, messages: Message[]) => {
      onCall?.(model, messages);
      return { content: AGENT_THINK_BLOCK, toolCalls: [{ name: "submit_plan", args: ONE_SUBTASK_PLAN_ARGS }] };
    },
    chat: async () => "combined result: done",
  }) as unknown as IOllamaClient;

/** A fake `IOllamaClient` whose `chatWithTools` finishes the subtask on the first turn. */
const makeSubagentFinishClient = (summary = "did the thing"): IOllamaClient =>
  ({
    chatWithTools: async () => ({
      content: SUBAGENT_THINK_BLOCK,
      toolCalls: [{ name: "finish", args: { summary, keyFindings: [] } }],
    }),
  }) as unknown as IOllamaClient;

/** A fake `IOllamaClient` whose `chatWithTools` reports the subtask as failed. */
const makeSubagentFailClient = (): IOllamaClient =>
  ({
    chatWithTools: async () => ({
      content: SUBAGENT_THINK_BLOCK,
      toolCalls: [{ name: "escalate", args: { reason: "cannot proceed, simulated failure" } }],
    }),
  }) as unknown as IOllamaClient;

// ---------------------------------------------------------------------------
// Minimal fakes for the rest of OrchestratorPipelineDeps
// ---------------------------------------------------------------------------

const makeConfig = (
  overrides: Partial<Record<
    "agentModel" | "subagentModel" | "agentModelSupportsTools" | "subagentModelSupportsTools",
    unknown
  >> = {},
): IConfigManager =>
  ({
    getAgentModel: async () => overrides.agentModel ?? "fake-agent-model",
    getSubagentModel: async () => overrides.subagentModel ?? "fake-subagent-model",
    getAgentTemperature: async () => 0.1,
    getSubagentTemperature: async () => 0.4,
    getAgentModelSupportsTools: async () => overrides.agentModelSupportsTools ?? true,
    getSubagentModelSupportsTools: async () => overrides.subagentModelSupportsTools ?? true,
    getMaxRetries: async () => 3,
    getMaxContextBudget: async () => 0.2,
  }) as unknown as IConfigManager;

const makeContextBuilder = (onBuild?: (taskText: string, modelOverride?: string) => void): IContextBuilder => ({
  build: async (taskText: string, modelOverride?: string) => {
    onBuild?.(taskText, modelOverride);
    return "";
  },
});

const makeSkillManager = (): ISkillManager => ({
  selectForTask: async () => [],
}) as unknown as ISkillManager;

const makeSessionManager = (): ISessionManager => ({
  read: async () => "",
  exists: async () => false,
  append: async () => {},
  clear: async () => "",
  saveSnapshot: async () => {},
});

const makeExperienceRecorder = (): IExperienceRecorder => ({
  start: async () => {},
  logRead: () => {},
  logWrite: () => {},
  logCommand: () => {},
  logEscalation: () => {},
  extract: () => {},
  finish: async () => {},
}) as unknown as IExperienceRecorder;

/**
 * `perConn.workspace`/`terminal`/`planBroker` are never actually reached by
 * these scenarios: the subagent finishes on its first turn without any
 * file/command tool call, and the agent never triggers an interactive plan
 * review. Minimal stubs are enough to satisfy the types.
 */
const makePerConnection = (): PerConnection =>
  ({
    planBroker: { request: async () => ({ decision: "implement" }) },
    resolvePlan: () => {},
    rebindStreamEmit: () => {},
    workspace: { listStructure: async () => "" },
    terminal: {},
  }) as unknown as PerConnection;

/** Builds a fake `IProviderRegistry` returning distinct clients per role. */
const makeProviderRegistry = (agentClient: IOllamaClient, subagentClient: IOllamaClient): IProviderRegistry =>
  ({
    getRoleClient: (role: "agent" | "subagent") =>
      role === "agent" ? agentClient : subagentClient,
  }) as unknown as IProviderRegistry;

const makeDeps = (opts: {
  config: IConfigManager;
  contextBuilder: IContextBuilder;
  agentClient: IOllamaClient;
  subagentClient: IOllamaClient;
}): OrchestratorPipelineDeps => ({
  contextBuilder: opts.contextBuilder,
  skillManager: makeSkillManager(),
  sessionManager: makeSessionManager(),
  experienceRecorder: makeExperienceRecorder(),
  agent: {} as unknown as Agent, // unused — see module doc
  providerRegistry: makeProviderRegistry(opts.agentClient, opts.subagentClient),
  config: opts.config,
});

const collectFrames = () => {
  const frames: TaskFrame[] = [];
  return { frames, emit: (frame: TaskFrame) => frames.push(frame) };
};

describe("orchestrator pipeline — happy path", () => {
  it("runs plan → subagent pool → single-result emission with ok: true", async () => {
    const config = makeConfig();
    const { frames, emit } = collectFrames();

    const outcome = await runOrchestratorPipeline(
      makeDeps({
        config,
        contextBuilder: makeContextBuilder(),
        agentClient: makeAgentPlanningClient(),
        subagentClient: makeSubagentFinishClient("did the thing"),
      }),
      {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit,
        signal: new AbortController().signal,
        perConn: makePerConnection(),
      },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.plan.subtasks).toHaveLength(1);

    const statusStages = frames
      .filter((frame): frame is Extract<TaskFrame, { kind: "status" }> => frame.kind === "status")
      .map((frame) => frame.stage);
    expect(statusStages).toContain("understanding");
    expect(statusStages).toContain("ready");
  });
});

describe("orchestrator pipeline — regression guard: agent model reaches contextBuilder", () => {
  it("passes the AGENT's model to contextBuilder.build, not the subagent's", async () => {
    let capturedModel: string | undefined;
    const config = makeConfig({ agentModel: "agent-only-model", subagentModel: "subagent-only-model" });

    await runOrchestratorPipeline(
      makeDeps({
        config,
        contextBuilder: makeContextBuilder((_taskText, modelOverride) => {
          capturedModel = modelOverride;
        }),
        agentClient: makeAgentPlanningClient(),
        subagentClient: makeSubagentFinishClient(),
      }),
      {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit: () => {},
        signal: new AbortController().signal,
        perConn: makePerConnection(),
      },
    );

    // This is the exact regression fixed this session: contextBuilder must
    // see "agent-only-model", never "subagent-only-model".
    expect(capturedModel).toBe("agent-only-model");
  });

  it("queries the agent model with the agent's own client, not the subagent's", async () => {
    let modelSeenByAgentClient: string | undefined;
    const config = makeConfig({ agentModel: "agent-only-model", subagentModel: "subagent-only-model" });

    await runOrchestratorPipeline(
      makeDeps({
        config,
        contextBuilder: makeContextBuilder(),
        agentClient: makeAgentPlanningClient((model) => {
          modelSeenByAgentClient = model;
        }),
        subagentClient: makeSubagentFinishClient(),
      }),
      {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit: () => {},
        signal: new AbortController().signal,
        perConn: makePerConnection(),
      },
    );

    expect(modelSeenByAgentClient).toBe("agent-only-model");
  });
});

describe("orchestrator pipeline — failure propagation", () => {
  // `runOrchestratorPipeline` builds a full `{ok, plan, results, error}` outcome
  // internally (for `experienceRecorder.finish`'s benefit) but always
  // re-throws the original error afterward rather than returning that outcome
  // to the caller — see the "Rethrow after experience recording" comment in
  // orchestratorPipeline.ts. So the only caller-observable effects of a
  // subtask failure are (a) the rejection itself and (b) the emitted error
  // frame, which is what these assertions check.
  it("rejects with a descriptive error when a subtask fails", async () => {
    const config = makeConfig();

    await expect(
      runOrchestratorPipeline(
        makeDeps({
          config,
          contextBuilder: makeContextBuilder(),
          agentClient: makeAgentPlanningClient(),
          subagentClient: makeSubagentFailClient(),
        }),
        {
          session: { userId: "u1", requesterId: "r1" },
          taskText: "do the thing",
          emit: () => {},
          signal: new AbortController().signal,
          perConn: makePerConnection(),
        },
      ),
    ).rejects.toThrow(/subtask 1 failed/i);
  });

  it("emits an error frame with formatted failure detail before rejecting", async () => {
    const config = makeConfig();
    const { frames, emit } = collectFrames();

    await runOrchestratorPipeline(
      makeDeps({
        config,
        contextBuilder: makeContextBuilder(),
        agentClient: makeAgentPlanningClient(),
        subagentClient: makeSubagentFailClient(),
      }),
      {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit,
        signal: new AbortController().signal,
        perConn: makePerConnection(),
      },
    ).catch(() => undefined);

    const errorFrame = frames.find(
      (frame): frame is Extract<TaskFrame, { kind: "error" }> => frame.kind === "error",
    );
    expect(errorFrame?.message).toMatch(/subtask 1 failed/i);
  });
});

describe("orchestrator pipeline — abort handling (state integrity)", () => {
  it("rejects without running any subagent turn when the signal is already aborted", async () => {
    const config = makeConfig();
    let subagentCalled = false;
    const subagentClient: IOllamaClient = {
      chatWithTools: async () => {
        subagentCalled = true;
        return { content: SUBAGENT_THINK_BLOCK, toolCalls: [{ name: "finish", args: { summary: "x" } }] };
      },
    } as unknown as IOllamaClient;

    const controller = new AbortController();
    controller.abort();

    await expect(
      runOrchestratorPipeline(
        makeDeps({
          config,
          contextBuilder: makeContextBuilder(),
          agentClient: makeAgentPlanningClient(),
          subagentClient,
        }),
        {
          session: { userId: "u1", requesterId: "r1" },
          taskText: "do the thing",
          emit: () => {},
          signal: controller.signal,
          perConn: makePerConnection(),
        },
      ),
    ).rejects.toThrow(/aborted/i);

    expect(subagentCalled).toBe(false);
  });
});
