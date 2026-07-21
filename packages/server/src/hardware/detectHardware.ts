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
 * AWS Trainium and Google TPU are both served through vLLM, which speaks the
 * same OpenAI-compatible protocol as every other provider in this codebase
 * (see {@link OpenAiCompatibleAdapter}). So detection only needs to answer
 * "which accelerator, if any, is present" — the rest (config wiring,
 * request/response translation) is already generic.
 *
 * Usage:
 * ```sh
 * node dist/hardware/detectHardware.js               # print only
 * node dist/hardware/detectHardware.js --write        # also add the suggested provider to config
 * node dist/hardware/detectHardware.js --write --port 9000
 * ```
 */

import { existsSync, readdirSync } from "node:fs";
import { ConfigManager } from "../config/configManager.js";

/** One detected hardware target, with enough detail to name and launch a provider for it. */
export type HardwareTarget =
  | { kind: "aws-trainium"; instanceType: string; neuronCoreCount: number }
  | { kind: "gcp-tpu"; acceleratorType: string }
  | { kind: "nvidia-gpu" }
  | { kind: "cpu" };

/** A suggested provider entry plus the `vllm serve` flags to launch it with. */
export type ProviderSuggestion = {
  provider: string;
  baseUrl: string;
  launchFlags: string[];
  note: string;
};

const FETCH_TIMEOUT_MS = 1500;

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
const detectNvidiaGpu = (): boolean =>
  existsSync("/dev/nvidia0") || listDevMatching("nvidia").length > 0;

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

  if (detectNvidiaGpu()) {
    return { kind: "nvidia-gpu" };
  }

  return { kind: "cpu" };
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
        note: "Detected NVIDIA GPU — standard vLLM path",
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

/** Parses `--write` and `--port <n>` from argv; ignores unknown flags. */
const parseCliArgs = (
  argv: string[],
): { write: boolean; port: number } => {
  const write = argv.includes("--write");
  const portIndex = argv.indexOf("--port");
  const portArg = portIndex >= 0 ? argv[portIndex + 1] : undefined;
  const parsedPort = portArg ? Number(portArg) : NaN;
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8000;
  return { write, port };
};

/**
 * Runs detection, prints the result, and — with `--write` — appends the
 * suggested provider to config.json (idempotent: skipped if that provider
 * name is already configured, so a manually-edited apiKey is never clobbered).
 */
export const runDetectHardwareCli = async (
  argv: string[],
  deps: { rootDir?: string } = {},
): Promise<void> => {
  const { write, port } = parseCliArgs(argv);

  const hardware = await detectHardware();
  const suggestion = suggestProviderConfig(hardware, port);

  console.log(JSON.stringify({ hardware, suggestion }, null, 2));

  if (!write) {
    return;
  }

  if (suggestion.provider === "ollama") {
    console.log(
      "No accelerator detected — nothing to write ('ollama' is already the default provider).",
    );
    return;
  }

  const config = new ConfigManager({ rootDir: deps.rootDir ?? process.cwd() });
  const existing = await config.getProvider(suggestion.provider);
  if (existing) {
    console.log(
      `Provider '${suggestion.provider}' is already configured — skipping write.`,
    );
    return;
  }

  await config.addProvider(suggestion.provider, { baseUrl: suggestion.baseUrl });
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
