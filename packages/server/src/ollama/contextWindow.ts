/**
 * Single source of truth for resolving a model's effective runtime context
 * window (`num_ctx`).
 *
 * @remarks
 * This value is used two ways that must never disagree: it's sent to Ollama
 * as `options.num_ctx` on every chat request, and it's the number
 * {@link ContextBuilder} budgets a fraction of when sizing the memory
 * header. Before this module existed, those were two separate numbers —
 * Ollama's runtime default (4096, since `num_ctx` was never sent) versus the
 * model's *trained* context length (often 128K+, queried via `showModel`)
 * — so the memory header was built to a size Ollama silently truncated.
 * `ContextWindowResolver.resolve()` is the only place either number comes
 * from, so they can't drift apart again.
 *
 * **Role-independence:** Ollama keys its loaded runner on `(model, num_ctx, …)`.
 * If two roles (agent vs. subagent) requested different `num_ctx` for the
 * *same* model tag, every switch between them would evict and reload the
 * model — worse than never setting `num_ctx` at all. `resolve()` therefore
 * takes only a model tag, never a role, so any two callers resolving the
 * same tag always get the same answer.
 */

import type {
  IConfigManager,
  IOllamaAdminClient,
} from "../orchestration/interfaces.js";
import { resolveContextLength } from "../memory/context/contextHelpers.js";

/** Ollama's own runtime default when `num_ctx` is never specified. */
export const OLLAMA_DEFAULT_NUM_CTX = 4096;

/** Floor for the effective context window, regardless of configuration. */
export const MIN_NUM_CTX = 4096;

/**
 * Pure clamp: the effective `num_ctx` to actually send, given what the model
 * was trained with and what the user (or hardware detection) configured.
 *
 * @remarks
 * No I/O, so it's trivially unit-testable. Configured value wins over the
 * floor; the model's trained context length is a hard ceiling — asking for
 * more than a model supports doesn't extend it, it just wastes VRAM (or
 * errors, depending on the model).
 *
 * @param params.trainedContextLength - The model's trained maximum, from
 *   `showModel()` metadata (via {@link resolveContextLength}).
 * @param params.configuredNumCtx - User/hardware-configured value, or
 *   `undefined` if never set.
 * @returns The `num_ctx` to send, always within `[MIN_NUM_CTX, trainedContextLength]`.
 *
 * @example
 * ```ts
 * resolveEffectiveNumCtx({ trainedContextLength: 131072, configuredNumCtx: 32768 });
 * // → 32768 — configured value fits under the trained ceiling
 *
 * resolveEffectiveNumCtx({ trainedContextLength: 4096, configuredNumCtx: 32768 });
 * // → 4096 — configured value exceeds what this specific model was trained with
 *
 * resolveEffectiveNumCtx({ trainedContextLength: 131072, configuredNumCtx: undefined });
 * // → 4096 — nothing configured, falls back to Ollama's own default
 *
 * resolveEffectiveNumCtx({ trainedContextLength: 2048, configuredNumCtx: undefined });
 * // → 2048 — the trained ceiling wins over the floor, never the other way round
 * ```
 */
export const resolveEffectiveNumCtx = (params: {
  trainedContextLength: number;
  configuredNumCtx: number | undefined;
}): number => {
  const requested = params.configuredNumCtx ?? OLLAMA_DEFAULT_NUM_CTX;
  // Floor first, ceiling last. Applying them the other way round let the
  // floor raise the result back above the trained length for any model
  // trained below MIN_NUM_CTX — exactly the over-request this function
  // exists to prevent, and a window ContextBuilder would then budget against.
  return Math.min(
    params.trainedContextLength,
    Math.max(MIN_NUM_CTX, requested),
  );
};

/**
 * Resolves and caches each model's effective `num_ctx`, querying Ollama at
 * most once per model tag.
 *
 * @remarks
 * Only the expensive part — the model's trained context length, from
 * `showModel()` — is cached per tag. The cheap clamp against the currently
 * configured `num_ctx` is recomputed on every call, so changing `numCtx` via
 * `/set` takes effect immediately without needing a separate cache-invalidation
 * hook (the same class of staleness bug this module exists to fix).
 *
 * @example
 * ```ts
 * const resolver = new ContextWindowResolver({ ollama: ollamaClient, config: configManager });
 * const numCtx = await resolver.resolve("gemma3:27b"); // queries showModel() once, then cached
 * ```
 */
export class ContextWindowResolver {
  private readonly trainedContextLengthCache = new Map<string, number>();

  constructor(
    private readonly deps: {
      ollama: IOllamaAdminClient;
      config: IConfigManager;
    },
  ) {}

  /**
   * Resolves the effective `num_ctx` for a model tag.
   *
   * @param modelTag - Ollama model tag (e.g. `"llama2"`, `"gemma3:27b"`).
   * @returns The `num_ctx` to send for this model, per {@link resolveEffectiveNumCtx}.
   *
   * @remarks
   * On a `showModel` failure (model not found, Ollama unreachable), there is
   * no known trained-length ceiling to clamp against — this returns the
   * configured value (or Ollama's own default), floored at `MIN_NUM_CTX`
   * like the normal path, rather than the unrelated `DEFAULT_CONTEXT_WINDOW`
   * fallback `ContextBuilder` used to use for a different purpose
   * (memory-budget sizing, not the wire value). The failure is not cached,
   * so a transient error can succeed on a later call.
   */
  resolve = async (modelTag: string): Promise<number> => {
    const configuredNumCtx = await this.deps.config.getNumCtx();

    let trainedContextLength = this.trainedContextLengthCache.get(modelTag);
    if (trainedContextLength === undefined) {
      try {
        const modelMetadata = await this.deps.ollama.showModel(modelTag);
        trainedContextLength = resolveContextLength(modelMetadata);
        this.trainedContextLengthCache.set(modelTag, trainedContextLength);
      } catch {
        // Same floor the normal path applies via resolveEffectiveNumCtx —
        // without it, a configured value below MIN_NUM_CTX (set()'s own
        // validation only requires a positive integer, not >= MIN_NUM_CTX)
        // would reach this return unclamped whenever showModel happens to
        // fail, inconsistent with what the same modelTag resolves to once
        // showModel succeeds.
        return Math.max(MIN_NUM_CTX, configuredNumCtx ?? OLLAMA_DEFAULT_NUM_CTX);
      }
    }

    return resolveEffectiveNumCtx({ trainedContextLength, configuredNumCtx });
  };

  /**
   * Invalidates cached trained-context-length lookups.
   *
   * @param modelTag - Optional model tag to invalidate. Omit to clear everything.
   *
   * @remarks
   * The cheap clamp against `configuredNumCtx` is never cached (see class
   * remarks), so this only matters after a model's own metadata changes
   * (rare — e.g. re-pulling a model tag under a different quantization).
   */
  clearCache = (modelTag?: string): void => {
    if (modelTag === undefined) {
      this.trainedContextLengthCache.clear();
      return;
    }
    this.trainedContextLengthCache.delete(modelTag);
  };
}
