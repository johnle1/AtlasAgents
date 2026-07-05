import type { AgentPlan, PlanExecution } from "@loopycode/shared";
import type { MaxAgentsParam } from "./maxAgents.js";
import type { AdvisorPlan, PlannedSubtask } from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Converts a max_agents constraint into a human-readable mode label.
 *
 * How it does it (step by step):
 *   1. Check if maxAgents is 1 (focus mode).
 *   2. Check if maxAgents is 2 (collab mode).
 *   3. Check if maxAgents is "max" (unlimited mode).
 *   4. Check if maxAgents is a specific number (custom cap).
 *   5. Return null for unrecognized values.
 *
 * Parameters:
 *   @param maxAgents - The max_agents constraint from configuration.
 *
 * Returns:
 *   Human-readable mode label or null if unrecognized.
 * </Summary>
 */
export const modeLabelFromMaxAgents = (
  maxAgents: MaxAgentsParam,
): string | null => {
  // Step 1: Check if maxAgents is 1 (focus mode)
  if (maxAgents === 1) {
    return "focus mode";
  }
  // Step 2: Check if maxAgents is 2 (collab mode)
  if (maxAgents === 2) {
    return "collab mode";
  }
  // Step 3: Check if maxAgents is "max" (unlimited mode)
  if (maxAgents === "max") {
    return "max mode — no agent cap";
  }
  // Step 4: Check if maxAgents is a specific number (custom cap)
  if (typeof maxAgents === "number") {
    return `up to ${maxAgents} agents`;
  }
  // Step 5: Return null for unrecognized values
  return null;
};

/**
 * <Summary>
 * What it does:
 *   Determines the execution mode (parallel, sequential, or mixed) from subtask dependencies.
 *
 * How it does it (step by step):
 *   1. Check if any subtask has no dependencies (parallel potential).
 *   2. Check if any subtask has dependencies (sequential potential).
 *   3. Return "mixed" if both parallel and sequential exist.
 *   4. Return "parallel" if only parallel exists.
 *   5. Return "sequential" if only sequential exists.
 *
 * Parameters:
 *   @param subtasks - List of planned subtasks with dependency information.
 *
 * Returns:
 *   Execution mode: "parallel", "sequential", or "mixed".
 * </Summary>
 */
export const deriveExecution = (subtasks: PlannedSubtask[]): PlanExecution => {
  // Step 1: Check if any subtask has no dependencies (parallel potential)
  const hasParallel = subtasks.some(
    (subtask) => subtask.dependsOn.length === 0,
  );
  // Step 2: Check if any subtask has dependencies (sequential potential)
  const hasSequential = subtasks.some(
    (subtask) => subtask.dependsOn.length > 0,
  );
  // Step 3: Return "mixed" if both parallel and sequential exist
  if (hasParallel && hasSequential) {
    return "mixed";
  }
  // Step 4: Return "parallel" if only parallel exists
  if (hasParallel) {
    return "parallel";
  }
  // Step 5: Return "sequential" if only sequential exists
  return "sequential";
};

/**
 * <Summary>
 * What it does:
 *   Validates that the subtask dependency graph has no cycles.
 *
 * How it does it (step by step):
 *   1. Initialize visited and visiting sets for DFS cycle detection.
 *   2. Build a map of subtasks by ID for quick lookup.
 *   3. Perform DFS from each subtask to detect cycles.
 *   4. Mark nodes as visiting during traversal, visited after completion.
 *   5. Return false if a cycle is detected (node revisited while visiting).
 *   6. Return true if all subtasks pass cycle check.
 *
 * Parameters:
 *   @param subtasks - List of planned subtasks with dependency information.
 *
 * Returns:
 *   True if no cycles exist, false if a cycle is detected.
 * </Summary>
 */
export const validateNoCycles = (subtasks: PlannedSubtask[]): boolean => {
  // Step 1: Initialize visited and visiting sets for DFS cycle detection
  const visitedSubtaskIds = new Set<number>();
  const visitingSubtaskIds = new Set<number>();
  // Step 2: Build a map of subtasks by ID for quick lookup
  const subtaskById = new Map(subtasks.map((subtask) => [subtask.id, subtask]));

  // Depth-first search to detect cycles in the dependency graph
  const depthFirstSearch = (subtaskId: number): boolean => {
    // If we're already visiting this node, we found a cycle
    if (visitingSubtaskIds.has(subtaskId)) {
      return false;
    }
    // If we've already visited this node, no cycle from this path
    if (visitedSubtaskIds.has(subtaskId)) {
      return true;
    }
    // Mark this node as currently being visited
    visitingSubtaskIds.add(subtaskId);
    // Get the subtask for this ID
    const subtask = subtaskById.get(subtaskId);
    // If subtask doesn't exist, treat as valid (no dependencies to check)
    if (!subtask) {
      visitingSubtaskIds.delete(subtaskId);
      visitedSubtaskIds.add(subtaskId);
      return true;
    }
    // Recursively check all dependencies for cycles
    for (const dependencyId of subtask.dependsOn) {
      if (!depthFirstSearch(dependencyId)) {
        return false;
      }
    }
    // Mark this node as fully visited (no cycle found)
    visitingSubtaskIds.delete(subtaskId);
    visitedSubtaskIds.add(subtaskId);
    return true;
  };

  // Step 6: Check all subtasks for cycles
  return subtasks.every((subtask) => depthFirstSearch(subtask.id));
};

/**
 * <Summary>
 * What it does:
 *   Converts subtasks into agent-level plans with inter-agent dependencies.
 *
 * How it does it (step by step):
 *   1. Initialize a map to collect subtasks by agent ID.
 *   2. For each subtask, create or update its agent's plan entry.
 *   3. Add subtask text to the agent's steps list.
 *   4. For each subtask with dependencies, check cross-agent dependencies.
 *   5. Add agent-to-agent dependencies when subtasks depend on other agents.
 *   6. Return sorted array of agent plans by ID.
 *
 * Parameters:
 *   @param subtasks - List of planned subtasks with agent assignments.
 *
 * Returns:
 *   Array of AgentPlan objects with steps and inter-agent dependencies.
 * </Summary>
 */
export const deriveAgentPlans = (subtasks: PlannedSubtask[]): AgentPlan[] => {
  // Step 1: Initialize a map to collect subtasks by agent ID
  const agentMap = new Map<number, AgentPlan>();

  // Step 2-3: For each subtask, create or update its agent's plan entry
  for (const subtask of subtasks) {
    // Create agent plan entry if it doesn't exist
    if (!agentMap.has(subtask.agentId)) {
      agentMap.set(subtask.agentId, {
        id: subtask.agentId,
        label: subtask.agentLabel,
        steps: [],
        dependsOn: [],
      });
    }
    // Add subtask text to the agent's steps list
    agentMap.get(subtask.agentId)!.steps.push(subtask.text);
  }

  // Step 4-5: For each subtask with dependencies, check cross-agent dependencies
  for (const subtask of subtasks) {
    // Skip subtasks with no dependencies
    if (subtask.dependsOn.length === 0) {
      continue;
    }
    // Get the agent for this subtask
    const agent = agentMap.get(subtask.agentId);
    if (!agent) {
      continue;
    }
    // Check each dependency for cross-agent relationships
    for (const dependencyId of subtask.dependsOn) {
      const dependencySubtask = subtasks.find(
        (subtask) => subtask.id === dependencyId,
      );
      // If dependency belongs to a different agent, add inter-agent dependency
      if (dependencySubtask && dependencySubtask.agentId !== subtask.agentId) {
        if (!agent.dependsOn.includes(dependencySubtask.agentId)) {
          agent.dependsOn.push(dependencySubtask.agentId);
        }
      }
    }
  }

  // Step 6: Return sorted array of agent plans by ID
  return [...agentMap.values()].sort(
    (agentPlanA, agentPlanB) => agentPlanA.id - agentPlanB.id,
  );
};

/**
 * <Summary>
 * What it does:
 *   Collapses all subtasks to be executed by a single agent sequentially.
 *
 * How it does it (step by step):
 *   1. Sort subtasks by ID to maintain order.
 *   2. Map each subtask to agent ID 1 with label "all tasks".
 *   3. Set first subtask to have no dependencies.
 *   4. Set each subsequent subtask to depend on the previous one.
 *
 * Parameters:
 *   @param subtasks - List of planned subtasks to collapse.
 *
 * Returns:
 *   New array of subtasks all assigned to agent 1 with sequential dependencies.
 * </Summary>
 */
const collapseToSingleAgent = (
  subtasks: PlannedSubtask[],
): PlannedSubtask[] => {
  // Step 1: Sort subtasks by ID to maintain order
  const sortedSubtasks = [...subtasks].sort(
    (subtaskA, subtaskB) => subtaskA.id - subtaskB.id,
  );
  // Step 2-4: Map each subtask to agent 1 with sequential dependencies
  return sortedSubtasks.map((subtask, index) => ({
    ...subtask,
    agentId: 1,
    agentLabel: "all tasks",
    // First subtask has no dependencies, others depend on previous
    dependsOn:
      index === 0
        ? []
        : [sortedSubtasks[index - 1]?.id ?? sortedSubtasks[0]!.id],
  }));
};

/**
 * <Summary>
 * What it does:
 *   Collapses subtasks to use at most N agents, merging excess agents into the last one.
 *
 * How it does it (step by step):
 *   1. Get sorted list of unique agent IDs from subtasks.
 *   2. Create helper function to get label for an agent ID.
 *   3. If unique agents <= N, just renumber them 1..N.
 *   4. Otherwise, keep first N-1 agents and merge the rest into agent N.
 *   5. Renumber kept agents to 1..N-1.
 *   6. Assign merged label to all overflow agents.
 *
 * Parameters:
 *   @param subtasks - List of planned subtasks to collapse.
 *   @param n - Maximum number of agents to use.
 *
 * Returns:
 *   New array of subtasks with at most N unique agent IDs.
 * </Summary>
 */
const collapseToNAgents = (
  subtasks: PlannedSubtask[],
  maxAgentCount: number,
): PlannedSubtask[] => {
  // Step 1: Get sorted list of unique agent IDs from subtasks
  const uniqueAgentIds = [
    ...new Set(subtasks.map((subtask) => subtask.agentId)),
  ].sort((agentIdA, agentIdB) => agentIdA - agentIdB);
  // Step 2: Create helper function to get label for an agent ID
  const getLabelForAgentId = (agentId: number): string =>
    subtasks.find((subtask) => subtask.agentId === agentId)?.agentLabel ??
    "tasks";

  // Step 3: If unique agents <= N, just renumber them 1..N
  if (uniqueAgentIds.length <= maxAgentCount) {
    return subtasks.map((subtask) => ({
      ...subtask,
      agentId: uniqueAgentIds.indexOf(subtask.agentId) + 1,
      agentLabel: getLabelForAgentId(subtask.agentId),
    }));
  }

  // Step 4-6: Keep first N-1 agents and merge the rest into agent N
  const keptAgentIds = uniqueAgentIds.slice(0, maxAgentCount - 1);
  const mergedAgentLabel = getLabelForAgentId(
    uniqueAgentIds[maxAgentCount - 1] ??
      uniqueAgentIds[uniqueAgentIds.length - 1] ??
      1,
  );
  return subtasks.map((subtask) => {
    // Renumber kept agents to 1..N-1
    if (keptAgentIds.includes(subtask.agentId)) {
      return {
        ...subtask,
        agentId: keptAgentIds.indexOf(subtask.agentId) + 1,
        agentLabel: getLabelForAgentId(subtask.agentId),
      };
    }
    // Assign merged label to all overflow agents
    return { ...subtask, agentId: maxAgentCount, agentLabel: mergedAgentLabel };
  });
};

/**
 * <Summary>
 * What it does:
 *   Collapses subtasks to use exactly 2 agents (setup and implementation).
 *
 * How it does it (step by step):
 *   1. Get sorted list of unique agent IDs from subtasks.
 *   2. If <= 2 agents, map first to agent 1 (setup) and rest to agent 2 (implementation).
 *   3. If > 2 agents, map first agent to agent 1 (setup) and all others to agent 2 (implementation).
 *
 * Parameters:
 *   @param subtasks - List of planned subtasks to collapse.
 *
 * Returns:
 *   New array of subtasks with exactly 2 agent IDs (1 and 2).
 * </Summary>
 */
const collapseToTwoAgents = (subtasks: PlannedSubtask[]): PlannedSubtask[] => {
  // Step 1: Get sorted list of unique agent IDs from subtasks
  const uniqueAgentIds = [
    ...new Set(subtasks.map((subtask) => subtask.agentId)),
  ].sort((agentIdA, agentIdB) => agentIdA - agentIdB);
  // Step 2: If <= 2 agents, map to 1 and 2 with appropriate labels
  if (uniqueAgentIds.length <= 2) {
    return subtasks.map((subtask) => ({
      ...subtask,
      agentId: subtask.agentId === uniqueAgentIds[0] ? 1 : 2,
      agentLabel:
        subtask.agentId === uniqueAgentIds[0]
          ? (subtasks.find((subtask) => subtask.agentId === uniqueAgentIds[0])
              ?.agentLabel ?? "setup")
          : "implementation",
    }));
  }
  // Step 3: If > 2 agents, map first to 1, rest to 2
  const firstAgentId = uniqueAgentIds[0] ?? 1;
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
 * <Summary>
 * What it does:
 *   Applies the max_agents constraint to an advisor plan, collapsing agents if needed.
 *
 * How it does it (step by step):
 *   1. Copy subtasks to avoid mutating original plan.
 *   2. Validate no cycles exist; if cycles found, linearize dependencies.
 *   3. If maxAgents is 1, collapse to single agent (sequential).
 *   4. If maxAgents is 2, collapse to two agents (collab mode).
 *   5. If maxAgents is "max", keep all agents as-is.
 *   6. If maxAgents is a number >= 3, collapse to at most that many agents.
 *   7. Otherwise, keep original agent count.
 *   8. Recalculate agent count and execution mode.
 *
 * Parameters:
 *   @param plan - The advisor plan to apply constraints to.
 *   @param maxAgents - The max_agents constraint from configuration.
 *
 * Returns:
 *   New advisor plan with agent count constraint applied.
 * </Summary>
 */
export const applyMaxAgentsConstraint = (
  plan: AdvisorPlan,
  maxAgents: MaxAgentsParam,
): AdvisorPlan => {
  // Step 1: Copy subtasks to avoid mutating original plan
  let constrainedSubtasks = [...plan.subtasks];

  // Step 2: Validate no cycles exist; if cycles found, linearize dependencies
  if (!validateNoCycles(constrainedSubtasks)) {
    const sortedSubtasks = [...constrainedSubtasks].sort(
      (subtaskA, subtaskB) => subtaskA.id - subtaskB.id,
    );
    constrainedSubtasks = sortedSubtasks.map((subtask, index) => ({
      ...subtask,
      // Linearize: each subtask depends only on the previous one
      dependsOn: index === 0 ? [] : [sortedSubtasks[index - 1]!.id],
    }));
  }

  // Step 3: If maxAgents is 1, collapse to single agent (sequential)
  if (maxAgents === 1) {
    constrainedSubtasks = collapseToSingleAgent(constrainedSubtasks);
    return {
      ...plan,
      subtasks: constrainedSubtasks,
      agentCount: 1,
      execution: "sequential",
    };
  }

  // Step 4: If maxAgents is 2, collapse to two agents (collab mode)
  if (maxAgents === 2) {
    constrainedSubtasks = collapseToTwoAgents(constrainedSubtasks);
    return {
      ...plan,
      subtasks: constrainedSubtasks,
      agentCount: 2,
      execution: deriveExecution(constrainedSubtasks),
    };
  }

  // Step 5: If maxAgents is "max", keep all agents as-is
  if (maxAgents === "max") {
    const uniqueAgentIds = new Set(
      constrainedSubtasks.map((subtask) => subtask.agentId),
    );
    return {
      ...plan,
      subtasks: constrainedSubtasks,
      agentCount: uniqueAgentIds.size,
      execution: deriveExecution(constrainedSubtasks),
    };
  }

  // Step 6: If maxAgents is a number >= 3, collapse to at most that many agents
  if (typeof maxAgents === "number" && maxAgents >= 3) {
    const uniqueAgentIds = new Set(
      constrainedSubtasks.map((subtask) => subtask.agentId),
    );
    if (uniqueAgentIds.size > maxAgents) {
      constrainedSubtasks = collapseToNAgents(constrainedSubtasks, maxAgents);
    }
    return {
      ...plan,
      subtasks: constrainedSubtasks,
      agentCount: new Set(constrainedSubtasks.map((subtask) => subtask.agentId))
        .size,
      execution: deriveExecution(constrainedSubtasks),
    };
  }

  // Step 7: Otherwise, keep original agent count
  const uniqueAgentIds = new Set(
    constrainedSubtasks.map((subtask) => subtask.agentId),
  );
  return {
    ...plan,
    subtasks: constrainedSubtasks,
    agentCount: uniqueAgentIds.size,
    execution: deriveExecution(constrainedSubtasks),
  };
};
