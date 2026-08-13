/**
 * Unit tests — client ui/queue/messageQueue.ts
 *
 * Pure FIFO queue used while a task is running. Enter never disturbs the
 * in-flight task; the line waits and drains when idle.
 *
 * Category checklist:
 * - Normal: enqueue while "busy"; dequeue emits FIFO
 * - Boundary: cap 20 drops oldest; empty dequeue
 * - Error: blank lines are ignored; clear empties the queue (cancel)
 */

import { describe, expect, it } from "vitest";
import {
  QUEUE_CAP,
  clearQueue,
  dequeueMessage,
  emptyQueue,
  enqueueMessage,
} from "../../../../packages/client/src/ui/queue/messageQueue.js";

describe("enqueueMessage / dequeueMessage (normal)", () => {
  it("enqueues while busy and dequeues in FIFO order", () => {
    let state = emptyQueue();
    state = enqueueMessage(state, "first");
    state = enqueueMessage(state, "second");
    expect(state.items).toEqual(["first", "second"]);

    const first = dequeueMessage(state);
    expect(first.next).toBe("first");
    const second = dequeueMessage(first.state);
    expect(second.next).toBe("second");
    expect(second.state.items).toEqual([]);
  });
});

describe("enqueueMessage cap (boundary)", () => {
  it("drops the oldest item when the cap is exceeded", () => {
    let state = emptyQueue();
    for (let index = 0; index < QUEUE_CAP; index += 1) {
      state = enqueueMessage(state, `line-${index}`);
    }
    expect(state.items).toHaveLength(QUEUE_CAP);

    state = enqueueMessage(state, "overflow");
    expect(state.items).toHaveLength(QUEUE_CAP);
    expect(state.items[0]).toBe("line-1");
    expect(state.items[QUEUE_CAP - 1]).toBe("overflow");
  });

  it("returns undefined on dequeue of an empty queue", () => {
    const { next, state } = dequeueMessage(emptyQueue());
    expect(next).toBeUndefined();
    expect(state.items).toEqual([]);
  });
});

describe("enqueueMessage / clearQueue (error / cancel)", () => {
  it("ignores blank lines (error)", () => {
    const state = enqueueMessage(emptyQueue(), "   ");
    expect(state.items).toEqual([]);
  });

  it("clears every pending line (cancel)", () => {
    let state = enqueueMessage(emptyQueue(), "keep me");
    state = enqueueMessage(state, "me too");
    state = clearQueue();
    expect(state.items).toEqual([]);
  });
});
