/**
 * Core orchestration pipeline for executing end-user tasks.
 *
 * @remarks
 * Extracts pipeline phases from AgentOrchestrator.runTask for better testability.
 * The pipeline executes the following phases:
 * 1. Task initialization and experience recording setup
 * 2. Context building and skill selection
 * 3. One unified agent turn — direct answer, tool use, or (for genuinely
 *    multi-step work) a checklist the agent maintains via `update_plan`
 * 4. Experience recording and outcome reporting
 *
 * The pipeline supports cancellation via AbortSignal and emits progress
 * updates throughout execution. There is no separate up-front planning
 * phase — see `agentTurn.ts` for why. A single agent model handles the
 * whole turn; no subagent or worker pool is constructed.
 */

import { randomUUID } from "node:crypto";
import { clampUsage, estimateTokensFromText } from "@atlasagents/shared";
import { runAgentTurn } from "../agent/agentTurn.js";
import type { OrchestrationOutcome } from "../types.js";
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
import { emptyPlan, preparePlanningContext } from "./orchestratorPipelineHelpers.js";

/**
 * Runs the complete orchestration pipeline for a single task.
 *
 * @remarks
 * This is the core pipeline function that coordinates all phases of task execution.
 * It handles context building, skill selection, the unified agent turn, and
 * experience recording. The function is designed to be transport-agnostic
 * and can be called from any router implementation.
 *
 * @param deps - Orchestrator dependencies including all required services
 * @param params - Task parameters including session info, task text, and callbacks
 *
 * @returns Task execution outcome with plan, results, and error status
 *
 * @throws {@link AbortError} When the operation is cancelled via AbortSignal
 * @throws {@link NotFoundError} When per-connection context is required but missing
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
    clientEnv,
  } = params;

  // Unique ID for this task run — used for experience recording, auditing, and linking logs across the pipeline.
  const taskId = randomUUID();
  // Updated throughout pipeline phases; returned to caller with final status, plan, and partial/complete results.
  let outcome: OrchestrationOutcome = {
    ok: false,
    plan: emptyPlan(),
    results: [],
    error: "not started",
  };

  const emitToken = (text: string): void => {
    if (text.length > 0) {
      emit({ kind: "token", text });
    }
  };

  const emitUsage = (usedTokens: number, contextWindow: number): void => {
    const clamped = clampUsage(usedTokens, contextWindow);
    if (clamped) {
      emit({ kind: "usage", ...clamped });
    }
  };

  // Track current pipeline phase for error reporting — allows diagnostics to pinpoint
  // where failure occurred (e.g., "failed at phase: agent.turn").
  let phase = "init";
  let agentModel = "";
  let primaryError: unknown;

  try {
    // Fail fast on abort — prevents unnecessary context building and agent queries
    // if the client has already cancelled the operation.
    if (signal.aborted) {
      throw new AbortError("Operation aborted");
    }

    // Model resolution: per-task overrides take precedence over server config.
    // This allows callers to experiment with different model endpoints/versions per-task.
    // Short-circuit BEFORE calling getAgentModel() — it throws on an empty
    // server config, which previously hard-failed every task even when a
    // valid client override was supplied (see agentTurn.ts/subagent.ts,
    // which already short-circuit this way).
    agentModel =
      modelOverrides?.agentModel?.trim() || (await config.getAgentModel());

    // Resolve num_ctx/keep_alive once per task, up front — the model tag is
    // fixed for this task's lifetime, so this doesn't need to happen per
    // model call. Only queries Ollama (via contextBuilder.resolveNumCtx,
    // cached per tag) when the role is actually on the "ollama" provider —
    // an OpenAI-compatible role has no num_ctx concept and skipping the
    // check avoids a pointless local /api/show round-trip.
    const agentProviderName =
      modelOverrides?.agentProvider ?? (await config.getAgentProvider());
    const agentNumCtx =
      agentProviderName === "ollama"
        ? await contextBuilder.resolveNumCtx(agentModel)
        : undefined;
    const contextWindow = agentNumCtx ?? 0;
    let usedTokens = estimateTokensFromText(taskText);
    emitUsage(usedTokens, contextWindow);

    const agentOllama = providerRegistry.getRoleClient(
      "agent",
      modelOverrides?.agentProvider,
    );

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
    usedTokens +=
      estimateTokensFromText(contextHeader) + estimateTokensFromText(skillBody);
    emitUsage(usedTokens, contextWindow);

    phase = "agent.turn";
    const turnResult = await runAgentTurn(
      { ollama: agentOllama, config, experienceRecorder },
      {
        taskId,
        taskText,
        contextHeader,
        skillBody,
        clientEnv,
        perConn,
        modelOverrides,
        approvalMode,
        maxSubagents,
        emit,
        emitToken,
        signal,
        contextWindow,
      },
    );

    usedTokens += estimateTokensFromText(turnResult.content);
    emitUsage(usedTokens, contextWindow);

    // GPU/CPU placement check — the agent has now had every chance to load
    // a model, so this is the single point where a spilled model would
    // show up.
    const placementTargets = agentProviderName === "ollama" ? [agentModel] : [];
    if (modelPlacementReporter && placementTargets.length > 0 && !signal.aborted) {
      const messages = await modelPlacementReporter
        .reportPlacement(placementTargets, session.requesterId)
        .catch(() => [] as string[]);
      if (!signal.aborted) {
        messages.forEach((message) => emit({ kind: "warning", message }));
      }
    }

    outcome = {
      ok: turnResult.ok,
      plan: emptyPlan(),
      results: [{ id: 1, content: turnResult.content }],
    };
  } catch (err) {
    primaryError = err;
    // Format error with context (phase, models used) to help downstream error handling and logging.
    const detail = formatOrchestratorFailure(err, {
      phase,
      agentModel,
    });
    const message = err instanceof Error ? err.message : String(err);
    outcome = {
      ok: false,
      plan: emptyPlan(),
      results: [],
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
