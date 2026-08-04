/**
 * Helper functions for the orchestrator pipeline.
 *
 * @remarks
 * Provides utility functions for orchestrator pipeline operations including
 * context preparation, planning with revisions, agent pool execution,
 * and result combination. All functions are extracted for better testability
 * and separation of concerns from the main pipeline orchestration.
 */

import type {
  IContextBuilder,
  IExperienceRecorder,
  IConfigManager,
  ISessionManager,
  ISkillManager,
} from "../interfaces.js";
import type {
  SubagentPlan,
  PlannedSubtask,
  SubtaskResult,
  ToolResultSummary,
} from "../types.js";
import { emptyCommandPlan } from "../types.js";
import type { PerConnection } from "../../container/types.js";
import type { MaxSubagentsParam } from "../maxSubagents.js";
import type { TaskModelOverrides } from "../types.js";
import type { Agent } from "../agent/agent.js";
import type { Subagent } from "../subagent/subagent.js";
import type { TaskFrame } from "../../transport/frames.js";
import { TaskSkippedError, PlanRevisionRequestedError } from "../agent/agentErrors.js";
import {
  buildPlanRevisionTask,
  contextHasWorkspaceStructure,
  summarizeWorkspaceStackHint,
} from "../agent/agentHelpers.js";
import { exploreCodebase } from "../exploreCodebase.js";
import { deriveSubagentPlans } from "../planHelpers.js";
import { createThinkFrameEmitter } from "../thinkStream.js";
import { AbortError, OrchestrationError } from "../../errors/index.js";
import {
  available,
  buildSubagentBoardSnapshots,
  complete,
  createReadyQueue,
  take,
  WorkSignal,
  workerCountFor,
} from "../readyQueue.js";
import type {
  OrchestratorPipelineDeps,
  PlanningContextResult,
  PlanningResult,
} from "./orchestratorPipelineTypes.js";

/**
 * Creates an empty agent plan placeholder.
 *
 * @remarks
 * Used as a default or fallback plan when no planning has occurred yet,
 * or when a task is skipped. Returns a plan with empty subtasks, risks,
 * and command plan, with execution set to sequential and agent count to 0.
 *
 * @returns Empty SubagentPlan object with no subtasks
 */
const emptyPlan = (): SubagentPlan => ({
  subtasks: [],
  risks: [],
  commandPlan: emptyCommandPlan(),
  execution: "sequential",
  agentCount: 0,
});

/**
 * Builds the agent's planning context: memory context header (with an
 * appended workspace snapshot when the agent model can't call tools and
 * the context lacks structure already), a stack hint, and the selected
 * skill body.
 *
 * @remarks
 * Extracted from the "context" phase of {@link runOrchestratorPipeline} —
 * the caller is still responsible for setting `phase = "context"` before
 * calling this so error reporting is unaffected.
 */
export const preparePlanningContext = async (
  deps: Pick<
    OrchestratorPipelineDeps,
    "contextBuilder" | "skillManager" | "sessionManager" | "config"
  >,
  params: {
    taskText: string;
    agentModel: string;
    modelOverrides: TaskModelOverrides | undefined;
    perConn: PerConnection;
    emit: (frame: TaskFrame) => void;
    signal: AbortSignal;
  },
): Promise<PlanningContextResult> => {
  const { contextBuilder, skillManager, sessionManager, config } = deps;
  const { taskText, agentModel, modelOverrides, perConn, emit, signal } = params;

  // The provider decides how the budget's context window is sized — `num_ctx`
  // is Ollama-only, so a non-Ollama role must not be budgeted against it.
  const agentProvider =
    modelOverrides?.agentProvider ?? (await config.getAgentProvider());
  let contextHeader = await contextBuilder.build(
    taskText,
    agentModel,
    agentProvider,
  );
  // Order matches the original inline code: context build happens before
  // this config read, not the other way around.
  const agentSupportsTools =
    modelOverrides?.agentModelSupportsTools ??
    (await config.getAgentModelSupportsTools());

  // Append workspace snapshot if agent doesn't support tools and context lacks structure
  const appendWorkspaceSnapshot = async (): Promise<string> => {
    const explored = await exploreCodebase(perConn.workspace, emit, signal);
    await sessionManager.saveSnapshot(explored.snapshot);
    const structureBlock = `[Workspace structure]\n${explored.snapshot.trim()}`;
    return contextHeader.trim().length > 0
      ? `${contextHeader.trim()}\n\n${structureBlock}\n`
      : `${structureBlock}\n`;
  };

  if (!contextHasWorkspaceStructure(contextHeader) && !agentSupportsTools) {
    contextHeader = await appendWorkspaceSnapshot();
  }

  const stackHint = summarizeWorkspaceStackHint(contextHeader);
  if (stackHint) {
    contextHeader = `${contextHeader.trim()}\n\n[Stack hint]\n${stackHint}\n`;
  }

  // Reuses ContextBuilder's own language-hint detection rather than a
  // second parsing path — see IContextBuilder.detectStack. Without this,
  // detectedStack was never populated by any production caller, so
  // stack-specific skill selection (SkillMeta.stacks/priority) was dead code.
  const detectedStack = await contextBuilder.detectStack(taskText);
  const selected = await skillManager.selectForTask(
    taskText,
    detectedStack ? { detectedStack } : undefined,
  );
  const skillBody = selected
    .map((s, i) => {
      const label = i === 0 ? "Stack skill" : "Domain skill";
      return `[${label}: ${s.name}.md]\n${s.content.trim()}`;
    })
    .join("\n\n");

  return { contextHeader, skillBody };
};

/**
 * Runs agent planning, re-planning with folded-in feedback whenever the
 * user picks "Revise" at plan review, up to a defensive round cap.
 *
 * @remarks
 * A `TaskSkippedError` from `agent.plan` surfaces as `{ skipped: true }`
 * rather than being thrown — the caller decides how to finish the pipeline
 * for a skipped task (emit token, build the empty-plan outcome, return).
 * Any other error propagates.
 */
export const runPlanningWithRevisions = async (
  agent: Agent,
  params: {
    taskText: string;
    contextHeader: string;
    skillBody: string;
    modelOverrides: TaskModelOverrides | undefined;
    maxSubagents: MaxSubagentsParam;
    modeLabel: string | null;
    perConn: PerConnection;
    sessionManager: ISessionManager;
    emit: (frame: TaskFrame) => void;
    signal: AbortSignal;
  },
): Promise<PlanningResult> => {
  const {
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
  } = params;

  let planningTaskText = taskText;
  // Bounds revision rounds defensively; each round still requires the user
  // to type feedback, so this guards against pathological loops, not cost.
  const MAX_PLAN_REVISION_ROUNDS = 10;
  // One emitter reused across revision rounds — `finish()` resets its
  // internal id/streamed state after every iteration, so each planning
  // iteration (including across a revision round) gets its own think stream.
  const agentThinkFrames = createThinkFrameEmitter({
    emit,
    agent: true,
  });
  for (let revisionRound = 0; ; revisionRound += 1) {
    try {
      const plan = await agent.plan(
        planningTaskText,
        contextHeader,
        skillBody,
        modelOverrides,
        {
          onThinkDelta: (text: string) => agentThinkFrames.delta(text),
          onThinkEnd: (finalText: string | null) =>
            agentThinkFrames.finish(finalText),
          reviewPlan: (agentPlan: SubagentPlan) =>
            perConn.planBroker.request({
              task: taskText,
              steps: agentPlan.subtasks.map((s: PlannedSubtask) => s.text),
              risks: agentPlan.risks,
              agents: deriveSubagentPlans(agentPlan.subtasks),
              agentCount: agentPlan.agentCount,
              execution: agentPlan.execution,
              modeLabel,
            }),
          searchTools: perConn.tokenSaveTools,
          callSearchTool: (name, args) =>
            perConn.workspace.callMcpTool(name, args),
          exploreCodebase: async () => {
            const explored = await exploreCodebase(
              perConn.workspace,
              emit,
              signal,
            );
            await sessionManager.saveSnapshot(explored.snapshot);
            return explored;
          },
        },
        maxSubagents,
        signal,
      );
      return { skipped: false, plan };
    } catch (err) {
      // TaskSkippedError is a valid outcome - let the caller build the
      // success-with-empty-plan outcome and return from the pipeline.
      if (err instanceof TaskSkippedError) {
        return { skipped: true };
      }
      // User gave feedback at plan review — re-run planning with that
      // feedback folded into the task text, instead of hand-editing the plan.
      if (err instanceof PlanRevisionRequestedError) {
        if (revisionRound >= MAX_PLAN_REVISION_ROUNDS) {
          throw err;
        }
        planningTaskText = buildPlanRevisionTask(taskText, err.feedback);
        continue;
      }
      throw err;
    } finally {
      // Safety net for the paths that never reach `plan()`'s own
      // `onThinkEnd` — an abort mid-stream, an OrchestrationError from an
      // auxiliary tool call, a provider error. Without it the emitter keeps
      // this round's `id`/`streamed` state, and the next round's deltas
      // stream under a stale id the client has already torn down, so the
      // retried round's reasoning never renders. `finish()` is idempotent
      // after a streamed close, so this is a no-op on the success path.
      // `Subagent.runIteration` wraps its own emitter the same way.
      agentThinkFrames.finish(null);
    }
  }
};

/**
 * Formats a progress message for the subagent pool.
 *
 * @remarks
 * Combines completed, total, running, and group counts into a readable
 * string with bullet separators for clarity. Used to emit status updates
 * to the client during subagent pool execution.
 *
 * @param completedCount - Number of completed subtasks
 * @param totalCount - Total number of subtasks
 * @param runningCount - Number of currently running subtasks
 * @param groupCount - Number of agent groups
 *
 * @returns Formatted progress string (e.g., "3/10 done · 2 running · 2 groups")
 */
export const formatPoolProgress = (
  completedCount: number,
  totalCount: number,
  runningCount: number,
  groupCount: number,
): string =>
  `${completedCount}/${totalCount} done · ${runningCount} running · ${groupCount} groups`;

/**
 * Formats a startup message for the subagent pool.
 *
 * @remarks
 * Pluralizes group, worker, and task labels based on counts for proper
 * grammar. Used to emit the initial status message when the subagent pool
 * begins execution.
 *
 * @param groupCount - Number of agent groups
 * @param workerCount - Number of worker subagents
 * @param taskCount - Total number of tasks
 *
 * @returns Formatted startup string (e.g., "2 groups · 3 workers · 10 tasks")
 */
export const formatPoolStart = (
  groupCount: number,
  workerCount: number,
  taskCount: number,
): string =>
  `${groupCount} group${groupCount === 1 ? "" : "s"} · ${workerCount} worker${workerCount === 1 ? "" : "s"} · ${taskCount} task${taskCount === 1 ? "" : "s"}`;

/**
 * Formats a tool result summary into a readable block.
 *
 * @remarks
 * Converts a ToolResultSummary into a formatted string with the summary,
 * key findings (if any), and files touched (if any). This is used to
 * present prior subtask results to agents in a human-readable format.
 *
 * @param result - Tool result summary to format
 *
 * @returns Formatted string with summary, findings, and files
 */
const formatToolResultBlock = (result: ToolResultSummary): string => {
  const lines = [`- ${result.summary}`];
  if (result.keyFindings.length > 0) {
    lines.push(...result.keyFindings.map((finding) => `  ${finding}`));
  }
  if (result.filesTouched.length > 0) {
    lines.push(`  Files: ${result.filesTouched.join(", ")}`);
  }
  return lines.join("\n");
};

/**
 * Builds context string from prior subtask results.
 *
 * @remarks
 * Creates a formatted context string containing results from prior subtasks
 * that the current subtask depends on. Results are sorted by dependency ID
 * for consistent ordering. Each result is formatted as a markdown heading
 * with the tool result block below it.
 *
 * @param resultsMap - Map of subtask ID to result summary
 * @param dependencyIds - Array of dependency subtask IDs to include
 *
 * @returns Formatted context string with prior results, or empty string if no dependencies
 */
export const buildSessionContext = (
  resultsMap: Map<number, ToolResultSummary>,
  dependencyIds: number[],
): string => {
  if (dependencyIds.length === 0) {
    return "";
  }

  // Sort dependency IDs for consistent ordering
  const sortedDependencyIds = [...dependencyIds].sort(
    (dependencyIdA, dependencyIdB) => dependencyIdA - dependencyIdB,
  );

  // Map each ID to its structured result with a heading
  const contextBlocks = sortedDependencyIds.map((dependencyId) => {
    const result = resultsMap.get(dependencyId);
    if (!result) {
      return `### Prior subtask ${dependencyId}\n`;
    }
    return `### Prior subtask ${dependencyId}\n${formatToolResultBlock(result)}`;
  });

  return `\n\n${contextBlocks.join("\n\n")}`;
};

/**
 * Converts a plan and result map to an ordered array of subtask results.
 *
 * @remarks
 * Sorts subtasks by ID for consistent ordering, then maps each subtask
 * to its corresponding result from the result map. Results are formatted
 * using formatToolResultBlock. Used to prepare results for combination
 * or single result emission.
 *
 * @param plan - The agent plan with subtask definitions
 * @param resultMap - Map of subtask ID to result summary
 *
 * @returns Array of SubtaskResult objects ordered by subtask ID
 */
export const toOrderedResults = (
  plan: SubagentPlan,
  resultMap: Map<number, ToolResultSummary>,
): SubtaskResult[] => {
  const sortedSubtasks = [...plan.subtasks].sort(
    (subtaskA, subtaskB) => subtaskA.id - subtaskB.id,
  );

  return sortedSubtasks.map((subtask) => {
    const result = resultMap.get(subtask.id);
    return {
      id: subtask.id,
      content: result ? formatToolResultBlock(result) : "",
    };
  });
};

/**
 * Runs the worker pool that executes a plan's subtasks in dependency order.
 *
 * @remarks
 * Extracted from the "agent.pool" phase of {@link runOrchestratorPipeline}.
 * `resultMap` is mutated in place as subtasks complete (each `subagent.run`
 * result is set on it) so the caller's copy — used to build a partial
 * `outcome` on later failure — stays current even though this function
 * doesn't return the map itself.
 *
 * @throws {@link AbortError} When `signal` is aborted mid-run.
 * @throws {@link OrchestrationError} When a subtask fails, or a deadlock is
 *   detected (pending subtasks remain after every worker exits).
 */
export const runAgentPool = async (
  subagent: Subagent,
  params: {
    taskId: string;
    plan: SubagentPlan;
    skillBody: string;
    maxSubagents: MaxSubagentsParam;
    experienceRecorder: IExperienceRecorder;
    perConn: PerConnection;
    modelOverrides: TaskModelOverrides | undefined;
    resultMap: Map<number, ToolResultSummary>;
    emit: (frame: TaskFrame) => void;
    emitStatus: (frame: Extract<TaskFrame, { kind: "status" }>) => void;
    signal: AbortSignal;
  },
): Promise<SubtaskResult[]> => {
  const {
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
  } = params;

  const totalTasks = plan.subtasks.length;
  const workerCount = workerCountFor(maxSubagents, plan);
  const queue = createReadyQueue(plan.subtasks);
  const workSignal = new WorkSignal();

  // Helper to emit pool status with optional agent board snapshots
  const emitAgentPoolStatus = (
    message: string,
    icon: "◌" | "✓" = "◌",
    includeBoards = true,
  ): void => {
    emitStatus({
      kind: "status",
      source: "agent",
      stage: "ready",
      icon,
      message,
      ...(includeBoards
        ? {
            subagentBoards: buildSubagentBoardSnapshots(plan.subtasks, queue),
          }
        : {}),
    });
  };

  emitAgentPoolStatus(
    formatPoolStart(plan.agentCount, workerCount, totalTasks),
  );

  // Worker function that processes subtasks from the ready queue
  const runWorker = async (): Promise<void> => {
    while (true) {
      if (signal.aborted) {
        throw new AbortError("Worker aborted");
      }

      const ready = available(queue);
      if (ready.length === 0) {
        // No ready tasks - exit if nothing running, otherwise wait for signal
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
      // Try to claim the subtask - may fail if another worker claimed it first
      if (!take(queue, subtask.id)) {
        workSignal.broadcast();
        continue;
      }
      workSignal.broadcast();
      emitAgentPoolStatus(
        formatPoolProgress(
          queue.completed.size,
          totalTasks,
          queue.running.size,
          plan.agentCount,
        ),
      );

      const subtaskResult = await subagent.run({
        taskId,
        subtask: subtask.text,
        agentId: subtask.agentId,
        agentLabel: subtask.agentLabel,
        skillContent: skillBody,
        sessionContext: buildSessionContext(queue.completed, subtask.dependsOn),
        commandPlan: plan.commandPlan,
        workspace: perConn.workspace,
        terminal: perConn.terminal,
        recorder: experienceRecorder,
        emit,
        signal,
        modelOverrides,
        debug: modelOverrides?.debug === true,
      });

      const newlyReady = complete(queue, subtask.id, subtaskResult);
      resultMap.set(subtask.id, subtaskResult);

      if (!subtaskResult.ok) {
        throw new OrchestrationError(
          `Subtask ${subtask.id} failed: ${subtaskResult.summary}`,
        );
      }

      const completedCount = queue.completed.size;
      const runningTasks = queue.running.size;
      emitAgentPoolStatus(
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
        emitAgentPoolStatus(unlockMsg);
      }

      workSignal.broadcast();
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  // Check for deadlock - pending tasks should be zero after all workers finish
  if (queue.pending.size > 0) {
    throw new OrchestrationError(
      "Deadlock: cyclic or invalid dependencies in agent plan",
    );
  }

  emitAgentPoolStatus(
    `${totalTasks}/${totalTasks} done · ${plan.agentCount} group${plan.agentCount === 1 ? "" : "s"}`,
    "✓",
    false,
  );

  return toOrderedResults(plan, resultMap);
};

/**
 * Emits the task's final output: the lone subtask's content directly for a
 * single-subtask plan, or a streamed agent-combined synthesis for a
 * multi-subtask plan.
 *
 * @remarks
 * Extracted from the "emit.single" / "agent.combine" phases of
 * {@link runOrchestratorPipeline} — the caller sets `phase` to the matching
 * value (based on the same `plan.subtasks.length === 1` check) before
 * calling this, so error reporting is unaffected.
 *
 * @throws {@link AbortError} When `signal` is aborted while streaming the combine.
 */
export const emitFinalResult = async (
  agent: Agent,
  params: {
    taskText: string;
    plan: SubagentPlan;
    ordered: SubtaskResult[];
    modelOverrides: TaskModelOverrides | undefined;
    emitToken: (text: string) => void;
    emitStatus: (frame: Extract<TaskFrame, { kind: "status" }>) => void;
    signal: AbortSignal;
  },
): Promise<void> => {
  const { taskText, plan, ordered, modelOverrides, emitToken, emitStatus, signal } =
    params;

  if (plan.subtasks.length === 1) {
    emitToken(ordered[0]?.content ?? "");
    return;
  }

  emitStatus({
    kind: "status",
    source: "agent",
    stage: "combining",
    icon: "◌",
    message: `Combining results from ${plan.agentCount} groups...`,
  });
  for await (const token of agent.combine(taskText, ordered, modelOverrides)) {
    if (signal.aborted) {
      throw new AbortError("Combine aborted");
    }
    emitToken(token);
  }
};

/** Re-export emptyPlan for use in other modules. */
export { emptyPlan };
