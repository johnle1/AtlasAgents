/**
 * Pure FIFO message queue for lines typed while a task is running.
 *
 * @remarks
 * Enter never disturbs the in-flight task (cli behavior). The line
 * waits here and is drained through the normal submit path once the task
 * finishes. Cap {@link QUEUE_CAP} drops the oldest item on overflow.
 * Session helpers wrap a process-wide store; cancel / disconnect must call
 * {@link clearSessionQueue}.
 *
 * @example
 * ```ts
 * let state = emptyQueue();
 * state = enqueueMessage(state, "follow up");
 * const { next, state: rest } = dequeueMessage(state);
 * // next === "follow up"
 * ```
 */

/** Maximum queued lines. Enqueue past this drops the oldest. */
export const QUEUE_CAP = 20;

/**
 * Snapshot of the pending-message queue.
 */
export type MessageQueueState = {
  /** FIFO lines, oldest first. */
  items: string[];
};

/**
 * Returns an empty queue.
 */
export const emptyQueue = (): MessageQueueState => ({
  items: [],
});

/**
 * Appends a trimmed line. Blank input is ignored.
 *
 * @param state - Current queue.
 * @param line - Raw prompt text (trimmed before store).
 * @param cap - Max length; defaults to {@link QUEUE_CAP}.
 * @returns Next state (oldest dropped when past {@link QUEUE_CAP}).
 */
export const enqueueMessage = (
  state: MessageQueueState,
  line: string,
  cap: number = QUEUE_CAP,
): MessageQueueState => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return state;
  }
  const items = [...state.items, trimmed];
  if (items.length <= cap) {
    return { items };
  }
  return {
    items: items.slice(items.length - cap),
  };
};

/**
 * Removes the oldest line.
 *
 * @param state - Current queue.
 * @returns `next` is `undefined` when empty.
 */
export const dequeueMessage = (
  state: MessageQueueState,
): { next: string | undefined; state: MessageQueueState } => {
  if (state.items.length === 0) {
    return { next: undefined, state };
  }
  const [next, ...rest] = state.items;
  return { next, state: { items: rest } };
};

/**
 * Drops every pending line (Esc-cancel / disconnect).
 *
 * @returns A fresh empty queue.
 */
export const clearQueue = (): MessageQueueState => emptyQueue();

let sessionQueue: MessageQueueState = emptyQueue();

/**
 * Returns the process-wide queue (not persisted).
 */
export const getSessionQueue = (): MessageQueueState => sessionQueue;

/**
 * Enqueues onto the process-wide store.
 *
 * @param line - Raw prompt text.
 * @returns The updated session queue.
 */
export const enqueueSessionMessage = (line: string): MessageQueueState => {
  sessionQueue = enqueueMessage(sessionQueue, line);
  return sessionQueue;
};

/**
 * Dequeues the oldest session line.
 *
 * @returns The next line (if any) and the updated store.
 */
export const dequeueSessionMessage = (): {
  next: string | undefined;
  state: MessageQueueState;
} => {
  const result = dequeueMessage(sessionQueue);
  sessionQueue = result.state;
  return result;
};

/**
 * Clears the process-wide queue.
 *
 * @returns The empty store.
 */
export const clearSessionQueue = (): MessageQueueState => {
  sessionQueue = clearQueue();
  return sessionQueue;
};
