/**
 * Derives local Ollama runtime tuning — `OLLAMA_NUM_PARALLEL`,
 * `OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE` — as env vars to pass
 * when this process spawns `ollama serve`.
 *
 * @remarks
 * **Why this exists.** `ollama/lifecycle.ts` used to spawn `ollama serve`
 * with no `env` at all, so Ollama never received `OLLAMA_FLASH_ATTENTION` or
 * `OLLAMA_KV_CACHE_TYPE` — two settings that are a free win on any backend.
 *
 * **Why `numParallel` is NOT derived from this machine's memory.** An
 * earlier version of this module estimated a "safe" parallel-slot count
 * from `os.totalmem()`. That is wrong on most hardware: total *system* RAM
 * is only a meaningful proxy for model-serving memory on unified-memory
 * systems (Apple Silicon, some integrated GPUs). On a Linux or Windows box
 * with a discrete GPU, system RAM and VRAM are two different pools of very
 * different sizes — a machine with 64 GB of RAM and a 12 GB GPU would get a
 * confidently wrong, too-high slot count from a RAM-based formula. Reading
 * real VRAM per platform would mean shelling out to vendor-specific tools
 * (`nvidia-smi`, `rocm-smi`, platform APIs) that may not even be installed.
 *
 * The actual fix is simpler: **don't guess at all.** Left unset, Ollama
 * performs its own hardware-aware detection through the CUDA/Metal/ROCm
 * APIs it already links against, and picks a parallel-slot count for the
 * real device it's running on — strictly better information than anything
 * this module could compute in Node. So `numParallel` here is `undefined`
 * unless the user sets one explicitly (`/set numParallel`); when
 * `undefined`, {@link tuningToEnv} omits `OLLAMA_NUM_PARALLEL` from the
 * spawn env entirely, letting Ollama's own default apply.
 *
 * `flashAttention`/`kvCacheType` don't have this problem — both are
 * unconditionally beneficial on every backend (real quality trade-off is
 * negligible for coding-agent use), so they get a fixed default with no
 * per-machine detection needed.
 */

import type { KvCacheType } from "../config/types.js";
import type { IConfigManager } from "../orchestration/interfaces.js";

export type { KvCacheType };

/** The three env-settable knobs this module derives. */
export type OllamaTuning = {
  /**
   * `OLLAMA_NUM_PARALLEL` — `undefined` unless the user set one explicitly.
   * Left unset, Ollama detects a value for the real device itself; see the
   * module remarks for why that beats any machine-memory-based guess this
   * module could make.
   */
  numParallel: number | undefined;
  /** `OLLAMA_FLASH_ATTENTION` — unconditionally beneficial where supported, harmless where not. */
  flashAttention: boolean;
  /** `OLLAMA_KV_CACHE_TYPE` — `"q8_0"` roughly halves KV-cache memory vs. `"f16"` for near-lossless quality. */
  kvCacheType: KvCacheType;
};

/** Explicit per-setting overrides — `undefined` means "use the default for this one". */
export type OllamaTuningOverrides = {
  numParallel?: number;
  flashAttention?: boolean;
  kvCacheType?: KvCacheType;
};

/**
 * Combines defaults with explicit overrides.
 *
 * @remarks
 * Pure function — no machine reads of any kind, which is the point: the
 * result depends only on what the user explicitly configured, so it's
 * identical on an 8 GB laptop, a unified-memory Mac, or a 128 GB
 * discrete-GPU workstation. See {@link resolveOllamaTuning} for the
 * config-reading wrapper.
 *
 * @param overrides - Explicit per-setting values from config; each
 *   `undefined` field falls back to the default described on
 *   {@link OllamaTuning}'s individual fields.
 */
export const deriveOllamaTuning = (
  overrides: OllamaTuningOverrides = {},
): OllamaTuning => ({
  numParallel: overrides.numParallel,
  flashAttention: overrides.flashAttention ?? true,
  kvCacheType: overrides.kvCacheType ?? "q8_0",
});

/**
 * Gathers explicit config overrides and returns the tuning to apply when
 * this process spawns `ollama serve`.
 *
 * @remarks
 * Reads config via `IConfigManager` — the same interface `agentTurn.ts`
 * already depends on — so this can be called from `server/index.ts` with
 * the same `ConfigManager` instance used everywhere else.
 *
 * @param config - Source of explicit overrides (`getNumParallel`,
 *   `getFlashAttention`, `getKvCacheType`).
 */
export const resolveOllamaTuning = async (
  config: IConfigManager,
): Promise<OllamaTuning> => {
  const [numParallel, flashAttention, kvCacheType] = await Promise.all([
    config.getNumParallel(),
    config.getFlashAttention(),
    config.getKvCacheType(),
  ]);
  return deriveOllamaTuning({ numParallel, flashAttention, kvCacheType });
};

/**
 * Renders a tuning as the env overlay for `spawn("ollama", ["serve"], { env })`.
 *
 * @remarks
 * `OLLAMA_NUM_PARALLEL` is **omitted** when `tuning.numParallel` is
 * `undefined` — this is what lets Ollama's own per-device detection run
 * (see module remarks). Values that are set are stringified per Ollama's
 * own env var contract: `OLLAMA_FLASH_ATTENTION` is `"1"`/`"0"` (not
 * `"true"`/`"false"`); `OLLAMA_NUM_PARALLEL`/`OLLAMA_KV_CACHE_TYPE` are
 * passed as-is.
 */
export const tuningToEnv = (tuning: OllamaTuning): Record<string, string> => ({
  ...(tuning.numParallel !== undefined
    ? { OLLAMA_NUM_PARALLEL: String(tuning.numParallel) }
    : {}),
  OLLAMA_FLASH_ATTENTION: tuning.flashAttention ? "1" : "0",
  OLLAMA_KV_CACHE_TYPE: tuning.kvCacheType,
});
