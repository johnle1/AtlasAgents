import type { SubagentPlan as SharedSubagentPlan, PlanExecution } from "@loopycode/shared";
import type { MaxSubagentsParam } from "./maxSubagents.js";
import type { SubagentPlan, PlannedSubtask } from "./types.js";

/**
 * Converts a max_agents constraint into a human-readable mode label.
 *
 * @remarks
 * Maps maxSubagents values to descriptive labels for display in status messages.
 * Returns null for unrecognized values.
 *
 * @param maxSubagents - The max_agents constraint from configuration
 *
 * @returns Human-readable mode label or null if unrecognized
 */
export const modeLabelFromMaxAgents = (
  maxSubagents: MaxSubagentsParam,
): string | null => {
  if (maxSubagents === 1) {
    return "focus mode";
  }
  if (maxSubagents === 2) {
    return "collab mode";
  }
  if (maxSubagents === "max") {
    return "max mode — no agent cap";
  }
  if (typeof maxSubagents === "number") {
    return `up to ${maxSubagents} agents`;
  }
  return null;
};

/**
 * Determines the execution mode (parallel, sequential, or mixed) from subtask dependencies.
 *
 * @remarks
 * Analyzes subtask dependencies to determine if tasks can run in parallel,
 * must run sequentially, or have a mixed execution pattern. Used to display
 * the execution strategy to users.
 *
 * @param subtasks - List of planned subtasks with dependency information
 *
 * @returns Execution mode: "parallel", "sequential", or "mixed"
 */
export const deriveExecution = (subtasks: PlannedSubtask[]): PlanExecution => {
  const hasParallel = subtasks.some(
    (subtask) => subtask.dependsOn.length === 0,
  );
  const hasSequential = subtasks.some(
    (subtask) => subtask.dependsOn.length > 0,
  );
  if (hasParallel && hasSequential) {
    return "mixed";
  }
  if (hasParallel) {
    return "parallel";
  }
  return "sequential";
};

/**
 * Validates that the subtask dependency graph has no cycles.
 *
 * @remarks
 * Uses depth-first search (DFS) with visited and visiting sets to detect cycles.
 * A cycle occurs when a subtask depends on another subtask that transitively
 * depends back on it. Cycles would cause deadlock during execution.
 *
 * @param subtasks - List of planned subtasks with dependency information
 *
 * @returns True if no cycles exist, false if a cycle is detected
 */
export const validateNoCycles = (subtasks: PlannedSubtask[]): boolean => {
  const visitedSubtaskIds = new Set<number>();
  const visitingSubtaskIds = new Set<number>();
  const subtaskById = new Map(subtasks.map((subtask) => [subtask.id, subtask]));

  const depthFirstSearch = (subtaskId: number): boolean => {
    if (visitingSubtaskIds.has(subtaskId)) {
      return false;
    }
    if (visitedSubtaskIds.has(subtaskId)) {
      return true;
    }
    visitingSubtaskIds.add(subtaskId);
    const subtask = subtaskById.get(subtaskId);
    if (!subtask) {
      visitingSubtaskIds.delete(subtaskId);
      visitedSubtaskIds.add(subtaskId);
      return true;
    }
    for (const dependencyId of subtask.dependsOn) {
      if (!depthFirstSearch(dependencyId)) {
        return false;
      }
    }
    visitingSubtaskIds.delete(subtaskId);
    visitedSubtaskIds.add(subtaskId);
    return true;
  };

  return subtasks.every((subtask) => depthFirstSearch(subtask.id));
};

/**
 * Converts subtasks into agent-level plans with inter-agent dependencies.
 *
 * @remarks
 * Groups subtasks by agent ID and creates SubagentPlan objects with steps.
 * Detects cross-agent dependencies when a subtask depends on a subtask
 * assigned to a different agent. Returns sorted array of agent plans by ID.
 *
 * @param subtasks - List of planned subtasks with agent assignments
 *
 * @returns Array of SubagentPlan objects with steps and inter-agent dependencies
 */
export const deriveSubagentPlans = (subtasks: PlannedSubtask[]): SharedSubagentPlan[] => {
  const agentMap = new Map<number, SharedSubagentPlan>();

  // Build index for O(1) dependency lookups instead of O(n) .find() per edge
  // This avoids O(n*e) scanning and reduces to O(n + e) total
  const subtaskById = new Map(subtasks.map((subtask) => [subtask.id, subtask]));

  for (const subtask of subtasks) {
    if (!agentMap.has(subtask.agentId)) {
      agentMap.set(subtask.agentId, {
        id: subtask.agentId,
        label: subtask.agentLabel,
        steps: [],
        dependsOn: [],
      });
    }
    agentMap.get(subtask.agentId)!.steps.push(subtask.text);
  }

  for (const subtask of subtasks) {
    if (subtask.dependsOn.length === 0) {
      continue;
    }
    const agent = agentMap.get(subtask.agentId);
    if (!agent) {
      continue;
    }
    for (const dependencyId of subtask.dependsOn) {
      const dependencySubtask = subtaskById.get(dependencyId);
      if (dependencySubtask && dependencySubtask.agentId !== subtask.agentId) {
        if (!agent.dependsOn.includes(dependencySubtask.agentId)) {
          agent.dependsOn.push(dependencySubtask.agentId);
        }
      }
    }
  }

  return [...agentMap.values()].sort(
    (agentPlanA, agentPlanB) => agentPlanA.id - agentPlanB.id,
  );
};

/**
 * Collapses all subtasks to be executed by a single agent sequentially.
 *
 * @remarks
 * Sorts subtasks by ID and assigns all to agent 1 with label "all tasks".
 * Creates sequential dependencies where each subtask depends on the previous one.
 * Used when maxSubagents is 1 (focus mode).
 *
 * @param subtasks - List of planned subtasks to collapse
 *
 * @returns New array of subtasks all assigned to agent 1 with sequential dependencies
 */
const collapseToSingleAgent = (
  subtasks: PlannedSubtask[],
): PlannedSubtask[] => {
  const sortedSubtasks = [...subtasks].sort(
    (subtaskA, subtaskB) => subtaskA.id - subtaskB.id,
  );
  return sortedSubtasks.map((subtask, index) => ({
    ...subtask,
    agentId: 1,
    agentLabel: "all tasks",
    dependsOn:
      index === 0
        ? []
        : [sortedSubtasks[index - 1]?.id ?? sortedSubtasks[0]!.id],
  }));
};

/**
 * Collapses subtasks to use at most N agents, merging excess agents into the last one.
 *
 * @remarks
 * If unique agents <= N, simply renumbers them 1..N. Otherwise, keeps first N-1
 * agents and merges the rest into agent N. Used when maxSubagents is a custom numeric cap.
 *
 * @param subtasks - List of planned subtasks to collapse
 * @param maxAgentCount - Maximum number of agents to use
 *
 * @returns New array of subtasks with at most N unique agent IDs
 */
const collapseToNAgents = (
  subtasks: PlannedSubtask[],
  maxAgentCount: number,
): PlannedSubtask[] => {
  const uniqueAgentIds = [
    ...new Set(subtasks.map((subtask) => subtask.agentId)),
  ].sort((agentIdA, agentIdB) => agentIdA - agentIdB);

  // Cache agent labels once (O(n)) instead of calling .find() per subtask in the map loop
  // This avoids O(n^2) scanning during remapping and reduces to O(n log n)
  const labelByAgentId = new Map<number, string>();
  for (const subtask of subtasks) {
    if (!labelByAgentId.has(subtask.agentId)) {
      labelByAgentId.set(subtask.agentId, subtask.agentLabel);
    }
  }
  const getLabelForAgentId = (agentId: number): string =>
    labelByAgentId.get(agentId) ?? "tasks";

  if (uniqueAgentIds.length <= maxAgentCount) {
    const indexByAgentId = new Map(
      uniqueAgentIds.map((agentId, index) => [agentId, index]),
    );
    return subtasks.map((subtask) => ({
      ...subtask,
      agentId: (indexByAgentId.get(subtask.agentId) ?? -1) + 1,
      agentLabel: getLabelForAgentId(subtask.agentId),
    }));
  }

  const keptAgentIds = uniqueAgentIds.slice(0, maxAgentCount - 1);
  const keptAgentIndexById = new Map(
    keptAgentIds.map((agentId, index) => [agentId, index]),
  );
  const mergedAgentLabel = getLabelForAgentId(
    uniqueAgentIds[maxAgentCount - 1] ??
      uniqueAgentIds[uniqueAgentIds.length - 1] ??
      1,
  );
  return subtasks.map((subtask) => {
    const keptIndex = keptAgentIndexById.get(subtask.agentId);
    if (keptIndex !== undefined) {
      return {
        ...subtask,
        agentId: keptIndex + 1,
        agentLabel: getLabelForAgentId(subtask.agentId),
      };
    }
    return { ...subtask, agentId: maxAgentCount, agentLabel: mergedAgentLabel };
  });
};

/**
 * Collapses subtasks to use exactly 2 agents (setup and implementation).
 *
 * @remarks
 * Maps the first agent to agent 1 (setup) and all other agents to agent 2 (implementation).
 * Used when maxSubagents is 2 (collab mode). Preserves the original label for the first agent.
 *
 * @param subtasks - List of planned subtasks to collapse
 *
 * @returns New array of subtasks with exactly 2 agent IDs (1 and 2)
 */
const collapseToTwoAgents = (subtasks: PlannedSubtask[]): PlannedSubtask[] => {
  const uniqueAgentIds = [
    ...new Set(subtasks.map((subtask) => subtask.agentId)),
  ].sort((agentIdA, agentIdB) => agentIdA - agentIdB);

  const firstAgentId = uniqueAgentIds[0] ?? 1;
  // Look up firstAgentLabel once (O(n)) before the loop, then reuse it
  // Avoids re-scanning subtasks inside the map callback (which would be O(n^2))
  const firstAgentLabel =
    subtasks.find((subtask) => subtask.agentId === firstAgentId)?.agentLabel ??
    "setup";

  return subtasks.map((subtask) => ({
    ...subtask,
    agentId: subtask.agentId === firstAgentId ? 1 : 2,
    agentLabel:
      subtask.agentId === firstAgentId ? firstAgentLabel : "implementation",
  }));
};

/**
 * Applies the max_agents constraint to an agent plan, collapsing agents if needed.
 *
 * @remarks
 * Copies subtasks to avoid mutating the original plan. Validates no cycles exist;
 * if cycles are found, linearizes dependencies. Then applies the max_agents constraint:
 * - 1: collapse to single agent (sequential)
 * - 2: collapse to two agents (collab mode)
 * - "max": keep all agents as-is
 * - number >= 3: collapse to at most that many agents
 * Recalculates agent count and execution mode after applying constraints.
 *
 * @param plan - The agent plan to apply constraints to
 * @param maxSubagents - The max_agents constraint from configuration
 *
 * @returns New agent plan with agent count constraint applied
 */
/** Counts distinct agent IDs among subtasks — single-pass O(n) helper to avoid repeating `new Set(...).size` inline. */
const uniqueAgentCount = (subtasks: PlannedSubtask[]): number =>
  new Set(subtasks.map((subtask) => subtask.agentId)).size;

export const applyMaxAgentsConstraint = (
  plan: SubagentPlan,
  maxSubagents: MaxSubagentsParam,
): SubagentPlan => {
  let constrainedSubtasks = [...plan.subtasks];

  // Linearize dependencies if cycles are detected (prevents deadlock)
  if (!validateNoCycles(constrainedSubtasks)) {
    const sortedSubtasks = [...constrainedSubtasks].sort(
      (subtaskA, subtaskB) => subtaskA.id - subtaskB.id,
    );
    constrainedSubtasks = sortedSubtasks.map((subtask, index) => ({
      ...subtask,
      dependsOn: index === 0 ? [] : [sortedSubtasks[index - 1]!.id],
    }));
  }

  if (maxSubagents === 1) {
    constrainedSubtasks = collapseToSingleAgent(constrainedSubtasks);
    return {
      ...plan,
      subtasks: constrainedSubtasks,
      agentCount: 1,
      execution: "sequential",
    };
  }

  if (maxSubagents === 2) {
    constrainedSubtasks = collapseToTwoAgents(constrainedSubtasks);
    return {
      ...plan,
      subtasks: constrainedSubtasks,
      agentCount: 2,
      execution: deriveExecution(constrainedSubtasks),
    };
  }

  if (maxSubagents === "max") {
    return {
      ...plan,
      subtasks: constrainedSubtasks,
      agentCount: uniqueAgentCount(constrainedSubtasks),
      execution: deriveExecution(constrainedSubtasks),
    };
  }

  if (typeof maxSubagents === "number" && maxSubagents >= 3) {
    if (uniqueAgentCount(constrainedSubtasks) > maxSubagents) {
      constrainedSubtasks = collapseToNAgents(constrainedSubtasks, maxSubagents);
    }
    return {
      ...plan,
      subtasks: constrainedSubtasks,
      agentCount: uniqueAgentCount(constrainedSubtasks),
      execution: deriveExecution(constrainedSubtasks),
    };
  }

  return {
    ...plan,
    subtasks: constrainedSubtasks,
    agentCount: uniqueAgentCount(constrainedSubtasks),
    execution: deriveExecution(constrainedSubtasks),
  };
};
