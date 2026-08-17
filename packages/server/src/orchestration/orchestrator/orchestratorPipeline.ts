/**
 * Core orchestration pipeline for executing end-user tasks.
 *
 * @remarks
 * Extracts pipeline phases from AgentOrchestrator.runTask for better testability.
 * The pipeline executes the following phases:
 * 1. Task initialization and experience recording setup
 * 2. Context building and skill selection
 * 3. Agent planning with DAG generation
 * 4. Agent pool execution with dependency management
 * 5. Result combination or single result emission
 * 6. Experience recording and outcome reporting
 *
 * The pipeline supports cancellation via AbortSignal and emits progress
 * updates throughout execution. Worker pool manages concurrent subtask execution
 * with proper dependency resolution and deadlock detection.
 */

import { randomUUID } from "node:crypto";
import type { TaskFrame } from "../../transport/frames.js";
import { clampUsage, estimateTokensFromText } from "@atlasagents/shared";
import { Agent } from "../agent/agent.js";
import { Subagent } from "../subagent/subagent.js";
import { modeLabelFromMaxAgents } from "../planHelpers.js";
import type {
  SubagentPlan,
  OrchestrationOutcome,
  ToolResultSummary,
} from "../types.js";
import {
  formatOrchestratorFailure,
  markOrchestratorErrorReported,
} from "../taskErrors.js";
import { AbortError, NotFoundError } from "../../errors/index.js";
import { logger } from "../../utils/logger.js";
import type {
  OrchestratorPipelineDeps,
  OrchestratorPipelineParams,
} from "./orchestratorPipelineTypes.js";
import {
  emitFinalResult,
  emptyPlan,
  preparePlanningContext,
  runAgentPool,
  runPlanningWithRevisions,
  toOrderedResults,
} from "./orchestratorPipelineHelpers.js";

/**
 * Runs the complete orchestration pipeline for a single task.
 *
 * @remarks
 * This is the core pipeline function that coordinates all phases of task execution.
 * It handles context building, skill selection, agent planning, subagent pool execution,
 * result combination, and experience recording. The function is designed to be
 * transport-agnostic and can be called from any router implementation.
 *
 * The pipeline uses a worker pool pattern for concurrent subtask execution with
 * proper dependency resolution. Subtasks are executed in dependency order, and
 * the pool size is determined by the maxSubagents parameter and plan complexity.
 *
 * @param deps - Orchestrator dependencies including all required services
 * @param params - Task parameters including session info, task text, and callbacks
 *
 * @returns Task execution outcome with plan, results, and error status
 *
 * @throws {@link AbortError} When the operation is cancelled via AbortSignal
 * @throws {@link NotFoundError} When per-connection context is required but missing
 * @throws {@link OrchestrationError} When subtask execution fails or deadlock occurs
 */
export const runOrchestratorPipeline = async (
  deps: OrchestratorPipelineDeps,
  params: OrchestratorPipelineParams,
): Promise<OrchestrationOutcome> => {
  const {
    contextBuilder,
    skillManager,
    sessionManager,
    experienceRecorder,
    // Agent passed to AgentOrchestrator but reconstructed here with model-specific
    // provider client — allows for per-task provider overrides (e.g., different LLM endpoint).
    agent: _unused,
    providerRegistry,
    config,
    modelPlacementReporter,
  } = deps;

  const {
    session,
    taskText,
    emit,
    signal,
    perConn,
    modelOverrides,
    maxSubagents = 3,
    approvalMode = "default",
  } = params;

  // Unique ID for this task run — used for experience recording, auditing, and linking logs across the pipeline.
  const taskId = randomUUID();
  let plan: SubagentPlan = emptyPlan();
  // Accumulates results keyed by subtask id as they complete. Used to build final ordered results
  // even if execution fails mid-way, so partial results are not lost.
  const resultMap = new Map<number, ToolResultSummary>();
  // Updated throughout pipeline phases; returned to caller with final status, plan, and partial/complete results.
  let outcome: OrchestrationOutcome = {
    ok: false,
    plan,
    results: [],
    error: "not started",
  };

  const emitToken = (text: string): void => {
    if (text.length > 0) {
      emit({ kind: "token", text });
    }
  };

  const emitStatus = (frame: Extract<TaskFrame, { kind: "status" }>): void => {
    emit(frame);
  };

  const emitUsage = (usedTokens: number, contextWindow: number): void => {
    const clamped = clampUsage(usedTokens, contextWindow);
    if (clamped) {
      emit({ kind: "usage", ...clamped });
    }
  };

  // Track current pipeline phase for error reporting — allows diagnostics to pinpoint
  // where failure occurred (e.g., "failed at phase: agent.plan").
  let phase = "init";
  let agentModel = "";
  let subagentModel = "";
  // Joined in the `finally` block below so any warning the fire-and-forget
  // placement check wants to emit is guaranteed to happen before this
  // function returns and the caller closes the stream — see where it's
  // assigned for why a plain fire-and-forget wasn't safe.
  let modelPlacementPromise: Promise<void> = Promise.resolve();
  let primaryError: unknown;

  try {
    // Fail fast on abort — prevents unnecessary context building and agent queries
    // if the client has already cancelled the operation.
    if (signal.aborted) {
      throw new AbortError("Operation aborted");
    }

    // Model resolution: per-task overrides take precedence over server config.
    // This allows callers to experiment with different model endpoints/versions per-task.
    const serverAgent = await config.getAgentModel();
    const serverSubagent = await config.getSubagentModel();
    agentModel = modelOverrides?.agentModel?.trim() || serverAgent;
    subagentModel = modelOverrides?.subagentModel?.trim() || serverSubagent;

    // Resolve num_ctx/keep_alive once per task, up front — Agent/Subagent are
    // constructed fresh per task with a fixed model tag for their lifetime,
    // so this doesn't need to happen per model call. Only queries Ollama
    // (via contextBuilder.resolveNumCtx, cached per tag) when the role is
    // actually on the "ollama" provider — an OpenAI-compatible role has no
    // num_ctx concept and skipping the check avoids a pointless local
    // /api/show round-trip.
    const agentProviderName =
      modelOverrides?.agentProvider ?? (await config.getAgentProvider());
    const subagentProviderName =
      modelOverrides?.subagentProvider ?? (await config.getSubagentProvider());
    const agentNumCtx =
      agentProviderName === "ollama"
        ? await contextBuilder.resolveNumCtx(agentModel)
        : undefined;
    const subagentNumCtx =
      subagentProviderName === "ollama"
        ? await contextBuilder.resolveNumCtx(subagentModel)
        : undefined;
    const keepAlive = await config.getKeepAlive();
    const contextWindow = agentNumCtx ?? subagentNumCtx ?? 0;
    let usedTokens = estimateTokensFromText(taskText);
    emitUsage(usedTokens, contextWindow);

    const agent = new Agent({
      ollama: providerRegistry.getRoleClient(
        "agent",
        modelOverrides?.agentProvider,
      ),
      config,
      numCtx: agentNumCtx,
      keepAlive,
    });

    const subagent = new Subagent({
      ollama: providerRegistry.getRoleClient(
        "subagent",
        modelOverrides?.subagentProvider,
      ),
      config,
      agent: agent,
      extraTools: perConn?.tokenSaveTools,
      numCtx: subagentNumCtx,
      keepAlive,
    });

    await experienceRecorder.start(taskId, taskText);

    if (!perConn) {
      throw new NotFoundError(
        "Workspace not configured for this connection — missing per-connection context",
      );
    }

    phase = "context";
    const { contextHeader, skillBody } = await preparePlanningContext(
      { contextBuilder, skillManager, sessionManager, config },
      { taskText, agentModel, modelOverrides, perConn, emit, signal },
    );

    emitStatus({
      kind: "status",
      source: "agent",
      stage: "understanding",
      icon: "◌",
      message: "Agent planning the task...",
    });

    phase = "agent.plan";
    const modeLabel = modeLabelFromMaxAgents(maxSubagents);
    // Planning may include multiple revisions if the agent's first attempt had validation gaps
    // (e.g., incomplete verification steps, missing COMMAND PLAN). Supports user review/edit via hooks.
    const planningResult = await runPlanningWithRevisions(agent, {
      taskText,
      contextHeader,
      skillBody,
      modelOverrides,
      maxSubagents,
      modeLabel,
      perConn,
      sessionManager,
      emit,
      signal,
    });
    // User explicitly skipped the task during review — emit and exit cleanly (success, not error).
    if (planningResult.skipped) {
      emitToken("\nTask skipped.\n");
      outcome = {
        ok: true,
        plan: emptyPlan(),
        results: [],
      };
      return outcome;
    }
    plan = planningResult.plan;
    usedTokens +=
      estimateTokensFromText(contextHeader) +
      estimateTokensFromText(skillBody);
    emitUsage(usedTokens, contextWindow);

    if (approvalMode === "plan") {
      emitToken(
        "\nPlan complete (plan mode — not executing). Shift+Tab to leave plan mode.\n",
      );
      outcome = { ok: true, plan, results: [] };
      return outcome;
    }

    emitStatus({
      kind: "status",
      source: "agent",
      stage: "ready",
      icon: "✓",
      message: `Plan ready · ${plan.agentCount} group${plan.agentCount === 1 ? "" : "s"} · ${plan.execution}`,
    });

    // Reused by both placement checks below — the agent/subagent providers
    // and resolved model tags don't change for the rest of this task.
    const placementTargets = [
      ...(agentProviderName === "ollama" ? [agentModel] : []),
      ...(subagentProviderName === "ollama" ? [subagentModel] : []),
    ];

    // Backgrounded GPU/CPU placement check — started here rather than
    // awaited so it never adds latency to the pool phase below, but joined
    // in the `finally` block rather than left fully fire-and-forget. The
    // agent model has provably finished inference by this point (models
    // load lazily, so checking any earlier would find /api/ps empty), and
    // the pool phase runs for seconds afterward, so in the common case this
    // ~5ms call has already settled by the time the join happens and adds
    // no wait at all. But "the pool phase takes seconds" is a timing
    // assumption, not a guarantee — a single-subtask plan against a fast
    // local model, or a slow /api/ps round-trip, could still have this
    // resolve after the pool phase finishes. Without the join, that
    // `.then()` could fire its `emit({kind:"warning"})` after this
    // function had already returned and the caller closed the stream —
    // calling `onNext` after `onComplete` on the underlying RSocket
    // responder, which the protocol doesn't allow.
    //
    // This only catches the *agent* model spilling — at this point the
    // subagent has not run yet, so it is never loaded, and its placement
    // check below always finds nothing here (see the second check after
    // runAgentPool, which is what actually catches a spilling subagent).
    if (modelPlacementReporter && placementTargets.length > 0) {
      modelPlacementPromise = modelPlacementReporter
        .reportPlacement(placementTargets, session.requesterId)
        .then((messages) => {
          if (!signal.aborted) {
            messages.forEach((message) => emit({ kind: "warning", message }));
          }
        })
        .catch(() => {});
    }

    phase = "agent.pool";
    const ordered = await runAgentPool(subagent, {
      taskId,
      plan,
      skillBody,
      maxSubagents,
      experienceRecorder,
      perConn,
      modelOverrides,
      resultMap,
      emit,
      emitStatus,
      signal,
    });

    // Second placement check — the subagent model has now definitely run at
    // least once (models load lazily), so this is what actually catches a
    // spilling subagent that the check above could not have seen yet.
    // Awaited directly rather than backgrounded: it runs between phases, not
    // concurrently with one, so there's no `onNext`-after-`onComplete` risk
    // to guard against with a joined promise like the first check needs.
    if (modelPlacementReporter && placementTargets.length > 0 && !signal.aborted) {
      const messages = await modelPlacementReporter
        .reportPlacement(placementTargets, session.requesterId)
        .catch(() => [] as string[]);
      if (!signal.aborted) {
        messages.forEach((message) => emit({ kind: "warning", message }));
      }
    }

    // Single-subtask plans skip synthesis — emit result directly. Multi-subtask plans
    // invoke agent.combine to synthesize outputs into one coherent final answer.
    phase = plan.subtasks.length === 1 ? "emit.single" : "agent.combine";
    // Emits final user-facing result: either the single subtask output or a synthesized answer.
    await emitFinalResult(agent, {
      taskText,
      plan,
      ordered,
      modelOverrides,
      emitToken,
      emitStatus,
      signal,
    });
    usedTokens += estimateTokensFromText(
      ordered.map((result) => result.content).join("\n"),
    );
    emitUsage(usedTokens, contextWindow);

    emitStatus({
      kind: "status",
      source: "agent",
      stage: "ready",
      icon: "✓",
      message: "All tasks done",
    });

    outcome = { ok: true, plan, results: ordered };
  } catch (err) {
    primaryError = err;
    // Format error with context (phase, models used) to help downstream error handling and logging.
    const detail = formatOrchestratorFailure(err, {
      phase,
      agentModel,
      subagentModel,
    });
    const message = err instanceof Error ? err.message : String(err);
    // Preserve partial results even on failure (some subtasks may have completed before the error).
    outcome = {
      ok: false,
      plan,
      results: toOrderedResults(plan, resultMap),
      error: detail,
    };
    // Skip error emit if operation was cancelled (AbortSignal) or already reported upstream
    // to avoid duplicate/spurious error messages to the client.
    if (!signal.aborted && message !== "Aborted") {
      emit({ kind: "error", message: detail });
      markOrchestratorErrorReported(err);
    }
  } finally {
    // CRITICAL: Record experience even on failure — allows learning from failed attempts,
    // debugging, and ensures audit trail is complete. Catch and log any finish errors
    // to prevent them from masking the primary error.
    try {
      await experienceRecorder.finish(taskId, outcome);
    } catch (finishErr) {
      logger.error(
        { taskId, err: finishErr },
        "experienceRecorder.finish failed",
      );
    }
    // Join the backgrounded placement check (see where it's assigned) so
    // any warning it emits happens before this function returns and the
    // caller closes the stream, not after. Already-settled in the common
    // case, so this adds no wait; its own .catch(() => {}) means it never
    // rejects.
    await modelPlacementPromise;
  }

  // Rethrow after experience recording is complete — ensures audit trail is preserved
  // even when caller's error handling stops propagation. Return outcome if no error.
  if (primaryError) {
    throw primaryError;
  }

  return outcome;
};
