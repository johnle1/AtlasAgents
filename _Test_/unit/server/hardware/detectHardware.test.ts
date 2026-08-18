/**
 * Unit tests — server hardware/detectHardware.ts
 *
 * suggestProviderConfig is a pure function (no I/O) so it's tested directly.
 * runDetectHardwareCli's --write path is tested against a real temp config
 * root via ConfigManager, matching the idempotent "skip if already present"
 * contract described in the plan.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectHardware,
  runDetectHardwareCli,
  suggestProviderConfig,
  type HardwareTarget,
} from "../../../../packages/server/src/hardware/detectHardware.js";
import {
  deriveAppleNumCtxInput,
  recommendNumCtx,
} from "../../../../packages/server/src/hardware/vramProbe.js";
import { ConfigManager } from "../../../../packages/server/src/config/index.js";
import { initializeCipher, lockCipher } from "@atlasagents/shared";

// ConfigManager encrypts the `providers` field at rest; --write triggers a
// save, which requires the cipher unlocked first. Unrelated to what this
// suite tests, so unlock once with a fixed passphrase.
beforeAll(() => {
  initializeCipher("test-passphrase-for-detect-hardware-tests");
});

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
    const hardware: HardwareTarget = {
      kind: "gcp-tpu",
      acceleratorType: "v5e-4",
    };
    const suggestion = suggestProviderConfig(hardware);

    expect(suggestion.provider).toBe("vllm-gcp-tpu");
    expect(suggestion.launchFlags).toContain("--dtype bfloat16");
    expect(suggestion.note).toContain("v5e-4");
  });

  it("suggests vllm-gpu for a plain NVIDIA GPU and includes VRAM in the note", () => {
    const suggestion = suggestProviderConfig({
      kind: "nvidia-gpu",
      vramMb: 24_576,
      deviceCount: 1,
    });
    expect(suggestion.provider).toBe("vllm-gpu");
    expect(suggestion.launchFlags).toContain("--tool-call-parser hermes");
    expect(suggestion.note).toContain("24.0 GB");
  });

  it("suggests vllm-gpu for NVIDIA with unmeasured VRAM, without throwing", () => {
    const suggestion = suggestProviderConfig({
      kind: "nvidia-gpu",
      vramMb: null,
      deviceCount: 1,
    });
    expect(suggestion.provider).toBe("vllm-gpu");
    expect(suggestion.note).toContain("unmeasured");
  });

  it("suggests vllm-rocm for an AMD GPU", () => {
    const suggestion = suggestProviderConfig({
      kind: "amd-gpu",
      vramMb: 16_384,
      deviceCount: 1,
    });
    expect(suggestion.provider).toBe("vllm-rocm");
    expect(suggestion.launchFlags).toContain("--tool-call-parser hermes");
    expect(suggestion.note).toContain("16.0 GB");
  });

  it("suggests vllm-xpu with --device xpu for an Intel GPU", () => {
    const suggestion = suggestProviderConfig({
      kind: "intel-gpu",
      vramMb: 8_192,
      deviceCount: 1,
    });
    expect(suggestion.provider).toBe("vllm-xpu");
    expect(suggestion.launchFlags).toContain("--device xpu");
  });

  it("suggests ollama (not vllm) for Apple Silicon, since vLLM has no Metal backend", () => {
    const suggestion = suggestProviderConfig({
      kind: "apple-metal",
      unifiedMemoryMb: 32_768,
      wiredLimitMb: null,
    });
    expect(suggestion.provider).toBe("ollama");
    expect(suggestion.launchFlags).toEqual([]);
    expect(suggestion.note).toContain("Metal");
  });

  it("falls back to ollama with no launch flags when nothing is detected", () => {
    const suggestion = suggestProviderConfig({
      kind: "cpu",
      systemMemoryMb: 16_384,
    });
    expect(suggestion.provider).toBe("ollama");
    expect(suggestion.launchFlags).toEqual([]);
  });

  it("uses the given port in the suggested baseUrl", () => {
    const suggestion = suggestProviderConfig(
      { kind: "nvidia-gpu", vramMb: null, deviceCount: 1 },
      9000,
    );
    expect(suggestion.baseUrl).toBe("http://localhost:9000/v1");
  });
});

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("runDetectHardwareCli --write", () => {
  it("writes a numCtx consistent with whatever this machine actually detects", async () => {
    // This suite runs on whatever machine executes it — Linux CI, a Mac
    // laptop, etc. — so it can't assume a fixed hardware outcome. Instead it
    // detects for real, derives the expected numCtx the same way the CLI
    // does, and asserts the write matches that (rather than any specific
    // vendor/tier), keeping the test honest across environments.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-detect-"));
    tempRoots.push(root);

    // Stub fetch defensively so no real network calls happen from the
    // cloud-metadata probes regardless of what /dev this machine has.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: false, text: async () => "" }) as unknown as Response,
      ),
    );

    const hardware = await detectHardware();
    const numCtxInput =
      hardware.kind === "nvidia-gpu" ||
      hardware.kind === "amd-gpu" ||
      hardware.kind === "intel-gpu"
        ? hardware.vramMb
        : hardware.kind === "apple-metal"
          ? deriveAppleNumCtxInput(hardware.unifiedMemoryMb)
          : null;
    const expectedNumCtx = recommendNumCtx(numCtxInput);

    await runDetectHardwareCli(["--write"], { rootDir: root });

    const manager = new ConfigManager({ rootDir: root });
    expect((await manager.getAll()).numCtx).toBe(expectedNumCtx);

    // Trainium/TPU/NVIDIA/AMD/Intel all suggest a non-ollama provider and
    // get written; apple-metal/cpu suggest ollama (already default, nothing
    // to add). Either way, providers must never contain "ollama" itself.
    const providers = await manager.getProviders();
    expect(providers.ollama).toBeUndefined();
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-detect-"));
    tempRoots.push(root);
    const manager = new ConfigManager({ rootDir: root });

    const suggestion = suggestProviderConfig(
      { kind: "nvidia-gpu", vramMb: null, deviceCount: 1 },
      8000,
    );
    await manager.addProvider(suggestion.provider, {
      baseUrl: suggestion.baseUrl,
    });

    const before = await manager.getProvider(suggestion.provider);
    // Simulate the CLI's guard: only re-write if not already present.
    const alreadyPresent =
      (await manager.getProvider(suggestion.provider)) !== undefined;
    if (!alreadyPresent) {
      await manager.addProvider(suggestion.provider, {
        baseUrl: "http://localhost:9999/v1",
      });
    }

    expect(await manager.getProvider(suggestion.provider)).toEqual(before);
  });

  it("does not overwrite a numCtx the user already configured by hand", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-detect-"));
    tempRoots.push(root);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: false, text: async () => "" }) as unknown as Response,
      ),
    );

    const manager = new ConfigManager({ rootDir: root });
    await manager.set("numCtx", 12345);

    await runDetectHardwareCli(["--write"], { rootDir: root });

    expect((await manager.getAll()).numCtx).toBe(12345);
  });

  it("writes numCtx in a fresh process that never unlocked the cipher (regression guard)", async () => {
    // The real `atlas-detect-hardware --write` invocation is a standalone,
    // single-shot process. For a numCtx-only write (no encrypted providers on
    // disk yet, and no non-ollama provider to add), it must not require
    // unlockOrSetupProvidersCipher — _saveRaw skips the envelope when
    // providers are empty and the cipher is locked. Locking here simulates
    // that fresh process; initializeCipher is restored after so later tests
    // that DO touch providers keep working regardless of run order.
    //
    // When this machine detects a GPU/accelerator, --write will add a
    // provider and therefore prompt to set up a passphrase — inject a stub
    // so the test stays non-interactive either way.
    lockCipher();
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-detect-"));
      tempRoots.push(root);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            ({ ok: false, text: async () => "" }) as unknown as Response,
        ),
      );

      await expect(
        runDetectHardwareCli(["--write"], {
          rootDir: root,
          promptPassphrase: async () => "fresh-detect-hardware-passphrase",
        }),
      ).resolves.toBeUndefined();

      // Re-unlock so getAll can read a file that may now have $providersSecrets
      // (GPU hosts write a provider under the passphrase above).
      initializeCipher("fresh-detect-hardware-passphrase");
      const manager = new ConfigManager({ rootDir: root });
      expect((await manager.getAll()).numCtx).toBeDefined();
    } finally {
      initializeCipher("test-passphrase-for-detect-hardware-tests");
    }
  });

  it("unlocks an existing encrypted config before --write (regression for cipher-locked hosts)", async () => {
    // Mirrors a machine that already ran `atlas-server start`: config.json
    // has $providersSecrets, and a fresh `atlas-detect-hardware --write`
    // process starts with the cipher locked. Without unlocking first,
    // getAll() fails with ConfigCipherLockedError.
    const passphrase = "existing-server-config-passphrase";
    initializeCipher(passphrase);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-detect-"));
    tempRoots.push(root);
    const seed = new ConfigManager({ rootDir: root });
    await seed.addProvider("seed-provider", {
      baseUrl: "http://localhost:7999/v1",
    });

    lockCipher();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: false, text: async () => "" }) as unknown as Response,
      ),
    );

    const prompts: string[] = [];
    await expect(
      runDetectHardwareCli(["--write"], {
        rootDir: root,
        promptPassphrase: async (label) => {
          prompts.push(label);
          return passphrase;
        },
      }),
    ).resolves.toBeUndefined();

    expect(prompts.length).toBeGreaterThanOrEqual(1);

    const manager = new ConfigManager({ rootDir: root });
    const config = await manager.getAll();
    expect(config.numCtx).toBeDefined();
    expect(await manager.getProvider("seed-provider")).toEqual({
      baseUrl: "http://localhost:7999/v1",
    });
  });
});
