/**
 * Integration tests — the full `runOrchestratorPipeline` task-execution path
 * (unified agent-turn loop; see `agentTurn.ts`).
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : runOrchestratorPipeline, the REAL `Agent` and
 *                          `Subagent` classes it constructs internally (see
 *                          "Why deps.agent doesn't matter" below), the REAL
 *                          `runAgentTurn` loop, `preparePlanningContext`.
 * Mocks                  : only the true external boundary — the two
 *                          role-routed `IOllamaClient`s returned by a fake
 *                          `IProviderRegistry.getRoleClient`, each answering
 *                          with canned `chatWithTools` turns. `contextBuilder`,
 *                          `skillManager`, `sessionManager`,
 *                          `experienceRecorder`, and `config` are light
 *                          interface fakes; `workspace`/`terminal`/
 *                          `planBroker` are unused-but-typed stubs (these
 *                          scenarios never read/write files or review a plan,
 *                          so their real implementations are never reached).
 *
 * Why `deps.agent` doesn't matter
 * -------------------------------
 * `runOrchestratorPipeline` destructures `deps.agent` as `_unused` and
 * reconstructs its own `Agent`/`Subagent` from `providerRegistry.getRoleClient`
 * (see orchestratorPipeline.ts, "Agent passed to AgentOrchestrator but
 * reconstructed here with model-specific provider client"). That means the
 * REAL `runAgentTurn` control flow and tool-call parsing all execute for
 * real in this test — only the LLM itself is faked, which is the correct
 * integration boundary.
 *
 * Why this file exists
 * ---------------------
 * This session found and fixed two bugs that lived exactly at this seam and
 * that no unit test could catch:
 *   1. `preparePlanningContext` passed the SUBAGENT's model to
 *      `contextBuilder.build`, even though the resulting header is only ever
 *      injected into the AGENT's prompt.
 *   2. The workspace-snapshot injection checked the SUBAGENT's tool-support
 *      flag to decide whether the AGENT needs a workspace snapshot.
 * Both modules involved passed their own unit tests throughout — the bug was
 * purely in which value crossed the wire between them. This file drives a
 * real `runOrchestratorPipeline()` call and asserts on exactly those two
 * crossing points, so a regression here fails a test instead of shipping.
 *
 * Category checklist:
 *   ✅ Happy path          — the agent turn finishes directly, ok: true
 *   ✅ Contract consistency — agent's model reaches contextBuilder, not subagent's
 *   ✅ Contract consistency — agent's model reaches its own client, not subagent's
 *   ✅ Failure propagation — a thrown model error yields a formatted error frame and rejects
 *   ✅ State integrity      — an aborted pipeline stops before any model turn runs
 *   ✅ Model placement      — a spilled-model warning is joined before the pipeline resolves
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
import type { Message } from "../../../packages/server/src/orchestration/types.js";
import type { PerConnection } from "../../../packages/server/src/container/types.js";
import type { Agent } from "../../../packages/server/src/orchestration/agent/agent.js";
import type { TaskFrame } from "../../../packages/server/src/transport/frames.js";
import { runOrchestratorPipeline } from "../../../packages/server/src/orchestration/orchestrator/orchestratorPipeline.js";
import type { OrchestratorPipelineDeps } from "../../../packages/server/src/orchestration/orchestrator/orchestratorPipelineTypes.js";

// ---------------------------------------------------------------------------
// Canned model turns
// ---------------------------------------------------------------------------

/** A fake `IOllamaClient` whose `chatWithTools` finishes the turn on the first call. */
const makeAgentFinishClient = (
  summary = "did the thing",
  onCall?: (model: string, messages: Message[]) => void,
): IOllamaClient =>
  ({
    chatWithTools: async (model: string, messages: Message[]) => {
      onCall?.(model, messages);
      return { content: "", toolCalls: [{ name: "finish", args: { summary, keyFindings: [] } }] };
    },
    chat: async () => "unused",
  }) as unknown as IOllamaClient;

// ---------------------------------------------------------------------------
// Minimal fakes for the rest of OrchestratorPipelineDeps
// ---------------------------------------------------------------------------

const makeConfig = (
  overrides: Partial<Record<
    | "agentModel"
    | "subagentModel"
    | "agentModelSupportsTools"
    | "subagentModelSupportsTools"
    | "agentModelSupportsThinking",
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
    getAgentModelSupportsThinking: async () =>
      overrides.agentModelSupportsThinking ?? true,
    getMaxRetries: async () => 3,
    getMaxContextBudget: async () => 0.2,
    // Both roles default to the built-in "ollama" provider so
    // runOrchestratorPipeline's provider guard resolves numCtx via
    // contextBuilder.resolveNumCtx rather than skipping it.
    getAgentProvider: async () => "ollama",
    getSubagentProvider: async () => "ollama",
    getNumCtx: async () => undefined,
    getKeepAlive: async () => "30m",
  }) as unknown as IConfigManager;

const makeContextBuilder = (onBuild?: (taskText: string, modelOverride?: string) => void): IContextBuilder => ({
  build: async (taskText: string, modelOverride?: string) => {
    onBuild?.(taskText, modelOverride);
    return "";
  },
  // No scenario in this file asserts on detected-stack wiring — a stack-less
  // stub is enough to satisfy preparePlanningContext's real (non-faked) call.
  detectStack: async () => undefined,
  // orchestratorPipeline.ts resolves num_ctx for both roles up front via
  // this method; no scenario here asserts on the actual value, so a fixed
  // stub is enough.
  resolveNumCtx: async () => 4096,
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

/**
 * `perConn.workspace`/`terminal`/`planBroker` are never actually reached by
 * these scenarios: the agent finishes on its first turn without any
 * file/command tool call or plan review.
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
  subagentClient?: IOllamaClient;
}): OrchestratorPipelineDeps => ({
  contextBuilder: opts.contextBuilder,
  skillManager: makeSkillManager(),
  sessionManager: makeSessionManager(),
  experienceRecorder: fakeExperienceRecorder(),
  agent: {} as unknown as Agent, // unused — see module doc
  providerRegistry: makeProviderRegistry(
    opts.agentClient,
    opts.subagentClient ?? opts.agentClient,
  ),
  config: opts.config,
});

const collectFrames = () => {
  const frames: TaskFrame[] = [];
  return { frames, emit: (frame: TaskFrame) => frames.push(frame) };
};

describe("orchestrator pipeline — happy path", () => {
  it("runs the agent turn to a direct finish with ok: true", async () => {
    const config = makeConfig();
    const { frames, emit } = collectFrames();

    const outcome = await runOrchestratorPipeline(
      makeDeps({
        config,
        contextBuilder: makeContextBuilder(),
        agentClient: makeAgentFinishClient("did the thing"),
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
    expect(outcome.results[0]?.content).toBe("did the thing");

    const statusStages = frames
      .filter((frame): frame is Extract<TaskFrame, { kind: "status" }> => frame.kind === "status")
      .map((frame) => frame.stage);
    // agentTurn emits an initial "thinking" status (mapped to "understanding")
    // and a final "done" status (mapped to "ready") — see agentTurn.ts's
    // emitSubagentStatus.
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
        agentClient: makeAgentFinishClient(),
      }),
      {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit: () => {},
        signal: new AbortController().signal,
        perConn: makePerConnection(),
      },
    );

    // This is the exact regression fixed in the original planner-based
    // pipeline: contextBuilder must see "agent-only-model", never
    // "subagent-only-model". Still applies — preparePlanningContext is
    // unchanged by the unified-loop rewrite.
    expect(capturedModel).toBe("agent-only-model");
  });

  it("queries the agent model with the agent's own client, not the subagent's", async () => {
    let modelSeenByAgentClient: string | undefined;
    const config = makeConfig({ agentModel: "agent-only-model", subagentModel: "subagent-only-model" });
    const subagentClient = { chatWithTools: vi.fn() } as unknown as IOllamaClient;

    await runOrchestratorPipeline(
      makeDeps({
        config,
        contextBuilder: makeContextBuilder(),
        agentClient: makeAgentFinishClient(undefined, (model) => {
          modelSeenByAgentClient = model;
        }),
        subagentClient,
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
    // No multi-step work was requested, so run_steps_parallel never fires
    // and the subagent-role client is never touched.
    expect(subagentClient.chatWithTools).not.toHaveBeenCalled();
  });
});

describe("orchestrator pipeline — failure propagation", () => {
  // A subtask failing inside a hidden run_steps_parallel batch no longer
  // throws out of the pipeline — it becomes tool feedback the agent sees and
  // reacts to (see runStepsParallelHandler.ts / agentTurn.ts's
  // runStepsParallel). The pipeline-level failure/rethrow path is still
  // reachable, though: an unhandled exception from the model client itself
  // (e.g. a network error) still propagates, still gets a formatted error
  // frame, and still rejects — that's what this covers now.
  it("rejects with a descriptive error when the model client throws", async () => {
    const config = makeConfig();
    const agentClient = {
      chatWithTools: async () => {
        throw new Error("simulated model connection failure");
      },
      chat: async () => "unused",
    } as unknown as IOllamaClient;

    await expect(
      runOrchestratorPipeline(
        makeDeps({ config, contextBuilder: makeContextBuilder(), agentClient }),
        {
          session: { userId: "u1", requesterId: "r1" },
          taskText: "do the thing",
          emit: () => {},
          signal: new AbortController().signal,
          perConn: makePerConnection(),
        },
      ),
    ).rejects.toThrow(/simulated model connection failure/i);
  });

  it("emits an error frame with formatted failure detail before rejecting", async () => {
    const config = makeConfig();
    const { frames, emit } = collectFrames();
    const agentClient = {
      chatWithTools: async () => {
        throw new Error("simulated model connection failure");
      },
      chat: async () => "unused",
    } as unknown as IOllamaClient;

    await runOrchestratorPipeline(
      makeDeps({ config, contextBuilder: makeContextBuilder(), agentClient }),
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
    expect(errorFrame?.message).toMatch(/simulated model connection failure/i);
  });
});

describe("orchestrator pipeline — abort handling (state integrity)", () => {
  it("rejects without running any model turn when the signal is already aborted", async () => {
    const config = makeConfig();
    const agentChat = vi.fn();
    const agentClient = { chatWithTools: agentChat, chat: async () => "unused" } as unknown as IOllamaClient;

    const controller = new AbortController();
    controller.abort();

    await expect(
      runOrchestratorPipeline(
        makeDeps({ config, contextBuilder: makeContextBuilder(), agentClient }),
        {
          session: { userId: "u1", requesterId: "r1" },
          taskText: "do the thing",
          emit: () => {},
          signal: controller.signal,
          perConn: makePerConnection(),
        },
      ),
    ).rejects.toThrow(/aborted/i);

    expect(agentChat).not.toHaveBeenCalled();
  });
});

describe("orchestrator pipeline — model placement warning", () => {
  it("joins the placement check before the pipeline promise resolves", async () => {
    // Unlike the old two-phase pipeline (a backgrounded check after
    // planning, plus a second awaited check after the pool), the unified
    // loop has exactly one placement check, directly awaited at the end of
    // the turn — so there's no backgrounding race to prove here, just that
    // its warning reliably lands in `frames` by the time the outcome
    // resolves.
    const config = makeConfig();
    const { frames, emit } = collectFrames();

    const modelPlacementReporter = {
      reportPlacement: async () => ["gemma3:27b spilled to CPU (52% GPU)"],
      forgetScope: () => {},
    };

    const outcome = await runOrchestratorPipeline(
      {
        ...makeDeps({
          config,
          contextBuilder: makeContextBuilder(),
          agentClient: makeAgentFinishClient("did the thing"),
        }),
        modelPlacementReporter,
      },
      {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit,
        signal: new AbortController().signal,
        perConn: makePerConnection(),
      },
    );

    expect(outcome.ok).toBe(true);
    expect(frames.some((frame) => frame.kind === "warning")).toBe(true);
  });
});

describe("orchestrator pipeline — regression guard: override short-circuits an unset server model", () => {
  it("uses the override without ever calling getAgentModel when a per-task override is supplied (normal)", async () => {
    // Reproduces the real ConfigManager.getAgentModel() contract (throws on
    // an empty server-side model) rather than makeConfig()'s always-succeeds
    // fake — the bug this guards against was `await config.getAgentModel()`
    // running unconditionally *before* the override was consulted, so an
    // empty server config hard-failed every task even with a valid override.
    const getAgentModel = vi.fn(async () => {
      throw new Error("No agent model configured. Run /model to choose one.");
    });
    let capturedModel: string | undefined;
    const config = {
      ...makeConfig(),
      getAgentModel,
    };

    const outcome = await runOrchestratorPipeline(
      makeDeps({
        config,
        contextBuilder: makeContextBuilder((_taskText, modelOverride) => {
          capturedModel = modelOverride;
        }),
        agentClient: makeAgentFinishClient("did the thing"),
      }),
      {
        session: { userId: "u1", requesterId: "r1" },
        taskText: "do the thing",
        emit: () => {},
        signal: new AbortController().signal,
        perConn: makePerConnection(),
        modelOverrides: { agentModel: "override-model" },
      },
    );

    expect(outcome.ok).toBe(true);
    expect(capturedModel).toBe("override-model");
    expect(getAgentModel).not.toHaveBeenCalled();
  });

  it("still throws the real error when there is no override and the server model is unset (normal — no regression the other way)", async () => {
    const config = {
      ...makeConfig(),
      getAgentModel: async () => {
        throw new Error("No agent model configured. Run /model to choose one.");
      },
    };

    await expect(
      runOrchestratorPipeline(
        makeDeps({
          config,
          contextBuilder: makeContextBuilder(),
          agentClient: makeAgentFinishClient("did the thing"),
        }),
        {
          session: { userId: "u1", requesterId: "r1" },
          taskText: "do the thing",
          emit: () => {},
          signal: new AbortController().signal,
          perConn: makePerConnection(),
        },
      ),
    ).rejects.toThrow("No agent model configured");
  });
});
