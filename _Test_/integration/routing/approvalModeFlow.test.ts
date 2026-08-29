/**
 * Integration tests — approvalMode on the orchestrator pipeline (unified
 * agent-turn loop).
 *
 * `plan` mode no longer runs a separate up-front planning phase — instead it
 * restricts which tools the model is offered (no write_file/edit_file/
 * run_command/run_steps_parallel) until an `update_plan` proposal is
 * approved via the plan-review broker. Other modes never restrict the
 * toolset; the broker is never consulted.
 *
 * Category checklist:
 * - Contract: plan mode withholds mutating tools until update_plan is approved
 * - Contract: plan mode ends cleanly (ok: true) when the user skips the plan
 * - Contract: plan mode's revise decision re-gates the next proposal
 * - Happy path: default/accept_edits never restrict the toolset
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
import type { ToolSchema } from "../../../packages/server/src/orchestration/tools/types.js";
import type { IProviderRegistry } from "../../../packages/server/src/providers/providerRegistry.js";
import type { McpToolEntry } from "../../../packages/server/src/orchestration/mcp/mcpToolSchema.js";
import type { PerConnection } from "../../../packages/server/src/container/types.js";
import type { Agent } from "../../../packages/server/src/orchestration/agent/agent.js";
import { runOrchestratorPipeline } from "../../../packages/server/src/orchestration/orchestrator/orchestratorPipeline.js";
import type { OrchestratorPipelineDeps } from "../../../packages/server/src/orchestration/orchestrator/orchestratorPipelineTypes.js";

const UPDATE_PLAN_ARGS = {
  steps: [{ id: 1, text: "do the thing", status: "in_progress" }],
};
const FINISH_ARGS = { summary: "did it", keyFindings: [] as string[] };

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
  }) as unknown as IConfigManager;

const makeContextBuilder = (): IContextBuilder => ({
  build: async () => "",
  detectStack: async () => undefined,
  resolveNumCtx: async () => 4096,
});

const makeDeps = (
  agentClient: IOllamaClient,
  subagentClient: IOllamaClient = agentClient,
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

const makePerConnection = (
  planDecision: () => Promise<{ decision: string; feedback?: string }>,
  mcpTools?: McpToolEntry[],
): PerConnection =>
  ({
    planBroker: { request: planDecision },
    resolvePlan: () => {},
    rebindStreamEmit: () => {},
    workspace: { listStructure: async () => "" },
    terminal: {},
    mcpTools,
  }) as unknown as PerConnection;

const mcpTool = (name: string, readOnly: boolean): McpToolEntry => ({
  schema: {
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {}, required: [] } },
  },
  readOnly,
});

/** Extracts the tool names offered to the model on one `chatWithTools` call. */
const toolNamesFromCall = (mock: ReturnType<typeof vi.fn>, callIndex: number): string[] => {
  const tools = mock.mock.calls[callIndex]?.[2] as ToolSchema[] | undefined;
  return (tools ?? []).map((t) => t.function.name);
};

describe("approvalMode — plan mode gates mutating tools", () => {
  it("withholds write_file/run_command/run_steps_parallel until update_plan is approved", async () => {
    let call = 0;
    const agentChat = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { content: "", toolCalls: [{ name: "update_plan", args: UPDATE_PLAN_ARGS }] };
      }
      return { content: "", toolCalls: [{ name: "finish", args: FINISH_ARGS }] };
    });
    const agentClient = { chatWithTools: agentChat, chat: async () => "" } as unknown as IOllamaClient;

    const outcome = await runOrchestratorPipeline(makeDeps(agentClient), {
      session: { userId: "u1", requesterId: "r1" },
      taskText: "do the thing",
      emit: () => {},
      signal: new AbortController().signal,
      perConn: makePerConnection(async () => ({ decision: "implement" })),
      approvalMode: "plan",
    });

    expect(outcome.ok).toBe(true);
    expect(agentChat).toHaveBeenCalledTimes(2);
    // Before approval: no mutating tools offered.
    const beforeApproval = toolNamesFromCall(agentChat, 0);
    expect(beforeApproval).toContain("update_plan");
    expect(beforeApproval).not.toContain("write_file");
    expect(beforeApproval).not.toContain("run_command");
    expect(beforeApproval).not.toContain("run_steps_parallel");
    // After approval: full toolset unlocked for the next call.
    const afterApproval = toolNamesFromCall(agentChat, 1);
    expect(afterApproval).toContain("write_file");
    expect(afterApproval).toContain("run_command");
  });

  it("offers a read-only MCP tool but withholds a mutating one before approval", async () => {
    let call = 0;
    const agentChat = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { content: "", toolCalls: [{ name: "update_plan", args: UPDATE_PLAN_ARGS }] };
      }
      return { content: "", toolCalls: [{ name: "finish", args: FINISH_ARGS }] };
    });
    const agentClient = { chatWithTools: agentChat, chat: async () => "" } as unknown as IOllamaClient;

    await runOrchestratorPipeline(makeDeps(agentClient), {
      session: { userId: "u1", requesterId: "r1" },
      taskText: "do the thing",
      emit: () => {},
      signal: new AbortController().signal,
      perConn: makePerConnection(async () => ({ decision: "implement" }), [
        mcpTool("mcp__github__search_issues", true),
        mcpTool("mcp__github__create_issue", false),
      ]),
      approvalMode: "plan",
    });

    const beforeApproval = toolNamesFromCall(agentChat, 0);
    expect(beforeApproval).toContain("mcp__github__search_issues");
    expect(beforeApproval).not.toContain("mcp__github__create_issue");

    const afterApproval = toolNamesFromCall(agentChat, 1);
    expect(afterApproval).toContain("mcp__github__create_issue");
  });

  it("ends cleanly without calling a second turn when the user skips the plan", async () => {
    const agentChat = vi.fn(async () => ({
      content: "",
      toolCalls: [{ name: "update_plan", args: UPDATE_PLAN_ARGS }],
    }));
    const agentClient = { chatWithTools: agentChat, chat: async () => "" } as unknown as IOllamaClient;

    const outcome = await runOrchestratorPipeline(makeDeps(agentClient), {
      session: { userId: "u1", requesterId: "r1" },
      taskText: "do the thing",
      emit: () => {},
      signal: new AbortController().signal,
      perConn: makePerConnection(async () => ({ decision: "skip" })),
      approvalMode: "plan",
    });

    expect(outcome.ok).toBe(true);
    expect(agentChat).toHaveBeenCalledTimes(1);
  });

  it("re-gates the next proposal after a revise decision", async () => {
    const planDecisions = vi.fn(async () => {
      const calls = planDecisions.mock.calls.length;
      return calls === 1 ? { decision: "edit", feedback: "add a test step" } : { decision: "implement" };
    });
    let call = 0;
    const agentChat = vi.fn(async () => {
      call += 1;
      if (call === 3) {
        return { content: "", toolCalls: [{ name: "finish", args: FINISH_ARGS }] };
      }
      return { content: "", toolCalls: [{ name: "update_plan", args: UPDATE_PLAN_ARGS }] };
    });
    const agentClient = { chatWithTools: agentChat, chat: async () => "" } as unknown as IOllamaClient;

    const outcome = await runOrchestratorPipeline(makeDeps(agentClient), {
      session: { userId: "u1", requesterId: "r1" },
      taskText: "do the thing",
      emit: () => {},
      signal: new AbortController().signal,
      perConn: makePerConnection(planDecisions),
      approvalMode: "plan",
    });

    expect(outcome.ok).toBe(true);
    // First update_plan -> revise, second update_plan -> re-reviewed and
    // approved, third call unlocked and finishes.
    expect(planDecisions).toHaveBeenCalledTimes(2);
    expect(toolNamesFromCall(agentChat, 1)).not.toContain("write_file");
    expect(toolNamesFromCall(agentChat, 2)).toContain("write_file");
  });
});

describe("approvalMode — non-plan modes never restrict the toolset", () => {
  it("offers the full toolset from the first call in default mode", async () => {
    const agentChat = vi.fn(async () => ({
      content: "",
      toolCalls: [{ name: "finish", args: FINISH_ARGS }],
    }));
    const agentClient = { chatWithTools: agentChat, chat: async () => "" } as unknown as IOllamaClient;

    const outcome = await runOrchestratorPipeline(makeDeps(agentClient), {
      session: { userId: "u1", requesterId: "r1" },
      taskText: "do the thing",
      emit: () => {},
      signal: new AbortController().signal,
      perConn: makePerConnection(async () => ({ decision: "implement" })),
      approvalMode: "default",
    });

    expect(outcome.ok).toBe(true);
    expect(toolNamesFromCall(agentChat, 0)).toContain("write_file");
  });

  it("offers the full toolset from the first call in accept_edits mode", async () => {
    const agentChat = vi.fn(async () => ({
      content: "",
      toolCalls: [{ name: "finish", args: FINISH_ARGS }],
    }));
    const agentClient = { chatWithTools: agentChat, chat: async () => "" } as unknown as IOllamaClient;

    const outcome = await runOrchestratorPipeline(makeDeps(agentClient), {
      session: { userId: "u1", requesterId: "r1" },
      taskText: "do the thing",
      emit: () => {},
      signal: new AbortController().signal,
      perConn: makePerConnection(async () => ({ decision: "implement" })),
      approvalMode: "accept_edits",
    });

    expect(outcome.ok).toBe(true);
    expect(toolNamesFromCall(agentChat, 0)).toContain("write_file");
  });
});
