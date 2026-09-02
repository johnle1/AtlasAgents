/**
 * Unit tests — server orchestration/readyQueue.ts
 */

import { describe, expect, it } from "vitest";
import {
  available,
  buildSubagentBoardSnapshots,
  buildQueueSnapshot,
  complete,
  createReadyQueue,
  isDone,
  maxDagWidth,
  take,
  WorkSignal,
  workerCountFor,
} from "../../../../packages/server/src/orchestration/readyQueue.js";
import type { ToolResultSummary } from "../../../../packages/server/src/orchestration/types.js";
import { emptyCommandPlan } from "../../../../packages/server/src/orchestration/types.js";

const sampleResult = (
  summary: string,
  ok = true,
): ToolResultSummary => ({
  summary,
  keyFindings: ["finding"],
  filesTouched: ["src/a.ts"],
  ok,
});

const subtask = (
  id: number,
  text: string,
  dependsOn: number[] = [],
  agentId = 0,
  agentLabel = "A",
) => ({
  id,
  text,
  dependsOn,
  agentId,
  agentLabel,
});

describe("ReadyQueue.complete", () => {
  it("stores structured ToolResultSummary in completed map", () => {
    const queue = createReadyQueue([
      subtask(1, "first"),
      subtask(2, "second", [1]),
    ]);

    const ready = available(queue);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe(1);

    const newlyReady = complete(queue, 1, sampleResult("done one"));
    expect(newlyReady).toHaveLength(1);
    expect(newlyReady[0]?.id).toBe(2);

    expect(queue.completed.get(1)).toEqual(sampleResult("done one"));
  });

  it("stores failed results without unlocking dependents", () => {
    const queue = createReadyQueue([
      subtask(1, "first"),
      subtask(2, "second", [1]),
    ]);
    take(queue, 1);

    const newlyReady = complete(queue, 1, sampleResult("scaffold failed", false));
    expect(newlyReady).toHaveLength(0);
    expect(queue.failed.get(1)?.summary).toBe("scaffold failed");
    expect(queue.completed.has(1)).toBe(false);
    expect(available(queue)).toHaveLength(0);
  });
});

describe("ReadyQueue.available", () => {
  it("returns all tasks when none have dependencies", () => {
    const queue = createReadyQueue([
      subtask(2, "b"),
      subtask(1, "a"),
    ]);
    const ready = available(queue);
    expect(ready.map((t) => t.id)).toEqual([1, 2]);
  });

  it("sorts by critical path length (longest first)", () => {
    const queue = createReadyQueue([
      subtask(1, "leaf"),
      subtask(2, "chain head", [], 0, "A"),
      subtask(3, "depends on 2", [2]),
      subtask(4, "depends on 3", [3]),
    ]);
    complete(queue, 1, sampleResult("leaf done"));
    const ready = available(queue);
    expect(ready[0]?.id).toBe(2);
  });
});

describe("ReadyQueue incremental ready-set (multi-wave)", () => {
  it("keeps available() in sync with take()/complete() across a 3-level DAG without rescanning pending", () => {
    // Wave 0: 1, 2 (no deps). Wave 1: 3 (needs both 1 and 2). Wave 2: 4, 5 (need 3).
    const queue = createReadyQueue([
      subtask(1, "a"),
      subtask(2, "b"),
      subtask(3, "c", [1, 2]),
      subtask(4, "d", [3]),
      subtask(5, "e", [3]),
    ]);

    // Wave 0: both roots ready up front.
    expect(available(queue).map((t) => t.id)).toEqual([1, 2]);

    take(queue, 1);
    // take() removes only the claimed task from the ready set.
    expect(available(queue).map((t) => t.id)).toEqual([2]);

    take(queue, 2);
    // Nothing left ready — 3 is still blocked on both 1 and 2.
    expect(available(queue)).toHaveLength(0);

    // Completing 1 alone doesn't unlock 3 (2 hasn't completed yet).
    expect(complete(queue, 1, sampleResult("done 1"))).toHaveLength(0);
    expect(available(queue)).toHaveLength(0);

    // Completing 2 satisfies both of 3's dependencies — it enters `ready`.
    const afterTwo = complete(queue, 2, sampleResult("done 2"));
    expect(afterTwo.map((t) => t.id)).toEqual([3]);
    expect(available(queue).map((t) => t.id)).toEqual([3]);

    take(queue, 3);
    expect(available(queue)).toHaveLength(0);

    // Completing 3 unlocks both wave-2 leaves in one shot.
    const afterThree = complete(queue, 3, sampleResult("done 3"));
    expect(afterThree.map((t) => t.id).sort()).toEqual([4, 5]);
    expect(available(queue).map((t) => t.id)).toEqual([4, 5]);

    take(queue, 4);
    expect(available(queue).map((t) => t.id)).toEqual([5]);

    take(queue, 5);
    complete(queue, 4, sampleResult("done 4"));
    complete(queue, 5, sampleResult("done 5"));

    expect(available(queue)).toHaveLength(0);
    expect(isDone(queue)).toBe(true);
  });
});

describe("ReadyQueue.take", () => {
  it("moves a pending task to running", () => {
    const queue = createReadyQueue([subtask(1, "task")]);
    expect(take(queue, 1)).toBe(true);
    expect(queue.pending.has(1)).toBe(false);
    expect(queue.running.has(1)).toBe(true);
  });

  it("returns false for unknown task id", () => {
    const queue = createReadyQueue([subtask(1, "task")]);
    expect(take(queue, 99)).toBe(false);
  });
});

describe("ReadyQueue.isDone", () => {
  it("returns false when tasks remain", () => {
    const queue = createReadyQueue([subtask(1, "task")]);
    expect(isDone(queue)).toBe(false);
  });

  it("returns true when all tasks are completed", () => {
    const queue = createReadyQueue([subtask(1, "task")]);
    take(queue, 1);
    complete(queue, 1, sampleResult("done"));
    expect(isDone(queue)).toBe(true);
  });
});

describe("buildQueueSnapshot", () => {
  it("truncates text and marks blocked tasks", () => {
    const longText = "x".repeat(50);
    const queue = createReadyQueue([
      subtask(1, "ready"),
      subtask(2, longText, [1]),
    ]);
    const snapshot = buildQueueSnapshot(queue);
    expect(snapshot).toHaveLength(2);
    expect(snapshot[1]?.text.length).toBe(40);
    expect(snapshot[1]?.blocked).toBe(true);
    expect(snapshot[0]?.blocked).toBe(false);
  });
});

describe("buildSubagentBoardSnapshots", () => {
  it("groups tasks by agent", () => {
    const tasks = [
      subtask(1, "a1", [], 0, "Agent A"),
      subtask(2, "a2", [], 1, "Agent B"),
      subtask(3, "a1b", [], 0, "Agent A"),
    ];
    const queue = createReadyQueue(tasks);
    take(queue, 1);
    const boards = buildSubagentBoardSnapshots(tasks, queue);
    expect(boards).toHaveLength(2);
    expect(boards[0]?.tasks).toHaveLength(2);
    expect(boards[1]?.tasks).toHaveLength(1);
    expect(boards[0]?.tasks[0]?.state).toBe("running");
  });

  it("marks failed tasks with failed lifecycle state", () => {
    const tasks = [subtask(1, "scaffold", [], 0, "Agent 1")];
    const queue = createReadyQueue(tasks);
    take(queue, 1);
    complete(queue, 1, sampleResult("gave up", false));
    const boards = buildSubagentBoardSnapshots(tasks, queue);
    expect(boards[0]?.tasks[0]?.state).toBe("failed");
  });
});

describe("maxDagWidth", () => {
  it("returns 0 for empty plan", () => {
    expect(maxDagWidth([])).toBe(0);
  });

  it("returns parallel width for independent tasks", () => {
    expect(
      maxDagWidth([
        subtask(1, "a"),
        subtask(2, "b"),
        subtask(3, "c"),
      ]),
    ).toBe(3);
  });

  it("returns 1 for sequential chain", () => {
    expect(
      maxDagWidth([
        subtask(1, "a"),
        subtask(2, "b", [1]),
        subtask(3, "c", [2]),
      ]),
    ).toBe(1);
  });
});

describe("workerCountFor", () => {
  const plan = (subtasks: ReturnType<typeof subtask>[]) => ({
    subtasks,
    risks: [],
    commandPlan: emptyCommandPlan(),
    execution: "sequential" as const,
    agentCount: 1,
  });

  it("returns 0 for empty plan", () => {
    expect(workerCountFor(3, plan([]))).toBe(0);
  });

  it("returns 1 for maxSubagents=1", () => {
    expect(
      workerCountFor(1, plan([subtask(1, "a"), subtask(2, "b")])),
    ).toBe(1);
  });

  it("returns 2 for maxSubagents=2", () => {
    expect(
      workerCountFor(2, plan([subtask(1, "a"), subtask(2, "b")])),
    ).toBe(2);
  });

  it("returns dag width for maxSubagents=max", () => {
    expect(
      workerCountFor(
        "max",
        plan([subtask(1, "a"), subtask(2, "b"), subtask(3, "c")]),
      ),
    ).toBe(3);
  });

  it("caps custom number by dag width", () => {
    expect(
      workerCountFor(5, plan([subtask(1, "a"), subtask(2, "b")])),
    ).toBe(2);
  });

  it("defaults to min(3, dagWidth) when maxSubagents is undefined", () => {
    expect(
      workerCountFor(
        undefined as unknown as 3,
        plan([
          subtask(1, "a"),
          subtask(2, "b"),
          subtask(3, "c"),
          subtask(4, "d"),
        ]),
      ),
    ).toBe(3);
  });

  describe("isLocalProvider ceiling", () => {
    const sixIndependentSteps = plan([
      subtask(1, "a"),
      subtask(2, "b"),
      subtask(3, "c"),
      subtask(4, "d"),
      subtask(5, "e"),
      subtask(6, "f"),
    ]);

    it("caps maxSubagents=max at the local-provider ceiling instead of the full dag width (normal)", () => {
      expect(workerCountFor("max", sixIndependentSteps, true)).toBe(4);
    });

    it("caps a custom number above the ceiling the same way (normal)", () => {
      expect(workerCountFor(6, sixIndependentSteps, true)).toBe(4);
    });

    it("leaves a custom number already under the ceiling unaffected (boundary)", () => {
      expect(workerCountFor(2, sixIndependentSteps, true)).toBe(2);
    });

    it("does not cap a remote/hosted provider — isLocalProvider defaults to false (regression guard)", () => {
      expect(workerCountFor("max", sixIndependentSteps)).toBe(6);
      expect(workerCountFor("max", sixIndependentSteps, false)).toBe(6);
    });
  });
});

describe("WorkSignal", () => {
  it("wait resolves when broadcast is called", async () => {
    const signal = new WorkSignal();
    let done = false;
    const pending = signal.wait().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    signal.broadcast();
    await pending;
    expect(done).toBe(true);
  });

  it("broadcast wakes all waiters", async () => {
    const signal = new WorkSignal();
    const pending = Promise.all([signal.wait(), signal.wait()]);
    signal.broadcast();
    await pending;
  });

  it("wait uses an internal resolver promise", async () => {
    const signal = new WorkSignal();
    const pending = signal.wait();
    signal.broadcast();
    await pending;
  });
});

