/**
 * Integration tests — configured num_ctx → wire value, and loaded-model
 * placement → spill warnings.
 *
 * @remarks
 * Two flows, both offline, fakes only at the outer boundaries:
 *
 *  A. A configured `numCtx` figure → config `getNumCtx()` → REAL
 *     `ContextWindowResolver` (fake `showModel` admin) → the exact `num_ctx`
 *     sent to Ollama.
 *
 *  B. `GET /api/ps` rows (fake `listRunning`) → REAL
 *     `createModelPlacementReporter` → the warning messages a client would
 *     surface, including per-connection dedup.
 *
 *  C. `GET /api/tags` JSON (stubbed `fetch`) → REAL `OllamaClient
 *     .listModelsDetailed` → the shared `ModelSummary` wire shape the
 *     `models.list` route forwards to clients verbatim.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContextWindowResolver,
  MIN_NUM_CTX,
  OLLAMA_DEFAULT_NUM_CTX,
} from "../../../packages/server/src/ollama/contextWindow.js";
import { createModelPlacementReporter } from "../../../packages/server/src/ollama/modelPlacement.js";
import { OllamaClient } from "../../../packages/server/src/ollama/client.js";
import type {
  IConfigManager,
  IOllamaAdminClient,
} from "../../../packages/server/src/orchestration/interfaces.js";
import type { RunningModel } from "../../../packages/server/src/ollama/types.js";
import type { ModelSummary } from "../../../packages/shared/src/index.js";

// ---------------------------------------------------------------------------
// A. A configured numCtx → resolved wire value
// ---------------------------------------------------------------------------

/** A config fake whose numCtx can be swapped mid-test (the `/set` case). */
const configWithNumCtx = (initial: number | undefined) => {
  const state = { numCtx: initial };
  return {
    state,
    config: {
      getNumCtx: async () => state.numCtx,
    } as unknown as IConfigManager,
  };
};

/** An admin fake whose showModel returns the given trained context length. */
const adminWithTrainedLength = (trainedContextLength: number) => {
  const showModel = vi.fn(async () => ({
    model_info: { "test.context_length": trainedContextLength },
  }));
  return {
    showModel,
    admin: { showModel } as unknown as IOllamaAdminClient,
  };
};

describe("numCtx chain — a large configured context window", () => {
  it("a 64K configured value flows to the wire unclamped under a larger trained ceiling", async () => {
    const configuredNumCtx = 65536;

    const { config } = configWithNumCtx(configuredNumCtx);
    const { admin, showModel } = adminWithTrainedLength(131072);
    const resolver = new ContextWindowResolver({ ollama: admin, config });

    // Configured 65536 fits under the 128K trained ceiling.
    await expect(resolver.resolve("gemma3:27b")).resolves.toBe(65536);
  });
});

describe("numCtx chain — configured value exceeding the model's trained ceiling", () => {
  it("32768 configured against an 8K-trained model clamps down to the trained ceiling", async () => {
    const configuredNumCtx = 32768;

    const { config } = configWithNumCtx(configuredNumCtx);
    // A small model trained at 8K: the trained length is a hard ceiling.
    const { admin } = adminWithTrainedLength(8192);
    const resolver = new ContextWindowResolver({ ollama: admin, config });

    await expect(resolver.resolve("mistral:7b")).resolves.toBe(8192);
  });
});

describe("numCtx chain — no configured value (never-throw path)", () => {
  it("falls back to the conservative default end to end", async () => {
    // And when detection never wrote a config value at all (getNumCtx →
    // undefined), the resolver still lands on Ollama's own default, floored
    // at MIN_NUM_CTX — never a wild number from a failed probe.
    const { config } = configWithNumCtx(undefined);
    const { admin } = adminWithTrainedLength(131072);
    const resolver = new ContextWindowResolver({ ollama: admin, config });

    const resolved = await resolver.resolve("gemma3:27b");
    expect(resolved).toBe(OLLAMA_DEFAULT_NUM_CTX);
    expect(resolved).toBe(MIN_NUM_CTX);
  });

  it("an unreachable showModel returns the configured value unclamped", async () => {
    const { config } = configWithNumCtx(65536);
    const admin = {
      showModel: vi.fn(async () => {
        throw new Error("model not found");
      }),
    } as unknown as IOllamaAdminClient;
    const resolver = new ContextWindowResolver({ ollama: admin, config });

    await expect(resolver.resolve("missing:model")).resolves.toBe(65536);
  });
});

describe("ContextWindowResolver — cross-layer caching contract", () => {
  it("queries showModel once per tag but re-applies /set numCtx immediately", async () => {
    const { config, state } = configWithNumCtx(8192);
    const { admin, showModel } = adminWithTrainedLength(131072);
    const resolver = new ContextWindowResolver({ ollama: admin, config });

    await expect(resolver.resolve("gemma3:27b")).resolves.toBe(8192);

    // User runs /set numCtx 32768 — no cache invalidation needed.
    state.numCtx = 32768;
    await expect(resolver.resolve("gemma3:27b")).resolves.toBe(32768);

    // The expensive trained-length lookup happened exactly once.
    expect(showModel).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// B. Loaded-model placement → spill warnings
// ---------------------------------------------------------------------------

const silentLog = { warn: vi.fn() };

const reporterWithRunning = (running: RunningModel[]) =>
  createModelPlacementReporter({
    admin: { listRunning: async () => running } as unknown as IOllamaAdminClient,
    log: silentLog,
  });

describe("placement → warnings — the /api/ps matrix", () => {
  const running: RunningModel[] = [
    // Healthy: fully VRAM-resident.
    { name: "gemma3:27b", size: 100, size_vram: 100 },
    // Spilled: 52% resident — the classic too-big-for-VRAM split.
    { name: "qwen3:70b", size: 100, size_vram: 52 },
    // No usable GPU at all.
    { name: "llama3:8b", size: 100, size_vram: 0 },
    // OpenAI-compatible shim row: no VRAM data — must never false-alarm.
    { name: "mistral-7b", size: 0 },
  ];

  it("warns only for partial and cpu placements, with the right percentages", async () => {
    const reporter = reporterWithRunning(running);
    const warnings = await reporter.reportPlacement(
      ["gemma3:27b", "qwen3:70b", "llama3:8b", "mistral-7b"],
      "session-1",
    );

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("qwen3:70b");
    expect(warnings[0]).toContain("52% on GPU");
    expect(warnings[1]).toContain("llama3:8b");
    expect(warnings[1]).toContain("entirely on CPU");
    // On macOS the CPU hint points at the wired-limit knob.
    if (process.platform === "darwin") {
      expect(warnings[1]).toContain("iogpu.wired_limit_mb");
    }
  });

  it("matches a bare config name against the :latest running tag", async () => {
    const reporter = reporterWithRunning([
      { name: "qwen3:70b:latest", size: 100, size_vram: 52 },
    ]);
    const warnings = await reporter.reportPlacement(["qwen3:70b"], "s");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("52%");
  });

  it("silently skips models that are not loaded yet", async () => {
    const reporter = reporterWithRunning(running);
    await expect(
      reporter.reportPlacement(["not-loaded:model"], "s"),
    ).resolves.toEqual([]);
  });

  it("dedups per connection scope, not globally", async () => {
    const reporter = reporterWithRunning(running);

    const first = await reporter.reportPlacement(["qwen3:70b"], "session-1");
    const repeat = await reporter.reportPlacement(["qwen3:70b"], "session-1");
    const otherClient = await reporter.reportPlacement(["qwen3:70b"], "session-2");

    expect(first).toHaveLength(1);
    // Same connection never sees the same warning twice…
    expect(repeat).toEqual([]);
    // …but a client that connects later still gets told once.
    expect(otherClient).toHaveLength(1);
  });

  it("never throws when /api/ps is unreachable — resolves [] instead", async () => {
    const reporter = createModelPlacementReporter({
      admin: {
        listRunning: async () => {
          throw new Error("connection refused");
        },
      } as unknown as IOllamaAdminClient,
      log: silentLog,
    });

    await expect(
      reporter.reportPlacement(["gemma3:27b"], "s"),
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B2. The two-checks-per-task pattern from orchestratorPipeline.ts: the
// subagent model isn't loaded when the first (agent) check runs, but is by
// the time the second (post-pool) check runs.
// ---------------------------------------------------------------------------

describe("placement → warnings — two checks per task (agent then subagent)", () => {
  it("reports nothing for the subagent on the first check, then reports its spill on the second", async () => {
    // Mirrors runOrchestratorPipeline: /api/ps only reflects the agent model
    // until the subagent pool has actually run at least one turn.
    let running: RunningModel[] = [{ name: "gemma3:27b", size: 100, size_vram: 100 }];
    const reporter = createModelPlacementReporter({
      admin: { listRunning: async () => running } as unknown as IOllamaAdminClient,
      log: silentLog,
    });

    const firstCheck = await reporter.reportPlacement(
      ["gemma3:27b", "qwen3:70b"],
      "session-1",
    );
    expect(firstCheck).toEqual([]);

    // Subagent has now run — Ollama reports it, spilling.
    running = [
      { name: "gemma3:27b", size: 100, size_vram: 100 },
      { name: "qwen3:70b", size: 100, size_vram: 52 },
    ];
    const secondCheck = await reporter.reportPlacement(
      ["gemma3:27b", "qwen3:70b"],
      "session-1",
    );
    expect(secondCheck).toHaveLength(1);
    expect(secondCheck[0]).toContain("qwen3:70b");
  });

  it("warns once, not twice, when agent and subagent share one spilling model tag", async () => {
    // The recommended low-VRAM setup: /set agent and /set subagent both
    // pointed at the same tag. Both pipeline checks pass the same target
    // list; per-scope dedup must collapse them to a single warning.
    const running: RunningModel[] = [
      { name: "gemma3:12b", size: 100, size_vram: 60 },
    ];
    const reporter = createModelPlacementReporter({
      admin: { listRunning: async () => running } as unknown as IOllamaAdminClient,
      log: silentLog,
    });

    const firstCheck = await reporter.reportPlacement(
      ["gemma3:12b", "gemma3:12b"],
      "session-1",
    );
    const secondCheck = await reporter.reportPlacement(
      ["gemma3:12b", "gemma3:12b"],
      "session-1",
    );

    expect(firstCheck).toHaveLength(1);
    expect(secondCheck).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. /api/tags JSON → ModelSummary wire shape
// ---------------------------------------------------------------------------

// OllamaClient fetches via undici (not global fetch), so stub at that module.
const mockFetch = vi.hoisted(() => vi.fn());
const MockAgent = vi.hoisted(
  () =>
    class {
      constructor(public opts: unknown) {}
    },
);
vi.mock("undici", () => ({
  Agent: MockAgent,
  fetch: (...args: unknown[]) => mockFetch(...args),
}));

const tagsResponse = (models: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ models }),
});

describe("models.list — ModelSummary shape reaching the client", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("maps /api/tags rows onto the shared ModelSummary wire shape", async () => {
    mockFetch.mockResolvedValue(
      tagsResponse([
        {
          name: "gemma3:27b",
          size: 17_200_000_000,
          digest: "sha256:abc",
          modified_at: "2025-01-15T10:30:00Z",
          details: {
            family: "Gemma",
            parameter_size: "27B",
            quantization_level: "Q4_K_M",
            format: "GGUF",
          },
        },
        // A row with no usable name must be dropped, not forwarded — the
        // client renders every entry it receives.
        { size: 1234 },
      ]),
    );

    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    const models = await client.listModelsDetailed();

    // Compile-time: the return type IS the shared ModelSummary[].
    const summaries: ModelSummary[] = models;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      name: "gemma3:27b",
      size: 17_200_000_000,
      digest: "sha256:abc",
      modified_at: "2025-01-15T10:30:00Z",
      details: {
        family: "Gemma",
        parameter_size: "27B",
        quantization_level: "Q4_K_M",
        format: "GGUF",
      },
    });
  });
});
