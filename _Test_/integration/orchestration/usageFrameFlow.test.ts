/**
 * Integration tests — orchestrator pipeline emits a `usage` frame after a
 * model turn, carrying `usedTokens` and the resolved `num_ctx`.
 *
 * Wires the real `runOrchestratorPipeline` with the same canned-LLM
 * boundary as orchestratorPipelineFlow.test.ts. Asserts the wire contract
 * the footer depends on.
 *
 * Category checklist:
 * - Happy path: usage frame present with the stubbed num_ctx
 * - Contract: usedTokens is inside [0, contextWindow]
 * - Failure: a failing subtask still emits usage (context % still updates)
 */

import { describe, expect, it } from "vitest";
import type {
  IContextBuilder,
  ISkillManager,
  ISessionManager,
  IConfigManager,
} from "../../../packages/server/src/orchestration/interfaces.js";
import { fakeExperienceRecorder } from "../../helpers/fakeExperienceRecorder.js";
import type { IOllamaClient } from "../../../packages/server/src/orchestration/interfaces/ollamaInterfaces.js";
import type { IProviderRegistry } from "../../../packages/server/src/providers/providerRegistry.js";
import type { PerConnection } from "../../../packages/server/src/container/types.js";
import type { Agent } from "../../../packages/server/src/orchestration/agent/agent.js";
import type { TaskFrame } from "../../../packages/server/src/transport/frames.js";
import { runOrchestratorPipeline } from "../../../packages/server/src/orchestration/orchestrator/orchestratorPipeline.js";
import type { OrchestratorPipelineDeps } from "../../../packages/server/src/orchestration/orchestrator/orchestratorPipelineTypes.js";

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

const SUBAGENT_THINK_BLOCK = `<redacted_thinking>
Setup commands: none
Verify commands: none
Off-limits (run-project): none
Proceeding straight to finish — nothing to set up or verify for this trivial subtask.
</redacted_thinking>`;

const ONE_SUBTASK_PLAN_ARGS = {
  subtasks: [
    {
      id: 1,
      text: "do the thing",
      dependsOn: [],
      agentId: 1,
      agentLabel: "implementation",
    },
  ],
  execution: "sequential" as const,
  agentCount: 1,
  risks: [] as string[],
};

const makeAgentPlanningClient = (): IOllamaClient =>
  ({
    chatWithTools: async () => ({
      content: AGENT_THINK_BLOCK,
      toolCalls: [{ name: "submit_plan", args: ONE_SUBTASK_PLAN_ARGS }],
    }),
    chat: async () => "combined result: done",
  }) as unknown as IOllamaClient;

const makeSubagentFinishClient = (): IOllamaClient =>
  ({
    chatWithTools: async () => ({
      content: SUBAGENT_THINK_BLOCK,
      toolCalls: [
        { name: "finish", args: { summary: "did the thing", keyFindings: [] } },
      ],
    }),
  }) as unknown as IOllamaClient;

const makeSubagentFailClient = (): IOllamaClient =>
  ({
    chatWithTools: async () => ({
      content: SUBAGENT_THINK_BLOCK,
      toolCalls: [
        {
          name: "escalate",
          args: { reason: "cannot proceed, simulated failure" },
        },
      ],
    }),
  }) as unknown as IOllamaClient;

const NUM_CTX = 8192;

const makeConfig = (): IConfigManager =>
  ({
    getAgentModel: async () => "fake-agent-model",
    getSubagentModel: async () => "fake-subagent-model",
    getAgentTemperature: async () => 0.1,
    getSubagentTemperature: async () => 0.4,
    getAgentModelSupportsTools: async () => true,
    getSubagentModelSupportsTools: async () => true,
    getMaxRetries: async () => 3,
    getMaxContextBudget: async () => 0.2,
    getAgentProvider: async () => "ollama",
    getSubagentProvider: async () => "ollama",
    getNumCtx: async () => undefined,
    getKeepAlive: async () => "30m",
  }) as unknown as IConfigManager;

const makeContextBuilder = (): IContextBuilder => ({
  build: async () => "header",
  detectStack: async () => undefined,
  resolveNumCtx: async () => NUM_CTX,
});

const makeSkillManager = (): ISkillManager =>
  ({ selectForTask: async () => [] }) as unknown as ISkillManager;

const makeSessionManager = (): ISessionManager => ({
  read: async () => "",
  exists: async () => false,
  append: async () => {},
  clear: async () => "",
  saveSnapshot: async () => {},
});

const makePerConnection = (): PerConnection =>
  ({
    planBroker: { request: async () => ({ decision: "implement" }) },
    resolvePlan: () => {},
    rebindStreamEmit: () => {},
    workspace: { listStructure: async () => "" },
    terminal: {},
  }) as unknown as PerConnection;

const makeDeps = (
  subagentClient: IOllamaClient,
): OrchestratorPipelineDeps => ({
  contextBuilder: makeContextBuilder(),
  skillManager: makeSkillManager(),
  sessionManager: makeSessionManager(),
  experienceRecorder: fakeExperienceRecorder(),
  agent: {} as unknown as Agent,
  providerRegistry: {
    getRoleClient: (role: "agent" | "subagent") =>
      role === "agent" ? makeAgentPlanningClient() : subagentClient,
  } as unknown as IProviderRegistry,
  config: makeConfig(),
});

const usageFramesOf = (frames: TaskFrame[]) =>
  frames.filter(
    (frame): frame is Extract<TaskFrame, { kind: "usage" }> =>
      frame.kind === "usage",
  );

describe("orchestrator pipeline — usage frame (happy path)", () => {
  it("emits a usage frame with the resolved num_ctx after a model turn", async () => {
    const frames: TaskFrame[] = [];
    await runOrchestratorPipeline(makeDeps(makeSubagentFinishClient()), {
      session: { userId: "u1", requesterId: "r1" },
      taskText: "do the thing",
      emit: (frame) => frames.push(frame),
      signal: new AbortController().signal,
      perConn: makePerConnection(),
    });

    const usage = usageFramesOf(frames);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0]?.contextWindow).toBe(NUM_CTX);
    expect(usage[0]?.usedTokens).toBeGreaterThanOrEqual(0);
    expect(usage[0]?.usedTokens).toBeLessThanOrEqual(NUM_CTX);
  });
});

describe("orchestrator pipeline — usage frame (failure propagation)", () => {
  it("still emits usage when a subtask fails so the footer can update", async () => {
    const frames: TaskFrame[] = [];
    await expect(
      runOrchestratorPipeline(makeDeps(makeSubagentFailClient()), {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit: (frame) => frames.push(frame),
        signal: new AbortController().signal,
        perConn: makePerConnection(),
      }),
    ).rejects.toThrow();

    const usage = usageFramesOf(frames);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0]?.contextWindow).toBe(NUM_CTX);
  });
});
