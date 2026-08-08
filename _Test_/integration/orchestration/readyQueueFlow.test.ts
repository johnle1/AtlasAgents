/**
 * Integration tests — ReadyQueue ↔ orchestrator agent-pool dispatch.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : runOrchestratorPipeline → runAgentPool driving the
 *                          REAL ReadyQueue (createReadyQueue/available/take/
 *                          complete/buildSubagentBoardSnapshots) with real
 *                          Agent/Subagent control flow — same boundary as
 *                          orchestratorPipelineFlow.test.ts.
 * Mocks                  : only the role-routed `IOllamaClient`s. The fake
 *                          agent client proposes a two-wave DAG plan; the fake
 *                          subagent client records the order subtasks reach
 *                          the model and finishes each on its first turn.
 *
 * What this proves that readyQueue.test.ts (unit) cannot:
 * - The pool's take/complete/workSignal loop actually executes a multi-wave
 *   DAG in dependency order through the REAL pipeline, and the emitted
 *   status frames carry board snapshots whose lifecycle states track it.
 * - A failed subtask never unlocks its dependent through the real pool.
 * - An abort mid-queue stops dispatch and rejects, with dependent subtasks
 *   never reaching a model.
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
// Canned model turns (same shapes as orchestratorPipelineFlow.test.ts)
// ---------------------------------------------------------------------------

const AGENT_THINK_BLOCK = `<agent-think>
COMPLEXITY: moderate
  reasoning: three subtasks in two waves

UNDERSTAND:
  literal: do the things
  actual: do the things
  implicit: none

EXPLORATION:
  need explore? no
  if no: no exploration needed

PLAN:
  agent count: 2
  execution: parallel

  Agent 1 — implementation:
    1. setup database
    3. integrate components

  Agent 2 — documentation:
    2. write docs

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

/**
 * Two-wave DAG: subtasks 1 and 2 are independent (wave 0); subtask 3 needs
 * both (wave 1). Distinct, grep-able texts let the fake subagent client
 * record execution order from the messages it receives.
 */
const TWO_WAVE_PLAN_ARGS = {
  subtasks: [
    { id: 1, text: "setup database", dependsOn: [], agentId: 1, agentLabel: "implementation" },
    { id: 2, text: "write docs", dependsOn: [], agentId: 2, agentLabel: "documentation" },
    { id: 3, text: "integrate components", dependsOn: [1, 2], agentId: 1, agentLabel: "implementation" },
  ],
  execution: "parallel" as const,
  agentCount: 2,
  risks: [] as string[],
};

/** Fake agent client: proposes the two-wave plan, streams a combine answer. */
const makeAgentPlanningClient = (): IOllamaClient =>
  ({
    chatWithTools: async () => ({
      content: AGENT_THINK_BLOCK,
      toolCalls: [{ name: "submit_plan", args: TWO_WAVE_PLAN_ARGS }],
    }),
    chatStream: async function* (): AsyncGenerator<string> {
      yield "combined result: all done";
    },
    // Escalation advice and any other whole-response agent calls land here.
    chat: async () => "advice: keep going",
  }) as unknown as IOllamaClient;

/**
 * Fake subagent client: records which subtask text each call carries (the
 * order of this array IS the dispatch order through the real queue), then
 * finishes — except subtasks listed in `failOn`, which escalate.
 */
const makeSubagentClient = (opts: {
  calls: string[];
  failOn?: string[];
  onCall?: (subtaskText: string) => void;
}): IOllamaClient =>
  ({
    chatWithTools: async (_model: string, messages: Message[]) => {
      const payload = JSON.stringify(messages);
      // Subtask 3's prompt carries the completed wave-0 summaries as session
      // context (buildSessionContext), so those texts appear in its messages
      // too — match the dependent first, or its call would be misrecorded
      // as one of its dependencies.
      const subtaskText = ["integrate components", "setup database", "write docs"].find(
        (text) => payload.includes(text),
      );
      if (subtaskText) {
        opts.calls.push(subtaskText);
        opts.onCall?.(subtaskText);
      }
      if (subtaskText && opts.failOn?.includes(subtaskText)) {
        return {
          content: SUBAGENT_THINK_BLOCK,
          toolCalls: [{ name: "escalate", args: { reason: `${subtaskText} failed` } }],
        };
      }
      return {
        content: SUBAGENT_THINK_BLOCK,
        toolCalls: [{ name: "finish", args: { summary: `done: ${subtaskText ?? "unknown"}`, keyFindings: [] } }],
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
      role === "agent" ? makeAgentPlanningClient() : subagentClient,
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

const statusFrames = (frames: TaskFrame[]): StatusFrame[] =>
  frames.filter((frame): frame is StatusFrame => frame.kind === "status");

/** All board snapshots in emission order, flattened to per-task states. */
const boardStates = (frames: TaskFrame[]) =>
  statusFrames(frames)
    .filter((frame) => frame.source === "agent" && frame.subagentBoards)
    .map((frame) =>
      frame.subagentBoards!.flatMap((board) =>
        board.tasks.map((task) => ({ id: task.id, state: task.state })),
      ),
    );

// ---------------------------------------------------------------------------
// Multi-wave dispatch
// ---------------------------------------------------------------------------

describe("readyQueue ↔ agent pool — two-wave DAG dispatch", () => {
  it("runs wave 0 subtasks before their dependent, with ok: true", async () => {
    const calls: string[] = [];
    const outcome = await runPipeline({
      subagentClient: makeSubagentClient({ calls }),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.results).toHaveLength(3);

    // All three subtasks ran exactly once…
    expect([...calls].sort()).toEqual(
      ["integrate components", "setup database", "write docs"].sort(),
    );
    // …and the dependent ran strictly after BOTH of its dependencies.
    // (Wave-0 order between "setup database" and "write docs" is
    // intentionally unconstrained — they run on parallel workers.)
    const integrateIndex = calls.indexOf("integrate components");
    expect(integrateIndex).toBeGreaterThan(calls.indexOf("setup database"));
    expect(integrateIndex).toBeGreaterThan(calls.indexOf("write docs"));
  });

  it("emits board snapshots that track blocked → complete lifecycle", async () => {
    const frames: TaskFrame[] = [];
    await runPipeline({
      subagentClient: makeSubagentClient({ calls: [] }),
      emit: (frame) => frames.push(frame),
    });

    const snapshots = boardStates(frames);
    expect(snapshots.length).toBeGreaterThan(0);

    // Early snapshot: the dependent subtask is visibly blocked…
    const early = snapshots[0];
    expect(early).toContainEqual({ id: 3, state: "blocked" });

    // …and the last snapshot shows every subtask complete. (Board order is
    // by agent group, not subtask id — sort before comparing.)
    const last = [...snapshots[snapshots.length - 1]].sort(
      (taskA, taskB) => taskA.id - taskB.id,
    );
    expect(last).toEqual([
      { id: 1, state: "complete" },
      { id: 2, state: "complete" },
      { id: 3, state: "complete" },
    ]);
  });

  it("emits an unlock message when a completion frees the dependent", async () => {
    const frames: TaskFrame[] = [];
    await runPipeline({
      subagentClient: makeSubagentClient({ calls: [] }),
      emit: (frame) => frames.push(frame),
    });

    const messages = statusFrames(frames).map((frame) => frame.message);
    expect(messages.some((message) => /unlocked/i.test(message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure — dependents never unlock
// ---------------------------------------------------------------------------

describe("readyQueue ↔ agent pool — failure blocks the dependent wave", () => {
  it("rejects on the failed subtask and never runs its dependent", async () => {
    const calls: string[] = [];

    await expect(
      runPipeline({
        subagentClient: makeSubagentClient({ calls, failOn: ["setup database"] }),
      }),
    ).rejects.toThrow(/subtask 1 failed/i);

    // The dependent must never reach a model — a failed dependency unlocks
    // nothing. (Wave-0 sibling "write docs" may or may not have started on
    // its own worker before the failure propagated; that is unconstrained.)
    expect(calls).not.toContain("integrate components");
  });
});

// ---------------------------------------------------------------------------
// Abort mid-queue
// ---------------------------------------------------------------------------

describe("readyQueue ↔ agent pool — abort mid-queue leaves consistent state", () => {
  it("rejects with an abort error and never dispatches the dependent wave", async () => {
    const controller = new AbortController();
    const calls: string[] = [];

    await expect(
      runPipeline({
        // Abort as soon as the first subtask reaches the model — the pool's
        // next loop iteration sees the signal and stops dispatching.
        subagentClient: makeSubagentClient({
          calls,
          onCall: () => controller.abort(),
        }),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);

    expect(calls).not.toContain("integrate components");
  });
});
