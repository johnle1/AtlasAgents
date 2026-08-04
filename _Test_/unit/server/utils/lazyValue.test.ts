/**
 * Unit tests — server utils/lazyValue.ts
 *
 * Category checklist:
 * - Normal: caches a resolved value, concurrent callers share one load
 * - Error: a rejected load is not memoized — the next get() retries
 * - Regression guard: invalidate() during an in-flight load discards that
 *   load's result instead of being reverted by it once it resolves
 */

import { describe, expect, it, vi } from "vitest";

import { createLazyValue } from "../../../../packages/server/src/utils/lazyValue.js";

describe("createLazyValue", () => {
  it("loads once and serves the cached value on later calls", async () => {
    const load = vi.fn(async () => "value");
    const lazy = createLazyValue(load);

    expect(await lazy.get()).toBe("value");
    expect(await lazy.get()).toBe("value");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight load across concurrent callers", async () => {
    let resolveLoad!: (value: string) => void;
    const load = vi.fn(
      () => new Promise<string>((resolve) => (resolveLoad = resolve)),
    );
    const lazy = createLazyValue(load);

    const first = lazy.get();
    const second = lazy.get();
    resolveLoad("value");

    expect(await first).toBe("value");
    expect(await second).toBe("value");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("peek() returns undefined before the first load and the value after", async () => {
    const lazy = createLazyValue(async () => "value");
    expect(lazy.peek()).toBeUndefined();
    await lazy.get();
    expect(lazy.peek()).toBe("value");
  });

  it("does not memoize a rejection — the next get() retries the loader (error)", async () => {
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient EACCES");
      }
      return "recovered";
    });
    const lazy = createLazyValue(load);

    await expect(lazy.get()).rejects.toThrow("transient EACCES");
    expect(await lazy.get()).toBe("recovered");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("propagates a rejection to every caller waiting on the same in-flight load (error)", async () => {
    let rejectLoad!: (error: Error) => void;
    const load = vi.fn(
      () => new Promise<string>((_resolve, reject) => (rejectLoad = reject)),
    );
    const lazy = createLazyValue(load);

    const first = lazy.get();
    const second = lazy.get();
    rejectLoad(new Error("boom"));

    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("invalidate() before any load simply causes the next get() to load (normal)", async () => {
    const load = vi.fn(async () => "value");
    const lazy = createLazyValue(load);

    lazy.invalidate();
    expect(await lazy.get()).toBe("value");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("invalidate() after a resolved load forces a rebuild on the next get() (normal)", async () => {
    let call = 0;
    const load = vi.fn(async () => {
      call += 1;
      return `value-${call}`;
    });
    const lazy = createLazyValue(load);

    expect(await lazy.get()).toBe("value-1");
    lazy.invalidate();
    expect(await lazy.get()).toBe("value-2");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("invalidate() during an in-flight load discards that load's result instead of being reverted by it (regression guard)", async () => {
    // This is the exact defect the review found in SkillManager: a build
    // already in flight when invalidate() fires would resolve afterward and
    // unconditionally overwrite the cache, silently reinstating stale data
    // with nothing left to invalidate it a second time.
    let resolveFirstLoad!: (value: string) => void;
    let loadCount = 0;
    const load = vi.fn(() => {
      loadCount += 1;
      if (loadCount === 1) {
        return new Promise<string>((resolve) => (resolveFirstLoad = resolve));
      }
      return Promise.resolve("rebuilt");
    });
    const lazy = createLazyValue(load);

    const firstGet = lazy.get();
    lazy.invalidate();
    resolveFirstLoad("stale");

    // The invalidated load still resolves normally for whoever awaited it...
    expect(await firstGet).toBe("stale");
    // ...but its result was never written to the cache, so the next get()
    // rebuilds rather than silently serving "stale" forever.
    expect(await lazy.get()).toBe("rebuilt");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a stale load resolving after a newer one has started does not orphan the newer load (regression guard)", async () => {
    // Load A starts; invalidate() clears `inFlight`; load B starts before A
    // resolves. When A's handler ran unconditionally clearing `inFlight`, it
    // nulled out B's still-pending promise instead of its own (already-null)
    // one — so a third get() call, arriving before B resolves, found
    // `inFlight === null` and kicked off a spurious load C, sharing nothing
    // with the load B every other concurrent caller was already waiting on.
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    let loadCount = 0;
    const load = vi.fn(() => {
      loadCount += 1;
      if (loadCount === 1) {
        return new Promise<string>((resolve) => (resolveA = resolve));
      }
      if (loadCount === 2) {
        return new Promise<string>((resolve) => (resolveB = resolve));
      }
      return Promise.resolve(`unexpected-load-${loadCount}`);
    });
    const lazy = createLazyValue(load);

    const getA = lazy.get(); // starts load A
    lazy.invalidate();
    const getB = lazy.get(); // starts load B — A is still pending
    resolveA("stale-from-A"); // A resolves after B has already started

    // A's stale resolution must not disturb B's in-flight state.
    expect(await getA).toBe("stale-from-A");
    const getC = lazy.get(); // must still share B, not start a third load
    resolveB("value-from-B");

    expect(await getB).toBe("value-from-B");
    expect(await getC).toBe("value-from-B");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("two invalidate() calls in a row still only require one rebuild (boundary)", async () => {
    const load = vi.fn(async () => "value");
    const lazy = createLazyValue(load);
    await lazy.get();

    lazy.invalidate();
    lazy.invalidate();
    expect(await lazy.get()).toBe("value");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
