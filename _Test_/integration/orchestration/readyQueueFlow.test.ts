/**
 * Integration tests — ReadyQueue ↔ the hidden subagent pool behind
 * `run_steps_parallel` (unified agent-turn loop; see `agentTurn.ts`).
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : runOrchestratorPipeline → runAgentTurn →
 *                          run_steps_parallel → runAgentPool driving the
 *                          REAL ReadyQueue (createReadyQueue/available/take/
 *                          complete) with real Subagent control flow — same
 *                          boundary as orchestratorPipelineFlow.test.ts.
 * Mocks                  : only the role-routed `IOllamaClient`s. The fake
 *                          agent client lays out a 3-step checklist (steps 1
 *                          and 2 independent, step 3 depends on both), fans
 *                          steps 1+2 out via `run_steps_parallel`, then
 *                          finishes; the fake subagent client records the
 *                          order steps reach the model and finishes each on
 *                          its first turn.
 *
 * What this proves that readyQueue.test.ts (unit) cannot:
 * - `run_steps_parallel` actually dispatches a real concurrent batch through
 *   the REAL pool (take/complete/workSignal), not a mock.
 * - The hidden pool never emits status/board frames — see
 *   "readyQueueFlow — hidden from the UI" below, the actual regression this
 *   file exists to guard now that subagent boards are no longer shown.
 * - A failed step is reported back as tool feedback and reflected as
 *   `"failed"` on the checklist, without throwing the whole turn.
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

const SUBAGENT_THINK_BLOCK = `<redacted_thinking>
Setup commands: none
Verify commands: none
Off-limits (run-project): none
Proceeding straight to finish — nothing to set up or verify for this trivial subtask.
</redacted_thinking>`;

const UPDATE_PLAN_ARGS = {
  steps: [
    { id: 1, text: "setup database", status: "pending" },
    { id: 2, text: "write docs", status: "pending" },
    { id: 3, text: "integrate components", status: "pending", dependsOn: [1, 2] },
  ],
};
const RUN_PARALLEL_ARGS = { stepIds: [1, 2] };
const FINISH_INTEGRATE_ARGS = { summary: "integrated", keyFindings: [] as string[] };

/** Fake top-level agent client: lays out the checklist, fans wave 0 out, then finishes. */
const makeAgentClient = (): IOllamaClient => {
  let call = 0;
  return {
    chatWithTools: async () => {
      call += 1;
      if (call === 1) {
        return { content: "", toolCalls: [{ name: "update_plan", args: UPDATE_PLAN_ARGS }] };
      }
      if (call === 2) {
        return { content: "", toolCalls: [{ name: "run_steps_parallel", args: RUN_PARALLEL_ARGS }] };
      }
      return { content: "", toolCalls: [{ name: "finish", args: FINISH_INTEGRATE_ARGS }] };
    },
    // Escalation guidance for a subtask dispatched by run_steps_parallel
    // still asks the lead Agent, which uses this client's `chat`.
    chat: async () => "try a different approach",
  } as unknown as IOllamaClient;
};

/**
 * Fake subagent client: records which step text each call carries (the
 * order of this array IS the dispatch order through the real queue), then
 * finishes — except steps listed in `failOn`, which escalate until the
 * escalation budget (config.getMaxRetries) is exhausted.
 */
const makeSubagentClient = (opts: {
  calls: string[];
  failOn?: string[];
  onCall?: (stepText: string) => void;
}): IOllamaClient =>
  ({
    chatWithTools: async (_model: string, messages: Message[]) => {
      const payload = JSON.stringify(messages);
      const stepText = ["setup database", "write docs"].find((text) => payload.includes(text));
      if (stepText) {
        opts.calls.push(stepText);
        opts.onCall?.(stepText);
      }
      if (stepText && opts.failOn?.includes(stepText)) {
        return {
          content: SUBAGENT_THINK_BLOCK,
          toolCalls: [{ name: "escalate", args: { reason: `${stepText} failed` } }],
        };
      }
      return {
        content: SUBAGENT_THINK_BLOCK,
        toolCalls: [{ name: "finish", args: { summary: `done: ${stepText ?? "unknown"}`, keyFindings: [] } }],
      };
    },
  }) as unknown as IOllamaClient;

// ---------------------------------------------------------------------------
// Minimal fakes for the rest of OrchestratorPipelineDeps
// ---------------------------------------------------------------------------

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

const makeDeps = (subagentClient: IOllamaClient): OrchestratorPipelineDeps => ({
  contextBuilder: makeContextBuilder(),
  skillManager: makeSkillManager(),
  sessionManager: makeSessionManager(),
  experienceRecorder: fakeExperienceRecorder(),
  agent: {} as unknown as Agent, // unused — reconstructed from providerRegistry
  providerRegistry: {
    getRoleClient: (role: "agent" | "subagent") =>
      role === "agent" ? makeAgentClient() : subagentClient,
  } as unknown as IProviderRegistry,
  config: makeConfig(),
});

const runPipeline = (opts: {
  subagentClient: IOllamaClient;
  emit?: (frame: TaskFrame) => void;
  signal?: AbortSignal;
}) =>
  runOrchestratorPipeline(makeDeps(opts.subagentClient), {
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
      subagentClient: makeSubagentClient({ calls }),
    });

    expect(outcome.ok).toBe(true);
    expect([...calls].sort()).toEqual(["setup database", "write docs"].sort());
  });

  it("marks the batch's steps done on the checklist once the pool finishes", async () => {
    const frames: TaskFrame[] = [];
    await runPipeline({
      subagentClient: makeSubagentClient({ calls: [] }),
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
  it("never emits a subagentBoards snapshot for the hidden pool", async () => {
    const frames: TaskFrame[] = [];
    await runPipeline({
      subagentClient: makeSubagentClient({ calls: [] }),
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
      subagentClient: makeSubagentClient({ calls, failOn: ["setup database"] }),
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
        subagentClient: makeSubagentClient({
          calls,
          onCall: () => controller.abort(),
        }),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });
});
