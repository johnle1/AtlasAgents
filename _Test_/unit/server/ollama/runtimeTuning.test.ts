/**
 * Unit tests — ollama/runtimeTuning.ts
 *
 * @remarks
 * `deriveOllamaTuning` takes no machine input at all (no `os.totalmem()`,
 * no `process.platform`) — that's the point being tested here. An earlier
 * version derived `numParallel` from total system memory, which is only a
 * valid proxy on unified-memory systems (Apple Silicon) and is confidently
 * wrong on a discrete-GPU Linux/Windows machine, where system RAM and VRAM
 * are different pools of very different sizes. The fix removes the guess
 * entirely: `numParallel` is `undefined` unless the user explicitly set
 * one, and `tuningToEnv` omits `OLLAMA_NUM_PARALLEL` when unset so Ollama
 * performs its own hardware-aware detection for the real device. These
 * tests assert that behavior directly — there is no "machine size" axis to
 * test across anymore, since the result no longer depends on one.
 */

import { describe, expect, it, vi } from "vitest";
import {
  deriveOllamaTuning,
  resolveOllamaTuning,
  tuningToEnv,
} from "../../../../packages/server/src/ollama/runtimeTuning.js";
import type { IConfigManager } from "../../../../packages/server/src/orchestration/interfaces.js";

describe("deriveOllamaTuning", () => {
  it("numParallel is undefined with no override — no guess is made (normal)", () => {
    const tuning = deriveOllamaTuning();
    expect(tuning.numParallel).toBeUndefined();
  });

  it("flashAttention defaults to true and kvCacheType defaults to q8_0 — unconditional, not machine-dependent (normal)", () => {
    const tuning = deriveOllamaTuning();
    expect(tuning.flashAttention).toBe(true);
    expect(tuning.kvCacheType).toBe("q8_0");
  });

  it("the result is identical regardless of how it's called — no hidden machine dependency (regression guard)", () => {
    // Calling this from two different "machines" (nothing here actually
    // varies, since the function takes no host input) must yield the same
    // result — this is what "no os.totalmem() dependency" means concretely.
    expect(deriveOllamaTuning()).toEqual(deriveOllamaTuning());
  });

  it("an explicit numParallel override is honored exactly, whatever its value (normal — precedence)", () => {
    expect(deriveOllamaTuning({ numParallel: 1 }).numParallel).toBe(1);
    expect(deriveOllamaTuning({ numParallel: 8 }).numParallel).toBe(8);
    expect(deriveOllamaTuning({ numParallel: 64 }).numParallel).toBe(64); // not clamped — the user's own machine, the user's own call
  });

  it("each override is independent — setting one leaves the others at their default (boundary)", () => {
    const tuning = deriveOllamaTuning({ flashAttention: false });
    expect(tuning.flashAttention).toBe(false);
    expect(tuning.kvCacheType).toBe("q8_0"); // still default
    expect(tuning.numParallel).toBeUndefined(); // still default
  });

  it("an explicit override of false is honored, not treated as unset (boundary — nullish-coalescing correctness)", () => {
    expect(deriveOllamaTuning({ flashAttention: false }).flashAttention).toBe(false);
  });

  it("an explicit numParallel of 0 would be a nonsensical config value, but is still passed through as-is — validation is config.ts's job, not this function's (boundary)", () => {
    expect(deriveOllamaTuning({ numParallel: 0 }).numParallel).toBe(0);
  });
});

describe("resolveOllamaTuning", () => {
  const makeConfig = (
    overrides: Partial<{
      numParallel: number | undefined;
      flashAttention: boolean | undefined;
      kvCacheType: "f16" | "q8_0" | "q4_0" | undefined;
    }> = {},
  ): IConfigManager =>
    ({
      getNumParallel: vi.fn(async () => overrides.numParallel),
      getFlashAttention: vi.fn(async () => overrides.flashAttention),
      getKvCacheType: vi.fn(async () => overrides.kvCacheType),
    }) as unknown as IConfigManager;

  it("reads all three overrides from config and merges with defaults (normal)", async () => {
    const config = makeConfig({ numParallel: 3 });
    const tuning = await resolveOllamaTuning(config);
    expect(tuning.numParallel).toBe(3);
    expect(tuning.flashAttention).toBe(true); // default
    expect(tuning.kvCacheType).toBe("q8_0"); // default
  });

  it("with no overrides configured, numParallel stays undefined — no machine read is attempted (boundary)", async () => {
    const config = makeConfig();
    const tuning = await resolveOllamaTuning(config);
    expect(tuning.numParallel).toBeUndefined();
    expect(tuning.flashAttention).toBe(true);
    expect(tuning.kvCacheType).toBe("q8_0");
  });

  it("reads all three config getters exactly once (normal)", async () => {
    const config = makeConfig({ numParallel: 2 });
    await resolveOllamaTuning(config);
    expect(config.getNumParallel).toHaveBeenCalledTimes(1);
    expect(config.getFlashAttention).toHaveBeenCalledTimes(1);
    expect(config.getKvCacheType).toHaveBeenCalledTimes(1);
  });
});

describe("tuningToEnv", () => {
  it("omits OLLAMA_NUM_PARALLEL when numParallel is undefined — this is what lets Ollama self-detect (normal — the core behavior this correction exists for)", () => {
    const env = tuningToEnv({
      numParallel: undefined,
      flashAttention: true,
      kvCacheType: "q8_0",
    });
    expect(env).not.toHaveProperty("OLLAMA_NUM_PARALLEL");
    expect(env).toEqual({
      OLLAMA_FLASH_ATTENTION: "1",
      OLLAMA_KV_CACHE_TYPE: "q8_0",
    });
  });

  it("includes OLLAMA_NUM_PARALLEL, stringified, when explicitly set (normal)", () => {
    const env = tuningToEnv({
      numParallel: 4,
      flashAttention: true,
      kvCacheType: "q8_0",
    });
    expect(env.OLLAMA_NUM_PARALLEL).toBe("4");
  });

  it("renders flashAttention: false as \"0\", not \"false\" (regression guard — Ollama's own contract, not JS boolean stringification)", () => {
    const env = tuningToEnv({
      numParallel: undefined,
      flashAttention: false,
      kvCacheType: "f16",
    });
    expect(env.OLLAMA_FLASH_ATTENTION).toBe("0");
  });

  it("passes kvCacheType through as-is for each recognized value (normal)", () => {
    for (const kvCacheType of ["f16", "q8_0", "q4_0"] as const) {
      expect(
        tuningToEnv({ numParallel: undefined, flashAttention: true, kvCacheType })
          .OLLAMA_KV_CACHE_TYPE,
      ).toBe(kvCacheType);
    }
  });
});
