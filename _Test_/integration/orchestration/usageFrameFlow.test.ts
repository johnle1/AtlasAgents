/**
 * Integration tests — orchestrator pipeline emits a `usage` frame after a
 * model turn, carrying `usedTokens` and the resolved `num_ctx`.
 *
 * Wires the real `runOrchestratorPipeline` (unified agent-turn loop) with
 * the same canned-LLM boundary as orchestratorPipelineFlow.test.ts. Asserts
 * the wire contract the footer depends on.
 *
 * Category checklist:
 * - Happy path: usage frame present with the stubbed num_ctx
 * - Contract: usedTokens is inside [0, contextWindow]
 * - Failure: a thrown model error still emits usage before rejecting
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

const makeAgentFinishClient = (): IOllamaClient =>
  ({
    chatWithTools: async () => ({
      content: "",
      toolCalls: [{ name: "finish", args: { summary: "did the thing", keyFindings: [] } }],
    }),
    chat: async () => "unused",
  }) as unknown as IOllamaClient;

const makeAgentThrowingClient = (): IOllamaClient =>
  ({
    chatWithTools: async () => {
      throw new Error("simulated model connection failure");
    },
    chat: async () => "unused",
  }) as unknown as IOllamaClient;

const NUM_CTX = 8192;

const makeConfig = (): IConfigManager =>
  ({
    getAgentModel: async () => "fake-agent-model",
    getSubagentModel: async () => "fake-subagent-model",
    getAgentTemperature: async () => 0.1,
    getSubagentTemperature: async () => 0.4,
    getAgentModelSupportsTools: async () => true,
    getAgentModelSupportsThinking: async () => true,
    getSubagentModelSupportsTools: async () => true,
    getMaxRetries: async () => 3,
    getMaxContextBudget: async () => 0.2,
    getAgentProvider: async () => "ollama",
    getSubagentProvider: async () => "ollama",
    getNumCtx: async () => undefined,
    getKeepAlive: async () => "30m",
    getEffort: async () => "high" as const,
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

const makeDeps = (agentClient: IOllamaClient): OrchestratorPipelineDeps => ({
  contextBuilder: makeContextBuilder(),
  skillManager: makeSkillManager(),
  sessionManager: makeSessionManager(),
  experienceRecorder: fakeExperienceRecorder(),
  agent: {} as unknown as Agent,
  providerRegistry: {
    getRoleClient: () => agentClient,
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
    await runOrchestratorPipeline(makeDeps(makeAgentFinishClient()), {
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
  it("still emits usage before a thrown model error rejects the pipeline", async () => {
    const frames: TaskFrame[] = [];
    await expect(
      runOrchestratorPipeline(makeDeps(makeAgentThrowingClient()), {
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
