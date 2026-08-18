/**
 * Integration tests — approvalMode on the orchestrator pipeline.
 *
 * `plan` mode stops after confirm-plan (no subagent pool). `accept_edits` is
 * a client-side keepUndo short-circuit (covered in approvalFlow unit tests);
 * this file asserts the server honors `plan`.
 *
 * Category checklist:
 * - Happy path: default mode still runs the subagent pool
 * - Contract: plan mode never calls the subagent client
 * - State: plan mode still returns ok: true with the plan
 */

import { describe, expect, it, vi } from "vitest";
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
Proceeding straight to finish.
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
  build: async () => "",
  detectStack: async () => undefined,
  resolveNumCtx: async () => 4096,
});

const makeDeps = (
  agentClient: IOllamaClient,
  subagentClient: IOllamaClient,
): OrchestratorPipelineDeps => ({
  contextBuilder: makeContextBuilder(),
  skillManager: { selectForTask: async () => [] } as unknown as ISkillManager,
  sessionManager: {
    read: async () => "",
    exists: async () => false,
    append: async () => {},
    clear: async () => "",
    saveSnapshot: async () => {},
  } as ISessionManager,
  experienceRecorder: fakeExperienceRecorder(),
  agent: {} as unknown as Agent,
  providerRegistry: {
    getRoleClient: (role: "agent" | "subagent") =>
      role === "agent" ? agentClient : subagentClient,
  } as unknown as IProviderRegistry,
  config: makeConfig(),
});

const makePerConnection = (): PerConnection =>
  ({
    planBroker: { request: async () => ({ decision: "implement" }) },
    resolvePlan: () => {},
    rebindStreamEmit: () => {},
    workspace: { listStructure: async () => "" },
    terminal: {},
  }) as unknown as PerConnection;

describe("approvalMode — plan stops at confirm-plan", () => {
  it("does not call the subagent client when approvalMode is plan (contract)", async () => {
    const subagentChat = vi.fn();
    const agentClient = {
      chatWithTools: async () => ({
        content: AGENT_THINK_BLOCK,
        toolCalls: [{ name: "submit_plan", args: ONE_SUBTASK_PLAN_ARGS }],
      }),
      chat: async () => "unused",
    } as unknown as IOllamaClient;
    const subagentClient = {
      chatWithTools: subagentChat,
    } as unknown as IOllamaClient;

    const outcome = await runOrchestratorPipeline(
      makeDeps(agentClient, subagentClient),
      {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit: () => {},
        signal: new AbortController().signal,
        perConn: makePerConnection(),
        approvalMode: "plan",
      },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.plan.subtasks).toHaveLength(1);
    expect(subagentChat).not.toHaveBeenCalled();
  });
});

describe("approvalMode — default still runs the pool (happy path)", () => {
  it("calls the subagent client when approvalMode is default", async () => {
    const subagentChat = vi.fn(async () => ({
      content: SUBAGENT_THINK_BLOCK,
      toolCalls: [
        { name: "finish", args: { summary: "did it", keyFindings: [] } },
      ],
    }));
    const agentClient = {
      chatWithTools: async () => ({
        content: AGENT_THINK_BLOCK,
        toolCalls: [{ name: "submit_plan", args: ONE_SUBTASK_PLAN_ARGS }],
      }),
      chat: async () => "combined",
    } as unknown as IOllamaClient;

    const outcome = await runOrchestratorPipeline(
      makeDeps(agentClient, { chatWithTools: subagentChat } as unknown as IOllamaClient),
      {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit: () => {},
        signal: new AbortController().signal,
        perConn: makePerConnection(),
        approvalMode: "default",
      },
    );

    expect(outcome.ok).toBe(true);
    expect(subagentChat).toHaveBeenCalled();
  });
});

describe("approvalMode — accept_edits and auto still run the pool (contract)", () => {
  it("calls the subagent client when approvalMode is accept_edits", async () => {
    const subagentChat = vi.fn(async () => ({
      content: SUBAGENT_THINK_BLOCK,
      toolCalls: [
        { name: "finish", args: { summary: "did it", keyFindings: [] } },
      ],
    }));
    const agentClient = {
      chatWithTools: async () => ({
        content: AGENT_THINK_BLOCK,
        toolCalls: [{ name: "submit_plan", args: ONE_SUBTASK_PLAN_ARGS }],
      }),
      chat: async () => "combined",
    } as unknown as IOllamaClient;

    const outcome = await runOrchestratorPipeline(
      makeDeps(agentClient, {
        chatWithTools: subagentChat,
      } as unknown as IOllamaClient),
      {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit: () => {},
        signal: new AbortController().signal,
        perConn: makePerConnection(),
        approvalMode: "accept_edits",
      },
    );

    expect(outcome.ok).toBe(true);
    expect(subagentChat).toHaveBeenCalled();
  });
});
