/**
 * Unit tests — contextWindow resolver helpers.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ContextWindowResolver,
  MIN_NUM_CTX,
  OLLAMA_DEFAULT_NUM_CTX,
  resolveEffectiveNumCtx,
} from "../../../../packages/server/src/ollama/contextWindow.js";

describe("resolveEffectiveNumCtx", () => {
  it("uses configured value when under the trained ceiling", () => {
    expect(
      resolveEffectiveNumCtx({
        trainedContextLength: 131072,
        configuredNumCtx: 32768,
      }),
    ).toBe(32768);
  });

  it("clamps to the trained ceiling", () => {
    expect(
      resolveEffectiveNumCtx({
        trainedContextLength: 4096,
        configuredNumCtx: 32768,
      }),
    ).toBe(4096);
  });

  it("falls back to Ollama default when nothing is configured", () => {
    expect(
      resolveEffectiveNumCtx({
        trainedContextLength: 131072,
        configuredNumCtx: undefined,
      }),
    ).toBe(OLLAMA_DEFAULT_NUM_CTX);
  });

  it("raises a too-small request up to MIN_NUM_CTX when the trained ceiling allows it", () => {
    expect(
      resolveEffectiveNumCtx({
        trainedContextLength: 131072,
        configuredNumCtx: 1024,
      }),
    ).toBe(MIN_NUM_CTX);
  });

  it("never exceeds the trained ceiling, even when that ceiling is below MIN_NUM_CTX (regression guard)", () => {
    // Floor must apply before the ceiling, not after. Applying it after (the
    // original bug: Math.max(MIN, Math.min(requested, trained))) let the
    // floor raise the result back above a small trained length — e.g. an
    // older/small model trained at 2048 would get bumped to 4096, silently
    // exceeding what the model supports and sizing ContextBuilder's memory
    // header budget against a window the model can't honor.
    expect(
      resolveEffectiveNumCtx({
        trainedContextLength: 2048,
        configuredNumCtx: 1024,
      }),
    ).toBe(2048);
  });

  it("never exceeds a below-floor trained ceiling even with nothing configured", () => {
    expect(
      resolveEffectiveNumCtx({
        trainedContextLength: 2048,
        configuredNumCtx: undefined,
      }),
    ).toBe(2048);
  });
});

describe("ContextWindowResolver", () => {
  it("resolves via showModel + config and caches trained length", async () => {
    const showModel = vi.fn().mockResolvedValue({
      model_info: { "llama.context_length": 8192 },
    });
    const getNumCtx = vi.fn().mockResolvedValue(4096);
    const resolver = new ContextWindowResolver({
      ollama: { showModel } as never,
      config: { getNumCtx } as never,
    });

    await expect(resolver.resolve("m")).resolves.toBe(4096);
    await expect(resolver.resolve("m")).resolves.toBe(4096);
    expect(showModel).toHaveBeenCalledTimes(1);

    resolver.clearCache("m");
    await expect(resolver.resolve("m")).resolves.toBe(4096);
    expect(showModel).toHaveBeenCalledTimes(2);

    resolver.clearCache();
  });

  it("returns configured/default when showModel fails", async () => {
    const resolver = new ContextWindowResolver({
      ollama: {
        showModel: vi.fn().mockRejectedValue(new Error("missing")),
      } as never,
      config: { getNumCtx: vi.fn().mockResolvedValue(undefined) } as never,
    });
    await expect(resolver.resolve("missing")).resolves.toBe(
      OLLAMA_DEFAULT_NUM_CTX,
    );
  });

  it("floors a below-MIN_NUM_CTX configured value on the showModel-failure path too (regression guard)", async () => {
    // set() only requires numCtx to be a positive integer, not >= MIN_NUM_CTX
    // — the normal (showModel-succeeds) path floors it via
    // resolveEffectiveNumCtx, but the catch path used to return the
    // configured value straight through, unclamped. A model tag that
    // happens to hit a transient showModel failure would then resolve to a
    // different (too-low) num_ctx than the same tag resolves to once
    // showModel succeeds.
    const resolver = new ContextWindowResolver({
      ollama: {
        showModel: vi.fn().mockRejectedValue(new Error("unreachable")),
      } as never,
      config: { getNumCtx: vi.fn().mockResolvedValue(100) } as never,
    });
    await expect(resolver.resolve("m")).resolves.toBe(MIN_NUM_CTX);
  });
});
