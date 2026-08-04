/**
 * Unit tests — ConfigManager Mutex (FIFO promise lock).
 */

import { describe, expect, it } from "vitest";
import { Mutex } from "../../../../packages/server/src/config/mutex.js";
import { ConfigError } from "../../../../packages/server/src/config/types.js";

describe("Mutex", () => {
  it("acquire then release allows a second acquire", async () => {
    const mutex = new Mutex();
    await mutex.acquire();
    mutex.release();
    await mutex.acquire();
    mutex.release();
  });

  it("queues a second acquire until release", async () => {
    const mutex = new Mutex();
    await mutex.acquire();

    let secondAcquired = false;
    const pending = mutex.acquire().then(() => {
      secondAcquired = true;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    mutex.release(); // dequeues next waiter via internal `next` callback
    await pending;
    expect(secondAcquired).toBe(true);
    mutex.release();
  });

  it("run executes the critical section and returns its value", async () => {
    const mutex = new Mutex();
    const value = await mutex.run(async () => 42);
    expect(value).toBe(42);
  });

  it("run releases the lock even when the function throws", async () => {
    const mutex = new Mutex();
    await expect(
      mutex.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const value = await mutex.run(async () => "ok");
    expect(value).toBe("ok");
  });

  it("run serializes concurrent callers (FIFO)", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const a = mutex.run(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
      return "a";
    });
    const b = mutex.run(async () => {
      order.push(3);
      return "b";
    });

    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("ConfigError extends Error via super", () => {
    const err = new ConfigError("locked");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("locked");
  });
});
