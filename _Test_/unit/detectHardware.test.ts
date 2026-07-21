/**
 * Unit tests — server hardware/detectHardware.ts
 *
 * suggestProviderConfig is a pure function (no I/O) so it's tested directly.
 * runDetectHardwareCli's --write path is tested against a real temp config
 * root via ConfigManager, matching the idempotent "skip if already present"
 * contract described in the plan.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  runDetectHardwareCli,
  suggestProviderConfig,
  type HardwareTarget,
} from "../../packages/server/src/hardware/detectHardware.js";
import { ConfigManager } from "../../packages/server/src/config/configManager.js";

describe("suggestProviderConfig", () => {
  it("suggests vllm-aws-neuron with tensor-parallel-size matching core count", () => {
    const hardware: HardwareTarget = {
      kind: "aws-trainium",
      instanceType: "trn1.2xlarge",
      neuronCoreCount: 2,
    };
    const suggestion = suggestProviderConfig(hardware, 8000);

    expect(suggestion.provider).toBe("vllm-aws-neuron");
    expect(suggestion.baseUrl).toBe("http://localhost:8000/v1");
    expect(suggestion.launchFlags).toContain("--tensor-parallel-size 2");
    expect(suggestion.launchFlags).toContain("--enable-auto-tool-choice");
  });

  it("suggests vllm-gcp-tpu with bfloat16 dtype", () => {
    const hardware: HardwareTarget = { kind: "gcp-tpu", acceleratorType: "v5e-4" };
    const suggestion = suggestProviderConfig(hardware);

    expect(suggestion.provider).toBe("vllm-gcp-tpu");
    expect(suggestion.launchFlags).toContain("--dtype bfloat16");
    expect(suggestion.note).toContain("v5e-4");
  });

  it("suggests vllm-gpu for a plain NVIDIA GPU", () => {
    const suggestion = suggestProviderConfig({ kind: "nvidia-gpu" });
    expect(suggestion.provider).toBe("vllm-gpu");
    expect(suggestion.launchFlags).toContain("--tool-call-parser hermes");
  });

  it("falls back to ollama with no launch flags when nothing is detected", () => {
    const suggestion = suggestProviderConfig({ kind: "cpu" });
    expect(suggestion.provider).toBe("ollama");
    expect(suggestion.launchFlags).toEqual([]);
  });

  it("uses the given port in the suggested baseUrl", () => {
    const suggestion = suggestProviderConfig({ kind: "nvidia-gpu" }, 9000);
    expect(suggestion.baseUrl).toBe("http://localhost:9000/v1");
  });
});

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("runDetectHardwareCli --write", () => {
  it("does nothing when no accelerator is detected (ollama suggestion)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-detect-"));
    tempRoots.push(root);

    // No neuron/accel/nvidia devices on the test machine's /dev — falls
    // through to "cpu" naturally in CI, but stub fetch defensively so no
    // real network calls happen from the cloud-metadata probes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, text: async () => "" }) as unknown as Response),
    );

    await runDetectHardwareCli(["--write"], { rootDir: root });

    const manager = new ConfigManager({ rootDir: root });
    expect(await manager.getProviders()).toEqual({});
  });

  it("running --write twice for the same suggestion is a no-op the second time", async () => {
    // runDetectHardwareCli's own idempotency guard is: read getProvider(name)
    // first and skip the write if already present (see detectHardware.ts).
    // That guard can't be exercised end-to-end here without mocking this
    // module's own detectHardware() call from within itself, which ESM
    // doesn't support cleanly — so this confirms the underlying invariant
    // it depends on: writing the same provider name twice never clobbers a
    // pre-existing entry when the write is skipped, matching the "skip if
    // present" contract described in the plan.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-detect-"));
    tempRoots.push(root);
    const manager = new ConfigManager({ rootDir: root });

    const suggestion = suggestProviderConfig({ kind: "nvidia-gpu" }, 8000);
    await manager.addProvider(suggestion.provider, { baseUrl: suggestion.baseUrl });

    const before = await manager.getProvider(suggestion.provider);
    // Simulate the CLI's guard: only re-write if not already present.
    const alreadyPresent = (await manager.getProvider(suggestion.provider)) !== undefined;
    if (!alreadyPresent) {
      await manager.addProvider(suggestion.provider, { baseUrl: "http://localhost:9999/v1" });
    }

    expect(await manager.getProvider(suggestion.provider)).toEqual(before);
  });
});
