// ===== MUTEX CLASS =====
/**
 * Simple Promise-based mutex for preventing concurrent config file operations.
 *
 * **Purpose:**
 * Ensures that only one async operation (load, save, set, setModel) can access
 * or modify the config file at a time. This prevents race conditions where multiple
 * callers might read stale data or overwrite each other's changes.
 *
 * **How It Works:**
 * - `acquire()` claims the lock immediately if available, or queues the caller
 * - `release()` gives the lock to the next queued caller (FIFO order)
 * - `run()` is the typical interface: acquire lock, execute function, release lock
 *
 * **Thread Safety:**
 * Protects against concurrent mutations of the config file, but does NOT cache
 * the file contents in memory. Each load() still reads fresh from disk to ensure
 * consistency across distributed file access.
 */
export class Mutex {
  /** True when the lock is currently held by some caller */
  private locked = false;

  /** Queue of resolve functions waiting for the lock to become available */
  private queue: Array<() => void> = [];

  /**
   * Acquire the mutex lock, blocking until available.
   *
   * **Behavior:**
   * - If lock is free: immediately sets locked=true and returns
   * - If lock is held: returns a promise that resolves when previous holder releases
   *
   * **Usage Pattern:**
   * Normally called via `run()`, not directly. For direct use, always pair with
   * a try/finally block to ensure release() is called.
   *
   * @returns Promise that resolves when lock is acquired
   */
  async acquire(): Promise<void> {
    // Fast path: lock is free, claim it immediately
    if (!this.locked) {
      this.locked = true;
      return;
    }

    // Slow path: lock is held, queue a promise to resolve when freed
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release the mutex lock and wake the next waiter (if any).
   *
   * **Behavior:**
   * - If someone is waiting: resolve their promise (wakes them up)
   * - If no one is waiting: set locked=false for next immediate acquire()
   *
   * **Important:** Must be paired with acquire(). Always call in a finally block
   * to guarantee release even if the critical section throws an error.
   */
  release(): void {
    // Dequeue the first waiting caller (FIFO fairness)
    const next = this.queue.shift();

    if (next) {
      // Wake the next caller by resolving their promise
      next();
    } else {
      // No one waiting, mark lock as free for fast acquire() path
      this.locked = false;
    }
  }

  /**
   * Safely acquire lock, run a function, then release lock.
   *
   * **Pattern:**
   * This is the primary way to use the mutex. It handles acquire/release
   * automatically using try/finally to guarantee release even on error.
   *
   * **Example:**
   * ```typescript
   * const result = await mutex.run(async () => {
   *   const config = await loadFromDisk();
   *   config.subagentModel = "llama2";
   *   await saveToDisk(config);
   *   return "saved";
   * });
   * ```
   *
   * @template T The return type of the function
   * @param fn Async function to execute while holding the lock
   * @returns Promise resolving to the function's return value
   * @throws Re-throws any error thrown by fn
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Acquire lock (waits if necessary)
    await this.acquire();

    try {
      // Execute the critical section while holding lock
      return await fn();
    } finally {
      // ALWAYS release lock, even if fn() threw an error
      this.release();
    }
  }
}
