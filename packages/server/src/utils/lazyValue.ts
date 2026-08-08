/**
 * Memoized async initialization: one shared in-flight load, a resident cached
 * result, and an invalidation that a concurrent load cannot silently undo.
 *
 * @remarks
 * Replaces the hand-rolled `cache` + `loadPromise` field pair that
 * `PreferenceStore` and `SkillManager` each grew independently. Both copies
 * had the same two defects, which this module fixes once:
 *
 * 1. **A rejected load was cached forever.** Storing the promise rather than
 *    the result means a rejection is memoized just as permanently as a
 *    success, so one transient `EACCES`/`EMFILE` on startup poisoned every
 *    later call for the lifetime of the process. Here the in-flight promise
 *    is cleared before the rejection propagates, so the next caller retries.
 * 2. **Invalidation during a build was reverted by that build.** The old code
 *    wrote `cache = result` unconditionally after awaiting, so a load that
 *    started before an `invalidate()` would resolve afterward and reinstate
 *    the stale value with nothing left to clear it. Here every load captures
 *    the generation it started in and only writes to the cache if that
 *    generation is still current.
 */

/**
 * A lazily-initialized value with a shared in-flight load.
 *
 * @typeParam T - The loaded value's type.
 */
export type LazyValue<T> = {
  /**
   * Returns the cached value, loading it on first use.
   *
   * @remarks
   * Concurrent callers arriving during a load share that single load rather
   * than each triggering their own. If the load rejects, the error propagates
   * to every current waiter and the next call starts a fresh attempt.
   */
  get: () => Promise<T>;

  /**
   * Drops the cached value so the next {@link LazyValue.get} reloads.
   *
   * @remarks
   * Safe to call while a load is in flight: that load still resolves normally
   * for whoever is awaiting it, but its result is discarded instead of being
   * written to the cache.
   */
  invalidate: () => void;

  /**
   * Returns the cached value without loading, or `undefined` when nothing is
   * cached yet. Useful for callers that can cheaply skip work when cold.
   */
  peek: () => T | undefined;
};

/**
 * Creates a {@link LazyValue} around an async loader.
 *
 * @param load - Produces the value. Called at most once per generation; any
 *   rejection is surfaced to callers and does not poison later attempts.
 * @returns A lazy handle over `load`'s result.
 *
 * @example
 * ```ts
 * const index = createLazyValue(() => buildIndexFromDisk());
 *
 * await index.get();   // builds
 * await index.get();   // cached
 * index.invalidate();
 * await index.get();   // rebuilds
 * ```
 */
export const createLazyValue = <T>(load: () => Promise<T>): LazyValue<T> => {
  let cached: { value: T } | null = null;
  let inFlight: Promise<T> | null = null;
  // Bumped by every invalidate(). A load writes to `cached` only if the
  // generation it started in is still current, so an invalidate() that lands
  // mid-load discards that load's result instead of being reverted by it.
  let generation = 0;

  const get = async (): Promise<T> => {
    if (cached) {
      return cached.value;
    }
    if (!inFlight) {
      const startedAt = generation;
      inFlight = load().then(
        (value) => {
          // Guard the `inFlight` clear too, not just the `cached` write. If
          // invalidate() fired mid-load, a later get() call already saw
          // `inFlight === null` and started its OWN load, reassigning
          // `inFlight` to that newer promise. An unconditional clear here
          // would null out that newer promise instead of this stale one —
          // still in flight but now unreachable from `get()` — so the next
          // caller starts a THIRD load rather than sharing the second.
          if (generation === startedAt) {
            cached = { value };
            inFlight = null;
          }
          return value;
        },
        (error: unknown) => {
          // Same guard as above, so a stale rejection can't clear a newer
          // load's in-flight promise either.
          if (generation === startedAt) {
            inFlight = null;
          }
          throw error;
        },
      );
    }
    return inFlight;
  };

  const invalidate = (): void => {
    cached = null;
    inFlight = null;
    generation += 1;
  };

  const peek = (): T | undefined => cached?.value;

  return { get, invalidate, peek };
};
