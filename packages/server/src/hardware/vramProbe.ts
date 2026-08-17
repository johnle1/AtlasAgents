/**
 * Best-effort VRAM/memory probing per accelerator vendor, plus a pure
 * `num_ctx` recommendation derived from the measured amount.
 *
 * @remarks
 * Every probe here is exec/sysfs based and used **only from the CLI**
 * (`detectHardware.ts` → `atlas-detect-hardware`). Nothing in this module is
 * imported by the running server — hardware probing must stay an explicit,
 * user-triggered action, never something that happens on every boot.
 *
 * Every probe function is best-effort: wrapped in try/catch, bounded by a
 * timeout, and returns `null` (never throws) on any failure. `null` means
 * "present but unmeasured" — distinct from "absent".
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 3000;

/**
 * Runs an external command with a bounded timeout, returning trimmed stdout
 * or `null` on any failure (binary missing, non-zero exit, timeout).
 */
const runProbe = async (
  command: string,
  args: string[],
): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: PROBE_TIMEOUT_MS,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
};

/** Parses the first line of `stdout` as a non-negative finite number of bytes; `null` if invalid. */
const parseBytes = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }
  const parsed = Number(value.trim().split("\n")[0]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/** Bytes to whole megabytes, floored; `null` passes through as `null`. */
const bytesToMb = (bytes: number | null): number | null =>
  bytes === null ? null : Math.floor(bytes / (1024 * 1024));

/**
 * Total VRAM (MB) reported by `nvidia-smi`, or `null` if unavailable.
 *
 * @remarks
 * `nvidia-smi` reports memory in MiB directly with `--format=csv,noheader,nounits`.
 */
export const probeNvidiaVram = async (): Promise<number | null> => {
  const output = await runProbe("nvidia-smi", [
    "--query-gpu=memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (output === null) {
    return null;
  }
  const parsed = Number(output.trim().split("\n")[0]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};

/**
 * Total VRAM (MB) for a discrete AMD GPU.
 *
 * @remarks
 * Tries sysfs first (`mem_info_vram_total`, in bytes — fast, no subprocess),
 * then falls back to `rocm-smi --showmeminfo vram --json` if sysfs is absent
 * (e.g. permission-restricted containers).
 */
export const probeAmdVram = async (): Promise<number | null> => {
  try {
    const cardDirs = (await fs.readdir("/sys/class/drm")).filter((entry) =>
      /^card\d+$/.test(entry),
    );
    for (const cardDir of cardDirs) {
      try {
        const raw = await fs.readFile(
          `/sys/class/drm/${cardDir}/device/mem_info_vram_total`,
          "utf-8",
        );
        const bytes = parseBytes(raw);
        if (bytes !== null) {
          return bytesToMb(bytes);
        }
      } catch {
        // This card has no VRAM sysfs entry (e.g. iGPU) — try the next one.
      }
    }
  } catch {
    // /sys/class/drm unreadable — fall through to rocm-smi.
  }

  const rocmOutput = await runProbe("rocm-smi", ["--showmeminfo", "vram", "--json"]);
  if (rocmOutput === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rocmOutput);
    if (parsed !== null && typeof parsed === "object") {
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (value !== null && typeof value === "object") {
          const total = (value as Record<string, unknown>)["VRAM Total Memory (B)"];
          const bytes = typeof total === "string" ? Number(total) : total;
          if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) {
            return bytesToMb(bytes);
          }
        }
      }
    }
  } catch {
    // Malformed rocm-smi output — treat as unmeasured.
  }
  return null;
};

/**
 * Total discrete VRAM (MB) for an Intel Arc GPU via sysfs `lmem_total_bytes`.
 *
 * @remarks
 * Only discrete Intel GPUs (Arc) expose `lmem_total_bytes`; integrated Intel
 * graphics has no dedicated VRAM and correctly returns `null` here.
 */
export const probeIntelVram = async (): Promise<number | null> => {
  try {
    const cardDirs = (await fs.readdir("/sys/class/drm")).filter((entry) =>
      /^card\d+$/.test(entry),
    );
    for (const cardDir of cardDirs) {
      try {
        const raw = await fs.readFile(
          `/sys/class/drm/${cardDir}/device/lmem_total_bytes`,
          "utf-8",
        );
        const bytes = parseBytes(raw);
        if (bytes !== null) {
          return bytesToMb(bytes);
        }
      } catch {
        // No lmem_total_bytes on this card (integrated Intel, or not Intel) — try next.
      }
    }
  } catch {
    // /sys/class/drm unreadable.
  }
  return null;
};

/**
 * Total unified memory (MB) on Apple Silicon via `sysctl -n hw.memsize`.
 *
 * @remarks
 * This is *unified* memory (CPU + GPU share the same pool), not dedicated
 * VRAM — callers must derate before treating it as a GPU memory budget.
 * Falls back to `os.totalmem()` if the sysctl call fails.
 */
export const probeAppleUnifiedMemory = async (): Promise<number | null> => {
  const output = await runProbe("sysctl", ["-n", "hw.memsize"]);
  const bytes = parseBytes(output);
  if (bytes !== null) {
    return bytesToMb(bytes);
  }
  const fallbackBytes = os.totalmem();
  return fallbackBytes > 0 ? bytesToMb(fallbackBytes) : null;
};

/** Total system RAM (MB) via `os.totalmem()` — used for the plain-CPU case. */
export const probeSystemMemory = (): number =>
  bytesToMb(os.totalmem()) ?? 0;

/**
 * macOS's Metal GPU-wired-memory ceiling (MB), via `sysctl -n iogpu.wired_limit_mb`.
 *
 * @remarks
 * macOS caps how much unified memory the GPU may wire at roughly ⅔ of total
 * RAM by default. Exceeding it forces Metal to spill work to CPU **even with
 * system RAM free** — so on Apple Silicon this is the number that actually
 * explains a CPU spill, not total RAM alone.
 *
 * `iogpu.wired_limit_mb` is already reported in megabytes — unlike the other
 * probes in this file, its output must NOT be routed through `bytesToMb`.
 * A value of `0` means "unset" (the macOS default budget applies), which is
 * indistinguishable from "not configurable" for this caller's purposes, so
 * both map to `null`.
 */
export const probeAppleWiredLimit = async (): Promise<number | null> => {
  const output = await runProbe("sysctl", ["-n", "iogpu.wired_limit_mb"]);
  const parsed = parseBytes(output);
  return parsed === null || parsed === 0 ? null : parsed;
};

/**
 * Fraction of Apple unified memory treated as available for the model's
 * working set. Metal shares memory with the OS and other apps, so the full
 * total is never actually usable — this mirrors Ollama's own default budget.
 */
const APPLE_UNIFIED_MEMORY_USABLE_FRACTION = 2 / 3;

/**
 * Recommends an Ollama `num_ctx` from a detected VRAM (or unified memory)
 * figure, via a conservative tier table.
 *
 * @remarks
 * Deliberately a tier table rather than a computed KV-cache formula — an
 * exact calculation needs per-model layer/head counts that aren't available
 * at this layer, and a wrong formula is worse than an honest, conservative
 * tier. Total VRAM is not free VRAM either: model weights consume most of
 * it, so these tiers assume a meaningful fraction is already spoken for.
 *
 * @param vramMb - Detected VRAM in MB, or `null`/`undefined` if unmeasured.
 *   For Apple Silicon, pass **unified memory already derated** via
 *   {@link deriveAppleNumCtxInput} — do not pass raw `hw.memsize` here.
 * @returns Recommended `num_ctx` value.
 *
 * @example
 * ```ts
 * recommendNumCtx(null);      // 4096 — unmeasured, stay conservative
 * recommendNumCtx(8_000);     // 8192 — 6-12 GB tier
 * recommendNumCtx(24_000);    // 32768 — 24-48 GB tier
 * ```
 */
export const recommendNumCtx = (vramMb: number | null | undefined): number => {
  if (vramMb === null || vramMb === undefined) {
    return 4096;
  }
  const vramGb = vramMb / 1024;
  if (vramGb < 6) {
    return 4096;
  }
  if (vramGb < 12) {
    return 8192;
  }
  if (vramGb < 24) {
    return 16384;
  }
  if (vramGb < 48) {
    return 32768;
  }
  return 65536;
};

/**
 * Derates raw Apple unified memory to the fraction usable as a GPU memory
 * budget, for feeding into {@link recommendNumCtx}.
 *
 * @param unifiedMemoryMb - Raw `hw.memsize`-derived total, or `null`.
 * @returns Derated MB figure, or `null` if input was `null`.
 */
export const deriveAppleNumCtxInput = (
  unifiedMemoryMb: number | null,
): number | null =>
  unifiedMemoryMb === null
    ? null
    : Math.floor(unifiedMemoryMb * APPLE_UNIFIED_MEMORY_USABLE_FRACTION);
