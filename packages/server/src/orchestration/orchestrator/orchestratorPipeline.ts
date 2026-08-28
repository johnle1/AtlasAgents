/**
 * Core orchestration pipeline for executing end-user tasks.
 *
 * @remarks
 * Extracts pipeline phases from AgentOrchestrator.runTask for better testability.
 * The pipeline executes the following phases:
 * 1. Task initialization and experience recording setup
 * 2. Context building and skill selection
 * 3. One unified agent turn — direct answer, tool use, or (for genuinely
 *    multi-step work) a checklist the agent maintains via `update_plan`,
 *    optionally fanning independent steps out to the hidden subagent pool
 *    via `run_steps_parallel`
 * 4. Experience recording and outcome reporting
 *
 * The pipeline supports cancellation via AbortSignal and emits progress
 * updates throughout execution. There is no separate up-front planning
 * phase — see `agentTurn.ts` for why, and `run_steps_parallel`/
 * `orchestratorPipelineHelpers.ts`'s `runAgentPool` for where the DAG
 * worker-pool machinery still lives (now reached only from that tool).
 */

import { randomUUID } from "node:crypto";
import type { TaskFrame } from "../../transport/frames.js";
import { clampUsage, estimateTokensFromText } from "@atlasagents/shared";
import { Agent } from "../agent/agent.js";
import { Subagent } from "../subagent/subagent.js";
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

    const agentOllama = providerRegistry.getRoleClient(
      "agent",
      modelOverrides?.agentProvider,
    );
    const agent = new Agent({
      ollama: agentOllama,
      config,
      numCtx: agentNumCtx,
      keepAlive,
    });

    // Only ever invoked now via the hidden pool behind `run_steps_parallel`
    // (see `agentTurn.ts`) — never as an up-front planning phase.
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
    usedTokens +=
      estimateTokensFromText(contextHeader) + estimateTokensFromText(skillBody);
    emitUsage(usedTokens, contextWindow);

    phase = "agent.turn";
    const turnResult = await runAgentTurn(
      { ollama: agentOllama, config, agent, subagent, experienceRecorder },
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
      },
    );

    usedTokens += estimateTokensFromText(turnResult.content);
    emitUsage(usedTokens, contextWindow);

    // GPU/CPU placement check — the agent (and possibly the hidden subagent
    // pool, if `run_steps_parallel` ran) has now had every chance to load a
    // model, so this is the single point where a spilled model would show
    // up. Unlike the old two-phase pipeline (one check after planning, one
    // after the pool), there's no longer a clean "planning done, pool not
    // started yet" boundary to split this into two — read/write/run_command
    // and a hidden parallel batch can all happen within the same turn.
    const placementTargets = [
      ...(agentProviderName === "ollama" ? [agentModel] : []),
      ...(subagentProviderName === "ollama" ? [subagentModel] : []),
    ];
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
      subagentModel,
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
