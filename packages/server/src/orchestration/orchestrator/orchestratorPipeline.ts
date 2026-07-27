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
  } = deps;

  const {
    taskText,
    emit,
    signal,
    perConn,
    modelOverrides,
    maxSubagents = 3,
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

  const agent = new Agent({
    ollama: providerRegistry.getRoleClient(
      "agent",
      modelOverrides?.agentProvider,
    ),
    config,
  });

  const subagent = new Subagent({
    ollama: providerRegistry.getRoleClient(
      "subagent",
      modelOverrides?.subagentProvider,
    ),
    config,
    agent: agent,
    extraTools: perConn?.tokenSaveTools,
  });

  const emitToken = (text: string): void => {
    if (text.length > 0) {
      emit({ kind: "token", text });
    }
  };

  const emitStatus = (frame: Extract<TaskFrame, { kind: "status" }>): void => {
    emit(frame);
  };

  // Track current pipeline phase for error reporting — allows diagnostics to pinpoint
  // where failure occurred (e.g., "failed at phase: agent.plan").
  let phase = "init";
  let agentModel = "";
  let subagentModel = "";
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

    emitStatus({
      kind: "status",
      source: "agent",
      stage: "ready",
      icon: "✓",
      message: `Plan ready · ${plan.agentCount} group${plan.agentCount === 1 ? "" : "s"} · ${plan.execution}`,
    });

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
  }

  // Rethrow after experience recording is complete — ensures audit trail is preserved
  // even when caller's error handling stops propagation. Return outcome if no error.
  if (primaryError) {
    throw primaryError;
  }

  return outcome;
};
