/**
 * Task queue management for executing agent plans with DAG dependencies.
 *
 * @remarks
 * Manages the execution of subtasks from agent plans by tracking pending, running,
 * and completed tasks. Provides functions to determine which tasks are ready to execute
 * based on their dependencies, handles critical path analysis for optimal task ordering,
 * and builds snapshots for UI display. The queue uses a dependency graph to ensure
 * tasks execute in the correct order while maximizing parallelism.
 */

import type {
  SubagentBoardSnapshot,
  SubagentTaskSnapshot,
  TaskLifecycleState,
} from "@atlasagents/shared";
import type { MaxSubagentsParam } from "./maxSubagents.js";
import type {
  SubagentPlan,
  PlannedSubtask,
  ToolResultSummary,
} from "./types.js";

/**
 * Interface representing the state of the task execution queue.
 *
 * @remarks
 * Tracks which subtasks are pending, currently running, and completed. This state is
 * used to determine which tasks can be executed next based on their dependency constraints.
 * The queue enables parallel execution while respecting dependency ordering.
 */
export interface ReadyQueue {
  // Tasks waiting for dependencies to be satisfied, tracked by ID only.
  // Object lookups go through `allById`, not this set.
  pending: Set<number>;

  // Canonical id -> subtask lookup, built once at creation. Every id in
  // `pending`/`ready` is guaranteed present here.
  allById: Map<number, PlannedSubtask>;

  // Subset of `pending` whose dependencies are all satisfied, i.e. what
  // available() would return. Maintained incrementally by take() (removes)
  // and complete() (adds newly-unblocked dependents) so available() never
  // has to rescan all of `pending` — only this typically-small ready subset.
  ready: Map<number, PlannedSubtask>;

  // Tasks currently executing; prevents duplicate assignment to multiple workers
  running: Set<number>;

  // Completed tasks keyed by ID; used to check if dependencies are done
  completed: Map<number, ToolResultSummary>;

  // Failed tasks; when a task fails, all its dependents are blocked (treated as never completing)
  failed: Map<number, ToolResultSummary>;

  // Reverse dependency index: taskId -> tasks that directly depend on it.
  // Built once at creation so complete() can find affected tasks in O(k)
  // (k = direct dependents) instead of scanning every pending task, O(n).
  dependents: Map<number, PlannedSubtask[]>;

  // Precomputed critical path length per task, keyed by ID. Computed once
  // over the full static DAG at creation time (dependsOn edges never change
  // after planning), so available() can sort in O(k log k) via a lookup
  // instead of recursively recomputing the path on every call, O(n^2).
  criticalPathLengths: Map<number, number>;
}

/**
 * Builds a reverse dependency index: taskId -> tasks that directly depend on it.
 *
 * @remarks
 * Computed once at queue creation (O(n + e), n = tasks, e = total dependsOn
 * edges) so later lookups of "who depends on this task" are O(1) instead of
 * scanning every task. This is the index complete() uses to avoid an O(n)
 * scan of the pending set on every subtask completion.
 *
 * @param subtasks - All planned subtasks in the plan
 *
 * @returns Map from task ID to the list of tasks that list it as a dependency
 */
const buildDependentsIndex = (
  subtasks: PlannedSubtask[],
): Map<number, PlannedSubtask[]> => {
  const dependents = new Map<number, PlannedSubtask[]>();

  for (const subtask of subtasks) {
    for (const dependencyId of subtask.dependsOn) {
      const existing = dependents.get(dependencyId);
      if (existing) {
        existing.push(subtask);
      } else {
        dependents.set(dependencyId, [subtask]);
      }
    }
  }

  return dependents;
};

/**
 * Precomputes the critical path length for every subtask in the plan.
 *
 * @remarks
 * Walks the full static dependency DAG once (dependsOn edges are fixed after
 * planning and never change during execution), memoizing each task's length
 * as 1 + the longest path through its dependents. This replaces recomputing
 * the path recursively on every `available()` call: O(n) total here instead
 * of O(n) work repeated on every scheduling decision (O(n^2) over a run).
 *
 * A `visiting` guard prevents infinite recursion / stack overflow if a
 * malformed plan contains a dependency cycle — a cyclic task is simply
 * treated as a leaf (length 1) rather than crashing the scheduler.
 *
 * @param subtasks - All planned subtasks in the plan
 * @param dependents - Reverse dependency index from {@link buildDependentsIndex}
 *
 * @returns Map from task ID to its critical path length
 */
const computeCriticalPathLengths = (
  subtasks: PlannedSubtask[],
  dependents: Map<number, PlannedSubtask[]>,
): Map<number, number> => {
  const lengths = new Map<number, number>();

  const resolve = (subtask: PlannedSubtask, visiting: Set<number>): number => {
    const cached = lengths.get(subtask.id);
    if (cached !== undefined) {
      return cached;
    }

    if (visiting.has(subtask.id)) {
      // Cyclic dependsOn (shouldn't happen for a valid plan) — bail out as a leaf
      return 1;
    }
    visiting.add(subtask.id);

    const downstreamSubtasks = dependents.get(subtask.id) ?? [];
    const length =
      downstreamSubtasks.length === 0
        ? 1
        : 1 +
          Math.max(
            ...downstreamSubtasks.map((downstreamTask) =>
              resolve(downstreamTask, visiting),
            ),
          );

    visiting.delete(subtask.id);
    lengths.set(subtask.id, length);
    return length;
  };

  for (const subtask of subtasks) {
    resolve(subtask, new Set());
  }

  return lengths;
};

/**
 * Creates a ready queue from a list of planned subtasks.
 *
 * @remarks
 * Initializes the queue with all subtasks in the pending state, and empty running
 * and completed sets. Also builds the reverse dependency index, precomputes
 * critical path lengths, and seeds the incremental `ready` subset (every
 * subtask with no dependencies) once up front, so `available()`, `take()`,
 * and `complete()` stay fast (avoiding O(n) / O(n^2) work per call) even for
 * large plans. The queue is ready for execution with all tasks waiting for
 * their dependencies to be satisfied.
 *
 * @param subtasks - List of planned subtasks to queue
 *
 * @returns Initialized ready queue with all tasks in pending state
 */
export const createReadyQueue = (subtasks: PlannedSubtask[]): ReadyQueue => {
  const dependents = buildDependentsIndex(subtasks);
  const allById = new Map(subtasks.map((subtask) => [subtask.id, subtask]));

  const ready = new Map<number, PlannedSubtask>();
  for (const subtask of subtasks) {
    if (subtask.dependsOn.length === 0) {
      ready.set(subtask.id, subtask);
    }
  }

  return {
    pending: new Set(subtasks.map((subtask) => subtask.id)),
    allById,
    ready,
    running: new Set(),
    completed: new Map(),
    failed: new Map(),
    dependents,
    criticalPathLengths: computeCriticalPathLengths(subtasks, dependents),
  };
};

/**
 * Returns list of subtasks that are ready to execute (all dependencies met).
 *
 * @remarks
 * Reads directly from the queue's incrementally-maintained `ready` subset
 * (kept in sync by {@link take} and {@link complete}) rather than rescanning
 * every pending task, so this is O(r log r) in the ready-set size r —
 * typically bounded by DAG width — instead of O(p) in the (often much
 * larger, only-shrinking-slowly) pending count p. Sorts by critical path
 * length (longest first) to prioritize tasks that would block the most
 * downstream work, then by ID for consistent ordering. Critical path lengths
 * are read from the queue's precomputed cache (built once in
 * {@link createReadyQueue}) rather than recalculated here.
 *
 * @param queue - The current queue state
 *
 * @returns Array of ready subtasks sorted by priority
 */
export const available = (queue: ReadyQueue): PlannedSubtask[] =>
  [...queue.ready.values()].sort((taskA, taskB) => {
    const pathDifference =
      (queue.criticalPathLengths.get(taskB.id) ?? 1) -
      (queue.criticalPathLengths.get(taskA.id) ?? 1);
    // Tiebreaker: sort by ID for stable ordering
    return pathDifference !== 0 ? pathDifference : taskA.id - taskB.id;
  });

/**
 * Moves a subtask from pending to running state.
 *
 * @remarks
 * Atomically claims a subtask for execution by removing it from pending
 * (and the `ready` subset) and adding it to running. Returns false if the
 * subtask is not in pending (may have been taken by another worker). Used
 * by worker threads to claim available work.
 *
 * @param queue - The current queue state
 * @param subtaskId - The ID of the subtask to take
 *
 * @returns True if subtask was moved to running, false if not found
 */
export const take = (queue: ReadyQueue, subtaskId: number): boolean => {
  if (!queue.pending.has(subtaskId)) {
    return false;
  }

  queue.pending.delete(subtaskId);
  queue.ready.delete(subtaskId);
  queue.running.add(subtaskId);

  return true;
};

/**
 * Marks a subtask as completed and returns newly ready tasks.
 *
 * @remarks
 * Moves the subtask from running to completed (or failed if result.ok is false).
 * Checks only this task's direct dependents (via the queue's precomputed reverse
 * dependency index, {@link buildDependentsIndex}) for any that now have all
 * dependencies satisfied. This is O(k) in the number of direct dependents k,
 * instead of scanning every pending task, O(n) — the difference matters once
 * a plan has hundreds to thousands of subtasks. Newly-ready dependents are
 * also added to the queue's `ready` subset (so {@link available} can read
 * them without a rescan) and returned for workers to claim.
 *
 * Assumes {@link take} was already called for `subtaskId` (true of all
 * production usage in the worker pool) — this is what keeps `subtaskId`
 * out of `ready` on completion; calling `complete()` without a prior `take()`
 * leaves the completed id lingering in `pending`/`ready` and is unsupported.
 *
 * @param queue - The current queue state
 * @param subtaskId - The ID of the subtask that completed
 * @param result - The result from the subtask execution
 *
 * @returns Array of newly ready tasks
 */
export const complete = (
  queue: ReadyQueue,
  subtaskId: number,
  result: ToolResultSummary,
): PlannedSubtask[] => {
  // Remove from running state
  queue.running.delete(subtaskId);

  // If the task failed, mark it as failed and stop processing its dependents
  // (Failed tasks don't unlock any downstream work)
  if (result.ok) {
    queue.completed.set(subtaskId, result);
  } else {
    queue.failed.set(subtaskId, result);
    return [];
  }

  // Only this task's direct dependents can possibly have become ready —
  // everything else is unaffected by this completion.
  const directDependents = queue.dependents.get(subtaskId) ?? [];
  const newlyReadySubtasks: PlannedSubtask[] = [];

  for (const dependent of directDependents) {
    // A dependent may have already been claimed (running) or finished
    // (completed/failed) via another path; only pending tasks can transition.
    if (!queue.pending.has(dependent.id)) {
      continue;
    }
    const allDependenciesDone = dependent.dependsOn.every((dependencyId) =>
      queue.completed.has(dependencyId),
    );
    if (allDependenciesDone) {
      newlyReadySubtasks.push(dependent);
      queue.ready.set(dependent.id, dependent);
    }
  }

  return newlyReadySubtasks;
};

/**
 * Checks if all subtasks are completed (no pending or running tasks).
 *
 * @remarks
 * Returns true when both pending and running sets are empty, indicating all
 * subtasks have either completed or failed. Used to determine when execution
 * is finished.
 *
 * @param queue - The current queue state
 *
 * @returns True if all tasks are completed
 */
export const isDone = (queue: ReadyQueue): boolean =>
  queue.pending.size === 0 && queue.running.size === 0;

/**
 * Simplified snapshot item for queue display.
 *
 * @remarks
 * Used to build minimal queue snapshots for UI display without exposing full
 * subtask details. Truncates text to 40 characters for compact display.
 */
export type QueueSnapshotItem = {
  /** The subtask ID */
  id: number;

  /** Truncated subtask description (max 40 chars) */
  text: string;

  /** Whether the task is blocked by unmet dependencies */
  blocked: boolean;
};

/**
 * Builds a simplified snapshot of the pending queue for UI display.
 *
 * @remarks
 * Maps pending tasks to snapshot items with truncated text (40 chars) and blocked
 * status. Sorted by ID for consistent ordering. Used to show queue state in the UI
 * without exposing full subtask details.
 *
 * @param queue - The current queue state
 *
 * @returns Array of snapshot items for pending tasks
 */
export const buildQueueSnapshot = (queue: ReadyQueue): QueueSnapshotItem[] =>
  [...queue.pending]
    // `pending` tracks ids only; every id it holds was seeded from `allById`
    // in createReadyQueue and is never removed from allById, so this lookup
    // cannot miss.
    .map((subtaskId) => queue.allById.get(subtaskId)!)
    .sort((taskA, taskB) => taskA.id - taskB.id)
    .map((subtask) => ({
      id: subtask.id,
      text: subtask.text.slice(0, 40),
      blocked: !subtask.dependsOn.every((dependencyId) =>
        queue.completed.has(dependencyId),
      ),
    }));

/**
 * Determines the lifecycle state of a subtask based on queue state.
 *
 * @remarks
 * Checks the queue state to determine if a subtask is failed, complete, running,
 * waiting (dependencies met but not yet claimed), or blocked (dependencies not met).
 * Used for UI display and agent board snapshots.
 *
 * @param subtask - The subtask to check
 * @param queue - The current queue state
 *
 * @returns The lifecycle state of the subtask
 */
const taskLifecycleState = (
  subtask: PlannedSubtask,
  queue: ReadyQueue,
): TaskLifecycleState => {
  if (queue.failed.has(subtask.id)) {
    return "failed";
  }

  if (queue.completed.has(subtask.id)) {
    return "complete";
  }

  if (queue.running.has(subtask.id)) {
    return "running";
  }

  const dependenciesDone = subtask.dependsOn.every((dependencyId) =>
    queue.completed.has(dependencyId),
  );
  return dependenciesDone ? "waiting" : "blocked";
};

/**
 * Builds agent board snapshots showing task state for each agent group.
 *
 * @remarks
 * Groups subtasks by agent ID and creates snapshots with task lifecycle states.
 * Sorted by agent ID and task ID for consistent ordering. Used to display
 * agent progress in the UI.
 *
 * @param subtasks - All planned subtasks
 * @param queue - The current queue state
 *
 * @returns Array of agent board snapshots
 */
export const buildSubagentBoardSnapshots = (
  subtasks: PlannedSubtask[],
  queue: ReadyQueue,
): SubagentBoardSnapshot[] => {
  const agentMap = new Map<number, SubagentBoardSnapshot>();

  for (const subtask of subtasks) {
    if (!agentMap.has(subtask.agentId)) {
      agentMap.set(subtask.agentId, {
        id: subtask.agentId,
        label: subtask.agentLabel,
        tasks: [],
      });
    }

    const taskSnapshot: SubagentTaskSnapshot = {
      id: subtask.id,
      text: subtask.text,
      state: taskLifecycleState(subtask, queue),
    };
    agentMap.get(subtask.agentId)!.tasks.push(taskSnapshot);
  }

  return [...agentMap.values()]
    .sort((boardA, boardB) => boardA.id - boardB.id)
    .map((board) => ({
      ...board,
      tasks: [...board.tasks].sort((taskA, taskB) => taskA.id - taskB.id),
    }));
};

/**
 * Work signal for coordinating concurrent subagent execution.
 *
 * @remarks
 * Provides a simple synchronization primitive for worker threads/agents to wait
 * for work and be notified when new work is available. Workers call wait() to block
 * until work is available, and broadcast() wakes all waiting workers when new tasks
 * become ready.
 */
export class WorkSignal {
  // Queue of resolve functions, one per waiting worker thread
  private waiters: Array<() => void> = [];

  wait = (): Promise<void> =>
    new Promise((resolve) => {
      // Add this worker's resolver to the queue; it will be called on broadcast
      this.waiters.push(resolve);
    });

  broadcast = (): void => {
    // Wake all waiting workers at once (remove and call each resolver)
    // This is used when new tasks become ready to prevent thundering herd
    const allResolvers = this.waiters.splice(0);
    for (const resolver of allResolvers) {
      resolver();
    }
  };
}

/**
 * Calculates the maximum width of the execution DAG (maximum parallel tasks at any point).
 *
 * @remarks
 * Simulates topological wave execution via Kahn's algorithm (indegree counters)
 * to determine the maximum number of tasks that can run in parallel at any
 * point in the execution. This is used to determine the optimal worker count
 * for a given plan.
 *
 * Runs in O(n + e) (n = subtasks, e = total dependsOn edges) by decrementing
 * indegree counts as each wave completes, rather than rescanning every
 * remaining subtask on every wave — the naive approach is O(n^2) on a linear
 * dependency chain (n waves, each rescanning up to n remaining subtasks).
 *
 * @param subtasks - All planned subtasks in the plan
 *
 * @returns Maximum number of tasks that can run in parallel
 */
export const maxDagWidth = (subtasks: PlannedSubtask[]): number => {
  if (subtasks.length === 0) {
    return 0;
  }

  const dependents = buildDependentsIndex(subtasks);
  const indegree = new Map<number, number>(
    subtasks.map((subtask) => [subtask.id, subtask.dependsOn.length]),
  );

  // Wave 0: every subtask with no unmet dependencies
  let currentWave = subtasks.filter(
    (subtask) => (indegree.get(subtask.id) ?? 0) === 0,
  );
  let maxWidth = 0;

  // Simulate topological wave execution to find the widest parallel layer.
  // Each subtask is visited exactly once as a wave member, and each edge is
  // relaxed exactly once when its source subtask's wave is processed.
  while (currentWave.length > 0) {
    maxWidth = Math.max(maxWidth, currentWave.length);

    const nextWave: PlannedSubtask[] = [];
    for (const subtask of currentWave) {
      for (const dependent of dependents.get(subtask.id) ?? []) {
        const remaining = (indegree.get(dependent.id) ?? 0) - 1;
        indegree.set(dependent.id, remaining);
        if (remaining === 0) {
          nextWave.push(dependent);
        }
      }
    }
    currentWave = nextWave;
  }

  return maxWidth;
};

/**
 * Calculates the optimal worker count based on max_agents constraint and plan structure.
 *
 * @remarks
 * Calculates the DAG width (max parallel tasks) and applies the max_agents constraint
 * to determine the optimal worker count. Ensures the count is at least 1 and at most
 * the number of tasks. Different max_agents values produce different worker counts:
 * - 1: single worker (focus mode)
 * - 2: exactly two workers (collab mode)
 * - "max": as many workers as parallel tasks
 * - number: min(custom cap, DAG width)
 *
 * @param maxSubagents - The max_agents constraint
 * @param plan - The agent plan to analyze
 *
 * @returns Optimal worker count for this plan
 */
export const workerCountFor = (
  maxSubagents: MaxSubagentsParam,
  plan: SubagentPlan,
): number => {
  const subtaskCount = plan.subtasks.length;

  if (subtaskCount === 0) {
    return 0;
  }

  // Calculate max parallel tasks possible (the DAG's widest layer)
  const dagWidth = maxDagWidth(plan.subtasks);
  let workerCount: number;

  // Apply the max_agents constraint to determine worker count
  if (maxSubagents === 1) {
    // Focus mode: single worker, fully sequential
    workerCount = 1;
  } else if (maxSubagents === 2) {
    // Collab mode: exactly two workers
    workerCount = 2;
  } else if (maxSubagents === "max") {
    // Unlimited mode: use as much parallelism as available
    workerCount = dagWidth;
  } else if (typeof maxSubagents === "number") {
    // Custom cap: use min of user's cap and what the DAG allows
    workerCount = Math.min(maxSubagents, dagWidth);
  } else {
    // Fallback default: cap at 3 unless more parallelism is available
    workerCount = Math.min(3, dagWidth);
  }

  // Final bounds: at least 1 worker, at most as many as there are tasks
  return Math.max(1, Math.min(workerCount, subtaskCount));
};
