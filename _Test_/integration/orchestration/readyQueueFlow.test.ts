/**
 * Integration tests — ReadyQueue ↔ concurrent steps dispatched by
 * `run_steps_parallel` (unified agent-turn loop; see `agentTurn.ts`).
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : runOrchestratorPipeline → runAgentTurn →
 *                          run_steps_parallel → runAgentPool driving the
 *                          REAL ReadyQueue (createReadyQueue/available/take/
 *                          complete), with each concurrent step completed by
 *                          the same `runToolCallLoop` as the top-level turn —
 *                          same boundary as orchestratorPipelineFlow.test.ts.
 * Mocks                  : only the single agent-role `IOllamaClient`. There
 *                          is no separate subagent role or model anymore —
 *                          the fake client lays out a 3-step checklist
 *                          (steps 1 and 2 independent, step 3 depends on
 *                          both), fans steps 1+2 out via `run_steps_parallel`
 *                          (identifying which call belongs to which
 *                          concurrent step by inspecting the message
 *                          payload, since both share this one client), then
 *                          finishes.
 *
 * What this proves that readyQueue.test.ts (unit) cannot:
 * - `run_steps_parallel` actually dispatches a real concurrent batch through
 *   the REAL pool (take/complete/workSignal), not a mock.
 * - No subagent construction or separate model/provider resolution is
 *   required for steps to run in parallel — this whole flow uses exactly
 *   one `IOllamaClient` fake, routed only through the "agent" role.
 * - The pool never emits status/board frames — see "readyQueueFlow — hidden
 *   from the UI" below, the actual regression this file exists to guard now
 *   that per-step boards are no longer shown.
 * - A failed step is reported back as tool feedback (via `finish`'s
 *   `ok: false`, since a concurrent step has no `escalate` tool) and
 *   reflected as `"failed"` on the checklist, without throwing the whole turn.
 * - An abort mid-batch stops dispatch and rejects the whole pipeline.
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
import type { Message } from "../../../packages/server/src/orchestration/types.js";
import type { PerConnection } from "../../../packages/server/src/container/types.js";
import type { Agent } from "../../../packages/server/src/orchestration/agent/agent.js";
import type { TaskFrame } from "../../../packages/server/src/transport/frames.js";
import { runOrchestratorPipeline } from "../../../packages/server/src/orchestration/orchestrator/orchestratorPipeline.js";
import type { OrchestratorPipelineDeps } from "../../../packages/server/src/orchestration/orchestrator/orchestratorPipelineTypes.js";

// ---------------------------------------------------------------------------
// Canned model turns
// ---------------------------------------------------------------------------

const UPDATE_PLAN_ARGS = {
  steps: [
    { id: 1, text: "setup database", status: "pending" },
    { id: 2, text: "write docs", status: "pending" },
    { id: 3, text: "integrate components", status: "pending", dependsOn: [1, 2] },
  ],
};
const RUN_PARALLEL_ARGS = { stepIds: [1, 2] };
const FINISH_INTEGRATE_ARGS = { summary: "integrated", keyFindings: [] as string[] };

/**
 * Fake agent-role client backing the ENTIRE flow — the top-level turn's
 * update_plan/run_steps_parallel/finish calls, and every concurrent step's
 * own calls (there is no separate subagent role to route to). The first two
 * calls are scripted by position (the top-level turn always calls them
 * first, before any concurrent step can run — a step's own client only
 * ever starts once run_steps_parallel's handler dispatches it). Every call
 * after that is identified by its LAST message being exactly a step's text
 * as a fresh `role: "user"` message — how a worker's single-shot
 * conversation looks (see `runWorkerStep` in `agentTurn.ts`) — as opposed
 * to a substring match, which would also match the top-level turn's own
 * later calls once its history accumulates the batch's result text (e.g.
 * "Step 1: done: setup database" inside a `role: "tool"` feedback message).
 */
const makeAgentClient = (opts: {
  calls: string[];
  failOn?: string[];
  onCall?: (stepText: string) => void;
}): IOllamaClient => {
  const STEP_TEXTS = ["setup database", "write docs"];
  let call = 0;
  return {
    chatWithTools: async (_model: string, messages: Message[]) => {
      call += 1;
      if (call === 1) {
        return { content: "", toolCalls: [{ name: "update_plan", args: UPDATE_PLAN_ARGS }] };
      }
      const lastMessage = messages[messages.length - 1];
      const stepText =
        lastMessage?.role === "user" && STEP_TEXTS.includes(lastMessage.content)
          ? lastMessage.content
          : undefined;
      if (!stepText) {
        // Not a concurrent step's own call — either the top-level turn's
        // 2nd call (dispatch the batch) or its wrap-up call after the
        // batch returns.
        return call === 2
          ? { content: "", toolCalls: [{ name: "run_steps_parallel", args: RUN_PARALLEL_ARGS }] }
          : { content: "", toolCalls: [{ name: "finish", args: FINISH_INTEGRATE_ARGS }] };
      }
      opts.calls.push(stepText);
      opts.onCall?.(stepText);
      if (opts.failOn?.includes(stepText)) {
        return {
          content: "",
          toolCalls: [
            { name: "finish", args: { summary: `${stepText} failed`, keyFindings: [], ok: false } },
          ],
        };
      }
      return {
        content: "",
        toolCalls: [{ name: "finish", args: { summary: `done: ${stepText}`, keyFindings: [] } }],
      };
    },
  } as unknown as IOllamaClient;
};

// ---------------------------------------------------------------------------
// Minimal fakes for the rest of OrchestratorPipelineDeps
// ---------------------------------------------------------------------------

const makeConfig = (): IConfigManager =>
  ({
    getAgentModel: async () => "fake-agent-model",
    getAgentTemperature: async () => 0.1,
    getAgentModelSupportsTools: async () => true,
    getAgentModelSupportsThinking: async () => true,
    getMaxRetries: async () => 3,
    getMaxContextBudget: async () => 0.2,
    getAgentProvider: async () => "ollama",
    getNumCtx: async () => undefined,
    getKeepAlive: async () => "30m",
    getEffort: async () => "high" as const,
    getNumParallel: async () => 2,
    getFlashAttention: async () => true,
    getKvCacheType: async () => "q8_0" as const,
  }) as unknown as IConfigManager;

const makeContextBuilder = (): IContextBuilder => ({
  build: async () => "",
  detectStack: async () => undefined,
  resolveNumCtx: async () => 4096,
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
  agent: {} as unknown as Agent, // unused — reconstructed from providerRegistry
  providerRegistry: {
    getRoleClient: () => agentClient,
  } as unknown as IProviderRegistry,
  config: makeConfig(),
});

const runPipeline = (opts: {
  agentClient: IOllamaClient;
  emit?: (frame: TaskFrame) => void;
  signal?: AbortSignal;
}) =>
  runOrchestratorPipeline(makeDeps(opts.agentClient), {
    session: { userId: "u1", requesterId: "r1" },
    taskText: "build the feature",
    emit: opts.emit ?? (() => {}),
    signal: opts.signal ?? new AbortController().signal,
    perConn: makePerConnection(),
  });

// ---------------------------------------------------------------------------
// Helpers over emitted frames
// ---------------------------------------------------------------------------

type StatusFrame = Extract<TaskFrame, { kind: "status" }>;
type PlanUpdateFrame = Extract<TaskFrame, { kind: "plan-update" }>;

const statusFrames = (frames: TaskFrame[]): StatusFrame[] =>
  frames.filter((frame): frame is StatusFrame => frame.kind === "status");

const planUpdateFrames = (frames: TaskFrame[]): PlanUpdateFrame[] =>
  frames.filter((frame): frame is PlanUpdateFrame => frame.kind === "plan-update");

// ---------------------------------------------------------------------------
// Wave-0 concurrent dispatch
// ---------------------------------------------------------------------------

describe("readyQueue ↔ hidden pool — run_steps_parallel dispatches a real concurrent batch", () => {
  it("runs both independent steps and reports the pipeline ok: true", async () => {
    const calls: string[] = [];
    const outcome = await runPipeline({
      agentClient: makeAgentClient({ calls }),
    });

    expect(outcome.ok).toBe(true);
    expect([...calls].sort()).toEqual(["setup database", "write docs"].sort());
  });

  it("marks the batch's steps done on the checklist once the pool finishes", async () => {
    const frames: TaskFrame[] = [];
    await runPipeline({
      agentClient: makeAgentClient({ calls: [] }),
      emit: (frame) => frames.push(frame),
    });

    const updates = planUpdateFrames(frames);
    expect(updates.length).toBeGreaterThan(0);
    const last = updates[updates.length - 1]!;
    const byId = new Map(last.steps.map((step) => [step.id, step.status]));
    expect(byId.get(1)).toBe("done");
    expect(byId.get(2)).toBe("done");
  });
});

describe("readyQueueFlow — hidden from the UI", () => {
  it("never emits a subagentBoards snapshot for a concurrent batch", async () => {
    const frames: TaskFrame[] = [];
    await runPipeline({
      agentClient: makeAgentClient({ calls: [] }),
      emit: (frame) => frames.push(frame),
    });

    const boardFrames = statusFrames(frames).filter(
      (frame) => "subagentBoards" in frame && frame.subagentBoards !== undefined,
    );
    expect(boardFrames).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failure — reported back, not thrown
// ---------------------------------------------------------------------------

describe("readyQueue ↔ hidden pool — a failed step is reported, not thrown", () => {
  it("marks the failed step on the checklist and lets the top-level turn continue", async () => {
    const calls: string[] = [];
    const frames: TaskFrame[] = [];

    const outcome = await runPipeline({
      agentClient: makeAgentClient({ calls, failOn: ["setup database"] }),
      emit: (frame) => frames.push(frame),
    });

    // The top-level agent's third call still fires (it saw failure feedback
    // and chose to finish anyway in this fixture) — the pipeline does not
    // reject just because one parallel step failed.
    expect(outcome.ok).toBe(true);

    const updates = planUpdateFrames(frames);
    const last = updates[updates.length - 1]!;
    const byId = new Map(last.steps.map((step) => [step.id, step.status]));
    expect(byId.get(1)).toBe("failed");
    expect(byId.get(2)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Abort mid-batch
// ---------------------------------------------------------------------------

describe("readyQueue ↔ hidden pool — abort mid-batch leaves consistent state", () => {
  it("rejects with an abort error and never reaches the finish call", async () => {
    const controller = new AbortController();
    const calls: string[] = [];

    await expect(
      runPipeline({
        // Abort as soon as the first step reaches the model — the pool's
        // next loop iteration sees the signal and stops dispatching.
        agentClient: makeAgentClient({
          calls,
          onCall: () => controller.abort(),
        }),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });
});
