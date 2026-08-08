#!/usr/bin/env node

/**
 * Detects local accelerator hardware and suggests a provider config for it.
 *
 * @remarks
 * Run this ON the machine that will host `vllm serve` (or Ollama), not from
 * wherever the LoopyCode client normally runs. It has no way to see hardware
 * on a remote box over HTTP — detection only makes sense locally, at launch
 * time.
 *
 * **This module is CLI-only by design.** Nothing in the running server
 * imports it, and it must stay that way — hardware probing (spawning
 * `nvidia-smi`/`rocm-smi`/`sysctl`, reading `/dev` and `/sys`, querying cloud
 * metadata endpoints) is invasive enough that it should only ever happen as
 * a deliberate, user-triggered action, never silently on every server boot.
 * `numCtx` (Ollama's runtime context window) is sized from detected VRAM and
 * persisted to config via `--write`; the server itself only ever reads that
 * config value, the same as any other setting.
 *
 * AWS Trainium and Google TPU are both served through vLLM, which speaks the
 * same OpenAI-compatible protocol as every other provider in this codebase
 * (see {@link OpenAiCompatibleAdapter}). Apple Silicon has no vLLM backend
 * and always routes to Ollama instead.
 *
 * Usage:
 * ```sh
 * node dist/hardware/detectHardware.js               # print only
 * node dist/hardware/detectHardware.js --write        # also add the suggested provider + numCtx to config
 * node dist/hardware/detectHardware.js --write --port 9000
 * ```
 *
 * `--write` may prompt for the server config passphrase when
 * `user-data/config.json` already has encrypted `$providersSecrets` (after a
 * normal `loopy-server start`), or when adding a non-ollama provider that must
 * be stored encrypted.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ConfigManager } from "../config/index.js";
import { parseStoredConfig } from "../config/parsing.js";
import { CONFIG_REL_PATH } from "../config/types.js";
import { readPasswordAtStartup } from "../server/startupPrompts.js";
import {
  deriveAppleNumCtxInput,
  probeAmdVram,
  probeAppleUnifiedMemory,
  probeAppleWiredLimit,
  probeIntelVram,
  probeNvidiaVram,
  probeSystemMemory,
  recommendNumCtx,
} from "./vramProbe.js";

/** One detected hardware target, with enough detail to name and launch a provider for it. */
export type HardwareTarget =
  | { kind: "aws-trainium"; instanceType: string; neuronCoreCount: number }
  | { kind: "gcp-tpu"; acceleratorType: string }
  | { kind: "nvidia-gpu"; vramMb: number | null; deviceCount: number }
  | { kind: "amd-gpu"; vramMb: number | null; deviceCount: number }
  | { kind: "intel-gpu"; vramMb: number | null; deviceCount: number }
  | {
      kind: "apple-metal";
      unifiedMemoryMb: number | null;
      /**
       * macOS's Metal GPU-wired-memory ceiling (MB), from
       * `iogpu.wired_limit_mb` — see {@link probeAppleWiredLimit}. `null`
       * means unset (the macOS default of roughly ⅔ of RAM applies).
       */
      wiredLimitMb: number | null;
    }
  | { kind: "cpu"; systemMemoryMb: number };

/** A suggested provider entry plus the `vllm serve` flags to launch it with. */
export type ProviderSuggestion = {
  provider: string;
  baseUrl: string;
  launchFlags: string[];
  note: string;
};

const FETCH_TIMEOUT_MS = 1500;

/** PCI vendor IDs as reported by each render node's sysfs `device/vendor` file. */
const PCI_VENDOR_INTEL = "0x8086";

/**
 * GETs a URL with a short timeout, returning null (never throwing) on any
 * failure — used for optional cloud-metadata lookups that are expected to
 * fail on most machines (not every box is an EC2/GCE instance).
 */
const fetchWithTimeout = async (
  url: string,
  headers: Record<string, string> = {},
): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    // Not on this cloud, or metadata server unreachable — expected on most machines.
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const listDevMatching = (prefix: string): string[] => {
  try {
    return readdirSync("/dev").filter((entry) => entry.startsWith(prefix));
  } catch {
    return [];
  }
};

// ===== Device-file checks (fast, no network, work offline) =====

const detectNeuronDevices = (): string[] => listDevMatching("neuron");
const detectAccelDevices = (): string[] => listDevMatching("accel");
const detectNvidiaDevices = (): string[] => {
  // Only /dev/nvidia<N> nodes are actual GPUs. The driver also creates
  // control nodes in the same namespace (nvidiactl, nvidia-modeset,
  // nvidia-uvm, nvidia-uvm-tools) — counting those inflates a single-GPU
  // box to a reported "5 devices".
  const devices = listDevMatching("nvidia").filter((entry) =>
    /^nvidia\d+$/.test(entry),
  );
  return existsSync("/dev/nvidia0") && devices.length === 0
    ? ["nvidia0"]
    : devices;
};
const detectAmdKfd = (): boolean => existsSync("/dev/kfd");
const detectAppleSilicon = (): boolean =>
  process.platform === "darwin" && process.arch === "arm64";

/**
 * Reads the PCI vendor ID for every `/dev/dri/renderD*` device.
 *
 * @remarks
 * Nearly every Linux box with any graphics (including NVIDIA boxes running
 * nouveau) exposes `renderD*`, so this alone never identifies a vendor. It
 * only runs *after* the NVIDIA and AMD device-file checks have already
 * failed, and exists solely to confirm Intel via the PCI vendor ID
 * (`0x8086`) rather than assuming it from device-file presence.
 */
const detectIntelRenderNodes = (): string[] => {
  try {
    const renderNodes = readdirSync("/dev/dri").filter((entry) =>
      entry.startsWith("renderD"),
    );
    return renderNodes.filter((node) => {
      try {
        const vendor = readFileSync(
          `/sys/class/drm/${node}/device/vendor`,
          "utf-8",
        ).trim();
        return vendor.toLowerCase() === PCI_VENDOR_INTEL;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
};

// ===== Cloud metadata checks (optional, just for nicer logging) =====

/**
 * Simplified IMDSv1 GET for brevity. If your AMI enforces IMDSv2-only,
 * swap this for the token PUT + header GET flow.
 */
const detectAwsInstanceType = async (): Promise<string | null> =>
  fetchWithTimeout("http://169.254.169.254/latest/meta-data/instance-type");

const detectGcpAcceleratorType = async (): Promise<string | null> =>
  fetchWithTimeout(
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/accelerator-type",
    { "Metadata-Flavor": "Google" },
  );

/**
 * Detects the local accelerator, preferring device-file checks (fast,
 * offline-safe) and falling back to "cpu" when nothing is found.
 *
 * @remarks
 * Detection order matters because vendors share device nodes:
 * 1. `/dev/neuron*` → AWS Trainium
 * 2. `/dev/accel*` → GCP TPU
 * 3. `/dev/nvidia*` → NVIDIA
 * 4. `/dev/kfd` → AMD (must precede the Intel check — AMD also exposes `renderD*`)
 * 5. darwin+arm64 → Apple Silicon
 * 6. `/dev/dri/renderD*` with PCI vendor `0x8086` → Intel
 * 7. → CPU
 *
 * CLI-only — see the module-level remarks. Never call this from server
 * startup code.
 */
export const detectHardware = async (): Promise<HardwareTarget> => {
  const neuronDevices = detectNeuronDevices();
  if (neuronDevices.length > 0) {
    const instanceType =
      (await detectAwsInstanceType()) ?? "unknown-trainium-instance";
    return {
      kind: "aws-trainium",
      instanceType,
      neuronCoreCount: neuronDevices.length,
    };
  }

  const accelDevices = detectAccelDevices();
  if (accelDevices.length > 0) {
    const acceleratorType = (await detectGcpAcceleratorType()) ?? "unknown-tpu";
    return { kind: "gcp-tpu", acceleratorType };
  }

  const nvidiaDevices = detectNvidiaDevices();
  if (nvidiaDevices.length > 0) {
    const vramMb = await probeNvidiaVram();
    return { kind: "nvidia-gpu", vramMb, deviceCount: nvidiaDevices.length };
  }

  if (detectAmdKfd()) {
    const vramMb = await probeAmdVram();
    // /dev/kfd is a single compute-dispatch node shared by all AMD GPUs, so
    // it can't report a device count the way /dev/nvidia* can — report 1
    // rather than guessing.
    return { kind: "amd-gpu", vramMb, deviceCount: 1 };
  }

  if (detectAppleSilicon()) {
    const unifiedMemoryMb = await probeAppleUnifiedMemory();
    const wiredLimitMb = await probeAppleWiredLimit();
    return { kind: "apple-metal", unifiedMemoryMb, wiredLimitMb };
  }

  const intelRenderNodes = detectIntelRenderNodes();
  if (intelRenderNodes.length > 0) {
    const vramMb = await probeIntelVram();
    return { kind: "intel-gpu", vramMb, deviceCount: intelRenderNodes.length };
  }

  return { kind: "cpu", systemMemoryMb: probeSystemMemory() };
};

/**
 * Turns a detected hardware target into an actionable provider entry: a
 * name, the `baseUrl` a `vllm serve ... --port <port>` process on this host
 * would expose, and the launch flags to use.
 */
export const suggestProviderConfig = (
  hardware: HardwareTarget,
  port = 8000,
): ProviderSuggestion => {
  const baseUrl = `http://localhost:${port}/v1`;

  switch (hardware.kind) {
    case "aws-trainium":
      return {
        provider: "vllm-aws-neuron",
        baseUrl,
        launchFlags: [
          `--tensor-parallel-size ${hardware.neuronCoreCount}`,
          "--enable-auto-tool-choice",
          "--tool-call-parser llama3_json",
        ],
        note: `Detected ${hardware.neuronCoreCount} Neuron device(s) on instance type ${hardware.instanceType}`,
      };
    case "gcp-tpu":
      return {
        provider: "vllm-gcp-tpu",
        baseUrl,
        launchFlags: [
          "--tensor-parallel-size 1",
          "--dtype bfloat16",
          "--enable-auto-tool-choice",
          "--tool-call-parser llama3_json",
        ],
        note: `Detected TPU accelerator type: ${hardware.acceleratorType} (expect a 20-30min first-request compile delay)`,
      };
    case "nvidia-gpu":
      return {
        provider: "vllm-gpu",
        baseUrl,
        launchFlags: ["--enable-auto-tool-choice", "--tool-call-parser hermes"],
        note:
          hardware.vramMb !== null
            ? `Detected NVIDIA GPU (${(hardware.vramMb / 1024).toFixed(1)} GB VRAM) — standard vLLM path`
            : "Detected NVIDIA GPU (VRAM unmeasured — install nvidia-smi for sizing) — standard vLLM path",
      };
    case "amd-gpu":
      return {
        provider: "vllm-rocm",
        baseUrl,
        launchFlags: ["--enable-auto-tool-choice", "--tool-call-parser hermes"],
        note:
          hardware.vramMb !== null
            ? `Detected AMD GPU (${(hardware.vramMb / 1024).toFixed(1)} GB VRAM) — vLLM ROCm path`
            : "Detected AMD GPU (VRAM unmeasured) — vLLM ROCm path",
      };
    case "intel-gpu":
      return {
        provider: "vllm-xpu",
        baseUrl,
        launchFlags: [
          "--device xpu",
          "--enable-auto-tool-choice",
          "--tool-call-parser hermes",
        ],
        note:
          hardware.vramMb !== null
            ? `Detected Intel GPU (${(hardware.vramMb / 1024).toFixed(1)} GB VRAM) — vLLM XPU path`
            : "Detected Intel GPU (VRAM unmeasured) — vLLM XPU path",
      };
    case "apple-metal":
      return {
        provider: "ollama",
        baseUrl: "",
        launchFlags: [],
        note:
          hardware.unifiedMemoryMb !== null
            ? `Detected Apple Silicon (${(hardware.unifiedMemoryMb / 1024).toFixed(1)} GB unified memory) — vLLM has no Metal backend, using Ollama`
            : "Detected Apple Silicon — vLLM has no Metal backend, using Ollama",
      };
    case "cpu":
      return {
        provider: "ollama",
        baseUrl: "",
        launchFlags: [],
        note: "No accelerator detected — defaulting to Ollama",
      };
  }
};

/**
 * Derives the VRAM/memory figure to feed into {@link recommendNumCtx} for a
 * given detected hardware target.
 *
 * @remarks
 * Centralizes the Apple derate (unified memory is not dedicated VRAM) so
 * both the printed recommendation and the `--write` path agree.
 */
const numCtxInputFor = (hardware: HardwareTarget): number | null => {
  switch (hardware.kind) {
    case "nvidia-gpu":
    case "amd-gpu":
    case "intel-gpu":
      return hardware.vramMb;
    case "apple-metal":
      return deriveAppleNumCtxInput(hardware.unifiedMemoryMb);
    case "aws-trainium":
    case "gcp-tpu":
    case "cpu":
      return null;
  }
};

/** Parses `--write` and `--port <n>` from argv; ignores unknown flags. */
const parseCliArgs = (argv: string[]): { write: boolean; port: number } => {
  const write = argv.includes("--write");
  const portIndex = argv.indexOf("--port");
  const portArg = portIndex >= 0 ? argv[portIndex + 1] : undefined;
  const parsedPort = portArg ? Number(portArg) : NaN;
  const port =
    Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8000;
  return { write, port };
};

/**
 * True when `user-data/config.json` already has a `$providersSecrets`
 * envelope — reading/writing that file then requires an unlocked cipher.
 */
const configHasEncryptedProviders = async (
  rootDir: string,
): Promise<boolean> => {
  try {
    const raw = await readFile(join(rootDir, CONFIG_REL_PATH), "utf-8");
    const stored = parseStoredConfig(raw);
    return Boolean(stored.$providersSecrets);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

/**
 * Runs detection, prints the result, and — with `--write` — persists the
 * suggested provider and recommended `numCtx` to config.json.
 *
 * @remarks
 * Both writes are idempotent: skipped individually if already present, so a
 * manually-edited apiKey or a hand-tuned `numCtx` is never clobbered by a
 * re-run. The `numCtx` write happens whenever a recommendation is available —
 * including for `apple-metal` and `cpu`, which have no provider to add but
 * still benefit from a sized context window.
 *
 * When the on-disk config already encrypts providers, or when this run will
 * add a non-ollama provider, unlocks (or sets up) the shared config cipher
 * first — otherwise `getAll`/`set` fail with ConfigCipherLockedError on a
 * machine that has already run `loopy-server start`.
 */
export const runDetectHardwareCli = async (
  argv: string[],
  deps: {
    rootDir?: string;
    promptPassphrase?: (label: string) => Promise<string>;
  } = {},
): Promise<void> => {
  const { write, port } = parseCliArgs(argv);

  const hardware = await detectHardware();
  const suggestion = suggestProviderConfig(hardware, port);
  const recommendedNumCtx = recommendNumCtx(numCtxInputFor(hardware));

  console.log(
    JSON.stringify({ hardware, suggestion, recommendedNumCtx }, null, 2),
  );

  if (!write) {
    return;
  }

  const rootDir = deps.rootDir ?? process.cwd();
  const config = new ConfigManager({ rootDir });
  const willAddProvider = suggestion.provider !== "ollama";
  const needsCipher =
    willAddProvider || (await configHasEncryptedProviders(rootDir));

  if (needsCipher) {
    await config.unlockOrSetupProvidersCipher(
      deps.promptPassphrase ?? readPasswordAtStartup,
    );
  }

  const existingConfig = await config.getAll();
  if (existingConfig.numCtx === undefined) {
    await config.set("numCtx", recommendedNumCtx);
    console.log(`Wrote numCtx=${recommendedNumCtx} to config.`);
  } else {
    console.log(
      `numCtx is already set to ${existingConfig.numCtx} — skipping (recommended: ${recommendedNumCtx}).`,
    );
  }

  if (suggestion.provider === "ollama") {
    console.log(
      "No accelerator requiring a new provider — 'ollama' is already the default.",
    );
    return;
  }

  const existingProvider = await config.getProvider(suggestion.provider);
  if (existingProvider) {
    console.log(
      `Provider '${suggestion.provider}' is already configured — skipping write.`,
    );
    return;
  }

  await config.addProvider(suggestion.provider, {
    baseUrl: suggestion.baseUrl,
  });
  console.log(
    `Wrote provider '${suggestion.provider}' (${suggestion.baseUrl}) to config.`,
  );
  console.log(
    `Launch it with: vllm serve <model> --port ${port} ${suggestion.launchFlags.join(" ")}`,
  );
  console.log(
    `Then run: /providers list, and /set agent (or /set subagent) to select it.`,
  );
};

if (typeof require !== "undefined" && require.main === module) {
  void runDetectHardwareCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
