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
  workerCountFor,
} from "../../../packages/server/src/orchestration/readyQueue.js";
import type { ToolResultSummary } from "../../../packages/server/src/orchestration/types.js";
import { emptyCommandPlan } from "../../../packages/server/src/orchestration/types.js";

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
});

