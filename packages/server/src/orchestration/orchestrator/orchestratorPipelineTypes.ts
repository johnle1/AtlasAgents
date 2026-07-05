/**
 * <Summary>
 * What it does:
 *   Types and helper functions for orchestrator pipeline.
 *
 * How it fits in the system:
 *   Provides type definitions and utility functions for orchestrator pipeline operations.
 *   These types define the dependencies and parameters needed to run the full
 *   advisor-agent orchestration pipeline, including context building, skill selection,
 *   session management, and experience recording.
 * </Summary>
 */

import type {
  IContextBuilder,
  IExperienceRecorder,
  IConfigManager,
  IOllamaClient,
  ISessionManager,
  ISkillManager,
} from "../interfaces.js";
import type { AdvisorPlan, SubtaskResult } from "../types.js";
import { emptyCommandPlan } from "../types.js";
import type { PerConnection } from "../../container/types.js";
import type { MaxAgentsParam } from "../maxAgents.js";
import type { SessionInfo, TaskModelOverrides } from "../types.js";
import type { Advisor } from "../advisor/advisor.js";
import type { TaskFrame } from "../../transport/frames.js";

/**
 * <Summary>
 * What it does:
 *   Dependency injection container for the orchestrator pipeline.
 *
 * How it fits in the system:
 *   Collects all the services needed to run the orchestration pipeline.
 *   These dependencies are provided by the application container and passed
 *   to the orchestrator pipeline for task execution.
 *
 * Fields:
 *   contextBuilder — Builds context from memory and workspace state.
 *   skillManager — Manages skill selection and retrieval.
 *   sessionManager — Manages session state and history.
 *   experienceRecorder — Records task outcomes for learning.
 *   advisor — Plans and combines agent results.
 *   ollama — LLM client for model interactions.
 *   config — Configuration manager for settings.
 * </Summary>
 */
export type OrchestratorPipelineDeps = {
  /** Builds context from memory and workspace state. */
  contextBuilder: IContextBuilder;

  /** Manages skill selection and retrieval. */
  skillManager: ISkillManager;

  /** Manages session state and history. */
  sessionManager: ISessionManager;

  /** Records task outcomes for learning. */
  experienceRecorder: IExperienceRecorder;

  /** Plans and combines agent results. */
  advisor: Advisor;

  /** LLM client for model interactions. */
  ollama: IOllamaClient;

  /** Configuration manager for settings. */
  config: IConfigManager;
};

/**
 * <Summary>
 * What it does:
 *   Parameters for a single orchestrator pipeline execution.
 *
 * How it fits in the system:
 *   Contains all the runtime parameters needed to execute a single task
 *   through the orchestrator pipeline, including session info, task text,
 *   emission callback, cancellation signal, and optional overrides.
 *
 * Fields:
 *   session — Authenticated connection identity for auditing.
 *   taskText — User task description to execute.
 *   emit — Callback to emit task frames to the client.
 *   signal — AbortSignal for cancellation support.
 *   perConn — Optional per-connection resources.
 *   modelOverrides — Optional model selection overrides.
 *   maxAgents — Optional agent count constraint.
 * </Summary>
 */
export type OrchestratorPipelineParams = {
  /** Authenticated connection identity for auditing. */
  session: SessionInfo;

  /** User task description to execute. */
  taskText: string;

  /** Callback to emit task frames to the client. */
  emit: (frame: TaskFrame) => void;

  /** AbortSignal for cancellation support. */
  signal: AbortSignal;

  /** Optional per-connection resources. */
  perConn?: PerConnection;

  /** Optional model selection overrides. */
  modelOverrides?: TaskModelOverrides;

  /** Optional agent count constraint. */
  maxAgents?: MaxAgentsParam;
};

/**
 * <Summary>
 * What it does:
 *   Creates an empty advisor plan placeholder.
 *
 * How it does it (step by step):
 *   1. Return a plan with empty subtasks, risks, and command plan.
 *   2. Set execution to sequential and agent count to 0.
 *
 * Returns:
 *   Empty AdvisorPlan object with no subtasks.
 * </Summary>
 */
const emptyPlan = (): AdvisorPlan => ({
  subtasks: [],
  risks: [],
  commandPlan: emptyCommandPlan(),
  execution: "sequential",
  agentCount: 0,
});

/**
 * <Summary>
 * What it does:
 *   Formats a progress message for the agent pool.
 *
 * How it does it (step by step):
 *   1. Combine completed, total, running, and groups into a readable string.
 *   2. Use bullet separators for clarity.
 *
 * Parameters:
 *   @param completed — Number of completed subtasks.
 *   @param total — Total number of subtasks.
 *   @param running — Number of currently running subtasks.
 *   @param groups — Number of agent groups.
 *
 * Returns:
 *   Formatted progress string (e.g., "3/10 done · 2 running · 2 groups").
 * </Summary>
 */
export const formatPoolProgress = (
  completedCount: number,
  totalCount: number,
  runningCount: number,
  groupCount: number,
): string =>
  `${completedCount}/${totalCount} done · ${runningCount} running · ${groupCount} groups`;

/**
 * <Summary>
 * What it does:
 *   Formats a startup message for the agent pool.
 *
 * How it does it (step by step):
 *   1. Pluralize group, worker, and task labels based on counts.
 *   2. Combine into a readable startup message.
 *
 * Parameters:
 *   @param groups — Number of agent groups.
 *   @param workers — Number of worker agents.
 *   @param total — Total number of tasks.
 *
 * Returns:
 *   Formatted startup string (e.g., "2 groups · 3 workers · 10 tasks").
 * </Summary>
 */
export const formatPoolStart = (
  groupCount: number,
  workerCount: number,
  taskCount: number,
): string =>
  `${groupCount} group${groupCount === 1 ? "" : "s"} · ${workerCount} worker${workerCount === 1 ? "" : "s"} · ${taskCount} task${taskCount === 1 ? "" : "s"}`;

/**
 * <Summary>
 * What it does:
 *   Builds context string from prior subtask results.
 *
 * How it does it (step by step):
 *   1. Return empty string if no dependencies.
 *   2. Sort dependency IDs for consistent ordering.
 *   3. Map each ID to its result with a heading.
 *   4. Join blocks with double newlines.
 *
 * Parameters:
 *   @param results — Map of subtask ID to result string.
 *   @param dependsOn — Array of dependency subtask IDs.
 *
 * Returns:
 *   Formatted context string with prior results or empty string.
 * </Summary>
 */
export const buildSessionContext = (
  resultsMap: Map<number, string>,
  dependencyIds: number[],
): string => {
  // Step 1: Return empty string if no dependencies
  if (dependencyIds.length === 0) {
    return "";
  }
  // Step 2: Sort dependency IDs for consistent ordering
  const sortedDependencyIds = [...dependencyIds].sort(
    (dependencyIdA, dependencyIdB) => dependencyIdA - dependencyIdB,
  );
  // Step 3: Map each ID to its result with a heading
  const contextBlocks = sortedDependencyIds.map((dependencyId) => {
    const resultBody = resultsMap.get(dependencyId) ?? "";
    return `### Prior subtask ${dependencyId}\n${resultBody}`;
  });
  // Step 4: Join blocks with double newlines
  return `\n\n${contextBlocks.join("\n\n")}`;
};

/**
 * <Summary>
 * What it does:
 *   Converts a plan and result map to an ordered array of subtask results.
 *
 * How it does it (step by step):
 *   1. Sort subtasks by ID for consistent ordering.
 *   2. Map each subtask to its result from the map.
 *   3. Return array of SubtaskResult objects.
 *
 * Parameters:
 *   @param plan — The advisor plan with subtask definitions.
 *   @param resultMap — Map of subtask ID to result string.
 *
 * Returns:
 *   Array of SubtaskResult objects ordered by subtask ID.
 * </Summary>
 */
export const toOrderedResults = (
  plan: AdvisorPlan,
  resultMap: Map<number, string>,
): SubtaskResult[] => {
  // Step 1: Sort subtasks by ID for consistent ordering
  const sortedSubtasks = [...plan.subtasks].sort(
    (subtaskA, subtaskB) => subtaskA.id - subtaskB.id,
  );
  // Step 2-3: Map each subtask to its result and return array
  return sortedSubtasks.map((subtask) => ({
    id: subtask.id,
    content: resultMap.get(subtask.id) ?? "",
  }));
};

/** Re-export emptyPlan for use in other modules. */
export { emptyPlan };
