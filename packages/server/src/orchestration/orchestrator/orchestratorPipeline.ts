/**
 * <Summary>
 * What it does:
 *   Extracts pipeline phases from AdvisorOrchestrator.runTask.
 *
 * How it does it (step by step):
 *   1. Initializes task and experience recorder.
 *   2. Explores codebase if no session snapshot exists.
 *   3. Builds context and selects skills.
 *   4. Calls advisor to plan the task.
 *   5. Executes agent pool over the plan.
 *   6. Combines results or emits single result.
 *   7. Records outcome.
 *
 * Parameters:
 *   @param {OrchestratorPipelineDeps} deps - Orchestrator dependencies.
 *   @param {OrchestratorPipelineParams} params - Task parameters.
 *
 * Returns:
 *   @returns {Promise<OrchestrationOutcome>} - Task execution outcome.
 *
 * Dependencies:
 *   - All orchestrator services.
 *
 * Dependants:
 *   - AdvisorOrchestrator.runTask - uses these extracted phases.
 * </Summary>
 */

import { randomUUID } from "node:crypto";
import type { TaskFrame } from "../../transport/frames.js";
import { Agent } from "../agent/agent.js";
import { TaskSkippedError } from "../advisor/advisorErrors.js";
import { exploreCodebase } from "../exploreCodebase.js";
import { deriveAgentPlans, modeLabelFromMaxAgents } from "../planHelpers.js";
import type {
  AdvisorPlan,
  OrchestrationOutcome,
  PlannedSubtask,
} from "../types.js";
import { formatOrchestratorFailure } from "../taskErrors.js";
import {
  available,
  buildAgentBoardSnapshots,
  complete,
  createReadyQueue,
  take,
  WorkSignal,
  workerCountFor,
} from "../readyQueue.js";
import {
  AbortError,
  OrchestrationError,
  NotFoundError,
} from "../../errors/index.js";
import {
  buildSessionContext,
  emptyPlan,
  formatPoolProgress,
  formatPoolStart,
  toOrderedResults,
  type OrchestratorPipelineDeps,
  type OrchestratorPipelineParams,
} from "./orchestratorPipelineTypes.js";

export const runOrchestratorPipeline = async (
  deps: OrchestratorPipelineDeps,
  params: OrchestratorPipelineParams,
): Promise<OrchestrationOutcome> => {
  const {
    contextBuilder,
    skillManager,
    sessionManager,
    experienceRecorder,
    advisor,
    ollama,
    config,
  } = deps;

  const {
    session,
    taskText,
    emit,
    signal,
    perConn,
    modelOverrides,
    maxAgents = 3,
  } = params;

  const taskId = randomUUID();
  let plan: AdvisorPlan = emptyPlan();
  const resultMap = new Map<number, string>();
  let outcome: OrchestrationOutcome = {
    ok: false,
    plan,
    results: [],
    error: "not started",
  };

  const agent = new Agent({ ollama, config, advisor });

  const emitToken = (text: string): void => {
    if (text.length > 0) {
      emit({ kind: "token", text });
    }
  };

  const emitStatus = (frame: Extract<TaskFrame, { kind: "status" }>): void => {
    emit(frame);
  };

  let phase = "init";
  let advisorModel = "";
  let agentModel = "";
  let primaryError: unknown;

  try {
    if (signal.aborted) {
      throw new AbortError("Operation aborted");
    }

    const serverAdvisor = await config.getAdvisorModel();
    const serverAgent = await config.getAgentModel();
    advisorModel = modelOverrides?.advisorModel?.trim() || serverAdvisor;
    agentModel = modelOverrides?.agentModel?.trim() || serverAgent;

    await experienceRecorder.start(taskId, taskText);

    if (!perConn) {
      throw new NotFoundError(
        "Workspace not configured for this connection — missing per-connection context",
      );
    }

    if (!(await sessionManager.exists())) {
      emit({ kind: "token", text: "  Exploring codebase...\n" });
      const explored = await exploreCodebase(perConn.workspace, emit, signal);
      await sessionManager.saveSnapshot(explored.snapshot);
      emit({ kind: "token", text: "  ✓ Codebase snapshot saved.\n\n" });
    }

    phase = "context";
    const contextHeader = await contextBuilder.build(taskText, advisorModel);
    const selected = await skillManager.selectForTask(taskText);
    const skillBody = selected
      .map((s, i) => {
        const label = i === 0 ? "Stack skill" : "Domain skill";
        return `[${label}: ${s.name}.md]\n${s.content.trim()}`;
      })
      .join("\n\n");

    emitStatus({
      kind: "status",
      source: "advisor",
      stage: "understanding",
      icon: "◌",
      message: "Advisor planning the task...",
    });

    phase = "advisor.plan";
    const modeLabel = modeLabelFromMaxAgents(maxAgents);
    try {
      plan = await advisor.plan(
        taskText,
        contextHeader,
        skillBody,
        modelOverrides,
        {
          onThink: (text: string) => {
            emit({ kind: "think", text, advisor: true });
          },
          reviewPlan: (advisorPlan: AdvisorPlan) =>
            perConn.planBroker.request(
              taskText,
              advisorPlan.subtasks.map((s: PlannedSubtask) => s.text),
              advisorPlan.risks,
              deriveAgentPlans(advisorPlan.subtasks),
              advisorPlan.agentCount,
              advisorPlan.execution,
              modeLabel,
            ),
        },
        maxAgents,
      );
    } catch (err) {
      if (err instanceof TaskSkippedError) {
        emitToken("\nTask skipped.\n");
        outcome = {
          ok: true,
          plan: emptyPlan(),
          results: [],
        };
        return outcome;
      }
      throw err;
    }

    emitStatus({
      kind: "status",
      source: "advisor",
      stage: "ready",
      icon: "✓",
      message: `Plan ready · ${plan.agentCount} group${plan.agentCount === 1 ? "" : "s"} · ${plan.execution}`,
    });

    const totalTasks = plan.subtasks.length;
    const workerCount = workerCountFor(maxAgents, plan);
    const queue = createReadyQueue(plan.subtasks);
    const workSignal = new WorkSignal();

    const emitAdvisorPoolStatus = (
      message: string,
      icon: "◌" | "✓" = "◌",
      includeBoards = true,
    ): void => {
      emitStatus({
        kind: "status",
        source: "advisor",
        stage: "ready",
        icon,
        message,
        ...(includeBoards
          ? {
              agentBoards: buildAgentBoardSnapshots(plan.subtasks, queue),
            }
          : {}),
      });
    };

    emitAdvisorPoolStatus(
      formatPoolStart(plan.agentCount, workerCount, totalTasks),
    );

    phase = "agent.pool";

    const runWorker = async (): Promise<void> => {
      while (true) {
        if (signal.aborted) {
          throw new AbortError("Worker aborted");
        }

        const ready = available(queue);
        if (ready.length === 0) {
          if (queue.running.size === 0) {
            break;
          }
          await workSignal.wait();
          continue;
        }

        const subtask = ready[0];
        if (!subtask) {
          throw new OrchestrationError(
            "No subtask available despite ready queue not being empty",
          );
        }
        if (!take(queue, subtask.id)) {
          workSignal.broadcast();
          continue;
        }
        workSignal.broadcast();
        emitAdvisorPoolStatus(
          formatPoolProgress(
            queue.completed.size,
            totalTasks,
            queue.running.size,
            plan.agentCount,
          ),
        );

        const text = await agent.run({
          taskId,
          subtask: subtask.text,
          agentId: subtask.agentId,
          agentLabel: subtask.agentLabel,
          skillContent: skillBody,
          sessionContext: buildSessionContext(
            queue.completed,
            subtask.dependsOn,
          ),
          commandPlan: plan.commandPlan,
          workspace: perConn.workspace,
          terminal: perConn.terminal,
          recorder: experienceRecorder,
          emit,
          signal,
          modelOverrides,
          debug: modelOverrides?.debug === true,
        });

        const newlyReady = complete(queue, subtask.id, text);
        resultMap.set(subtask.id, text);

        const completedCount = queue.completed.size;
        const runningTasks = queue.running.size;
        emitAdvisorPoolStatus(
          formatPoolProgress(
            completedCount,
            totalTasks,
            runningTasks,
            plan.agentCount,
          ),
        );

        if (newlyReady.length > 0) {
          const unlockMsg =
            newlyReady.length === 1
              ? `Task ${subtask.id} done → unlocked: ${newlyReady[0]?.text.slice(0, 30) ?? "unknown"}`
              : `Task ${subtask.id} done → unlocked ${newlyReady.length} new tasks`;
          emitAdvisorPoolStatus(unlockMsg);
        }

        workSignal.broadcast();
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    if (queue.pending.size > 0) {
      throw new OrchestrationError(
        "Deadlock: cyclic or invalid dependencies in advisor plan",
      );
    }

    emitAdvisorPoolStatus(
      `${totalTasks}/${totalTasks} done · ${plan.agentCount} group${plan.agentCount === 1 ? "" : "s"}`,
      "✓",
      false,
    );

    const ordered = toOrderedResults(plan, resultMap);

    if (plan.subtasks.length === 1) {
      phase = "emit.single";
      emitToken(ordered[0]?.content ?? "");
    } else {
      phase = "advisor.combine";
      emitStatus({
        kind: "status",
        source: "advisor",
        stage: "combining",
        icon: "◌",
        message: `Combining results from ${plan.agentCount} groups...`,
      });
      for await (const token of advisor.combine(
        taskText,
        ordered,
        modelOverrides,
      )) {
        if (signal.aborted) {
          throw new AbortError("Combine aborted");
        }
        emitToken(token);
      }
    }

    emitStatus({
      kind: "status",
      source: "advisor",
      stage: "ready",
      icon: "✓",
      message: "All tasks done",
    });

    outcome = { ok: true, plan, results: ordered };
  } catch (err) {
    primaryError = err;
    const detail = formatOrchestratorFailure(err, {
      phase,
      advisorModel,
      agentModel,
    });
    const message = err instanceof Error ? err.message : String(err);
    outcome = {
      ok: false,
      plan,
      results: toOrderedResults(plan, resultMap),
      error: detail,
    };
    if (!signal.aborted && message !== "Aborted") {
      emit({ kind: "error", message: detail });
    }
  } finally {
    try {
      await experienceRecorder.finish(taskId, outcome);
    } catch (finishErr) {
      console.error(
        "[AdvisorOrchestrator] experienceRecorder.finish failed:",
        finishErr,
      );
    }
  }

  if (primaryError) {
    throw primaryError;
  }

  return outcome;
};
