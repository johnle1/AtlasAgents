/**
 * Unit tests — server ollama/modelPlacement.ts
 *
 * describeModelPlacement and matchRunningModel are pure (no I/O), tested
 * directly. createModelPlacementReporter is tested against a fake
 * IOllamaAdminClient to cover dedup, scope isolation, and failure handling.
 *
 * Category checklist:
 * - Normal: gpu/partial/cpu classification, tag matching, one warning per new spill
 * - Boundary: the 99% GPU tolerance, size_vram > size, size: 0 shim, missing fields
 * - Error: listRunning() rejecting never throws into the caller
 */

import { describe, expect, it, vi } from "vitest";
import {
  createModelPlacementReporter,
  describeModelPlacement,
  formatSpillMessage,
  matchRunningModel,
} from "../../../../packages/server/src/ollama/modelPlacement.js";
import type { RunningModel } from "../../../../packages/server/src/ollama/types.js";
import type { IOllamaAdminClient } from "../../../../packages/server/src/orchestration/interfaces.js";

describe("describeModelPlacement", () => {
  it("classifies a fully GPU-resident model as gpu (normal)", () => {
    const result = describeModelPlacement({
      name: "gemma3:27b",
      size: 100,
      size_vram: 100,
    });
    expect(result).toEqual({ model: "gemma3:27b", kind: "gpu", gpuPercent: 100 });
  });

  it("classifies a split model as partial with the correct percentage (normal)", () => {
    const result = describeModelPlacement({
      name: "gemma3:27b",
      size: 100,
      size_vram: 52,
    });
    expect(result).toEqual({ model: "gemma3:27b", kind: "partial", gpuPercent: 52 });
  });

  it("classifies a model with zero VRAM as fully cpu (normal)", () => {
    const result = describeModelPlacement({
      name: "gemma3:27b",
      size: 100,
      size_vram: 0,
    });
    expect(result).toEqual({ model: "gemma3:27b", kind: "cpu", gpuPercent: 0 });
  });

  it("treats size_vram undefined as unknown, not cpu (normal)", () => {
    const result = describeModelPlacement({ name: "gemma3:27b", size: 100 });
    expect(result.kind).toBe("unknown");
    expect(result.gpuPercent).toBeNull();
  });

  it("treats the OpenAI-compatible shim's { size: 0 } as unknown, never cpu (normal — false-positive guard)", () => {
    // providers/openAiCompatibleAdmin.ts returns { name, size: 0 } with no
    // VRAM data at all for non-Ollama providers. If this classified as
    // "cpu" it would false-alarm on every OpenAI-compatible task.
    const result = describeModelPlacement({ name: "mistral-7b", size: 0 });
    expect(result.kind).toBe("unknown");
  });

  it("applies the 99% GPU-resident tolerance boundary (boundary)", () => {
    // Ollama's VRAM accounting can undershoot `size` by a few MB even for a
    // fully-resident model — without this tolerance every healthy model
    // would classify as "partial".
    const justUnder = describeModelPlacement({
      name: "m",
      size: 1000,
      size_vram: 989, // 98.9%
    });
    expect(justUnder.kind).toBe("partial");

    const atThreshold = describeModelPlacement({
      name: "m",
      size: 1000,
      size_vram: 990, // exactly 99%
    });
    expect(atThreshold.kind).toBe("gpu");
  });

  it("handles size_vram slightly exceeding size without producing a >100% or negative reading (boundary)", () => {
    const result = describeModelPlacement({
      name: "m",
      size: 100,
      size_vram: 105,
    });
    expect(result.kind).toBe("gpu");
    expect(result.gpuPercent).toBe(100);
  });

  it("treats a non-finite or zero size as unknown rather than dividing by zero (boundary)", () => {
    expect(describeModelPlacement({ name: "m", size: 0, size_vram: 0 }).kind).toBe(
      "unknown",
    );
    expect(
      describeModelPlacement({ name: "m", size: NaN, size_vram: 10 }).kind,
    ).toBe("unknown");
  });

  it("falls back to the model field when name is absent (boundary)", () => {
    const result = describeModelPlacement({
      model: "gemma3:27b-q4",
      size: 100,
      size_vram: 100,
    });
    expect(result.model).toBe("gemma3:27b-q4");
  });
});

describe("formatSpillMessage — exported for one-off callers (e.g. /set agent|subagent)", () => {
  it("gives the partial-spill remedy for a partial placement", () => {
    const message = formatSpillMessage({
      model: "qwen3:70b",
      kind: "partial",
      gpuPercent: 52,
    });
    expect(message).toContain("qwen3:70b");
    expect(message).toContain("52% on GPU");
    expect(message).toContain("Free VRAM");
  });

  it("gives the driver-hint remedy for a fully-cpu placement", () => {
    const message = formatSpillMessage({
      model: "llama3:8b",
      kind: "cpu",
      gpuPercent: 0,
    });
    expect(message).toContain("entirely on CPU");
  });
});

describe("matchRunningModel", () => {
  const running: RunningModel[] = [
    { name: "gemma3:27b", size: 100, size_vram: 100 },
    { model: "mistral-7b-instruct", size: 50, size_vram: 0 },
  ];

  it("matches on exact name (normal)", () => {
    expect(matchRunningModel(running, "gemma3:27b")?.name).toBe("gemma3:27b");
  });

  it("matches a bare model name against its :latest-tagged running entry (normal)", () => {
    const withLatest: RunningModel[] = [{ name: "gemma3:latest", size: 10, size_vram: 10 }];
    expect(matchRunningModel(withLatest, "gemma3")?.name).toBe("gemma3:latest");
  });

  it("falls back to the model field when name doesn't match (normal)", () => {
    expect(matchRunningModel(running, "mistral-7b-instruct")?.model).toBe(
      "mistral-7b-instruct",
    );
  });

  it("returns undefined when nothing matches (boundary — not yet loaded)", () => {
    expect(matchRunningModel(running, "llama3:8b")).toBeUndefined();
  });

  it("returns undefined for an empty running list (boundary)", () => {
    expect(matchRunningModel([], "gemma3:27b")).toBeUndefined();
  });
});

const fakeAdmin = (running: RunningModel[]): IOllamaAdminClient =>
  ({
    listRunning: async () => running,
  }) as unknown as IOllamaAdminClient;

const rejectingAdmin = (): IOllamaAdminClient =>
  ({
    listRunning: async () => {
      throw new Error("connection refused");
    },
  }) as unknown as IOllamaAdminClient;

const noopLog = () => ({ warn: vi.fn() });

describe("createModelPlacementReporter", () => {
  it("returns a warning for a spilled model (normal)", async () => {
    const admin = fakeAdmin([{ name: "gemma3:27b", size: 100, size_vram: 52 }]);
    const reporter = createModelPlacementReporter({ admin, log: noopLog() });

    const messages = await reporter.reportPlacement(["gemma3:27b"], "conn-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("gemma3:27b");
    expect(messages[0]).toContain("52%");
  });

  it("returns nothing for a fully GPU-resident model (normal)", async () => {
    const admin = fakeAdmin([{ name: "gemma3:27b", size: 100, size_vram: 100 }]);
    const reporter = createModelPlacementReporter({ admin, log: noopLog() });

    const messages = await reporter.reportPlacement(["gemma3:27b"], "conn-1");
    expect(messages).toEqual([]);
  });

  it("returns nothing for a model not yet loaded (normal — avoids false negative noise)", async () => {
    const admin = fakeAdmin([]);
    const reporter = createModelPlacementReporter({ admin, log: noopLog() });

    const messages = await reporter.reportPlacement(["gemma3:27b"], "conn-1");
    expect(messages).toEqual([]);
  });

  it("warns only once per model per scope across repeated calls (normal — dedup)", async () => {
    const admin = fakeAdmin([{ name: "gemma3:27b", size: 100, size_vram: 0 }]);
    const reporter = createModelPlacementReporter({ admin, log: noopLog() });

    const first = await reporter.reportPlacement(["gemma3:27b"], "conn-1");
    const second = await reporter.reportPlacement(["gemma3:27b"], "conn-1");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("warns independently per scope — a later connection isn't silently suppressed (boundary)", async () => {
    const admin = fakeAdmin([{ name: "gemma3:27b", size: 100, size_vram: 0 }]);
    const reporter = createModelPlacementReporter({ admin, log: noopLog() });

    const connA = await reporter.reportPlacement(["gemma3:27b"], "conn-A");
    const connB = await reporter.reportPlacement(["gemma3:27b"], "conn-B");
    expect(connA).toHaveLength(1);
    expect(connB).toHaveLength(1);
  });

  it("resolves an empty array immediately for an empty model list (boundary)", async () => {
    const admin = fakeAdmin([{ name: "gemma3:27b", size: 100, size_vram: 0 }]);
    const listRunning = vi.fn(admin.listRunning);
    const reporter = createModelPlacementReporter({
      admin: { listRunning } as unknown as IOllamaAdminClient,
      log: noopLog(),
    });

    const messages = await reporter.reportPlacement([], "conn-1");
    expect(messages).toEqual([]);
    expect(listRunning).not.toHaveBeenCalled();
  });

  it("never throws when listRunning() rejects — resolves [] instead (error)", async () => {
    const reporter = createModelPlacementReporter({
      admin: rejectingAdmin(),
      log: noopLog(),
    });

    await expect(
      reporter.reportPlacement(["gemma3:27b"], "conn-1"),
    ).resolves.toEqual([]);
  });

  it("checks all requested models in a single listRunning() call (normal — one round trip)", async () => {
    const admin = fakeAdmin([
      { name: "gemma3:27b", size: 100, size_vram: 0 },
      { name: "llama3:8b", size: 50, size_vram: 50 },
    ]);
    const listRunning = vi.fn(admin.listRunning);
    const reporter = createModelPlacementReporter({
      admin: { listRunning } as unknown as IOllamaAdminClient,
      log: noopLog(),
    });

    const messages = await reporter.reportPlacement(
      ["gemma3:27b", "llama3:8b"],
      "conn-1",
    );
    expect(listRunning).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1); // only the spilled one
  });

  it("forgetScope() lets a reused scope warn again (regression guard)", async () => {
    // warnedKeys used to be one process-lifetime Set keyed by
    // `${scope}|${model}|${kind}`, with no way to release a connection's
    // entries when it closed — an unbounded leak for a long-running server,
    // and the only reason the leak was fixable at all is this method.
    const admin = fakeAdmin([{ name: "gemma3:27b", size: 100, size_vram: 0 }]);
    const reporter = createModelPlacementReporter({ admin, log: noopLog() });

    const first = await reporter.reportPlacement(["gemma3:27b"], "conn-1");
    expect(first).toHaveLength(1);

    reporter.forgetScope("conn-1");

    const afterForget = await reporter.reportPlacement(["gemma3:27b"], "conn-1");
    expect(afterForget).toHaveLength(1);
  });

  it("forgetScope() only releases the named scope, leaving others deduped (boundary)", async () => {
    const admin = fakeAdmin([{ name: "gemma3:27b", size: 100, size_vram: 0 }]);
    const reporter = createModelPlacementReporter({ admin, log: noopLog() });

    await reporter.reportPlacement(["gemma3:27b"], "conn-A");
    await reporter.reportPlacement(["gemma3:27b"], "conn-B");

    reporter.forgetScope("conn-A");

    const afterForgetA = await reporter.reportPlacement(["gemma3:27b"], "conn-A");
    const stillDedupedB = await reporter.reportPlacement(["gemma3:27b"], "conn-B");
    expect(afterForgetA).toHaveLength(1);
    expect(stillDedupedB).toHaveLength(0);
  });

  it("forgetScope() on a scope that never warned is a harmless no-op (boundary)", async () => {
    const admin = fakeAdmin([{ name: "gemma3:27b", size: 100, size_vram: 0 }]);
    const reporter = createModelPlacementReporter({ admin, log: noopLog() });

    expect(() => reporter.forgetScope("never-connected")).not.toThrow();
  });
});
