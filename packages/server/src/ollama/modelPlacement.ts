/**
 * Detects when a loaded Ollama model has spilled off the GPU, and reports it
 * once per client connection.
 *
 * @remarks
 * A model that doesn't fit in VRAM doesn't fail — Ollama silently offloads
 * the overflow layers to CPU and keeps serving, typically 10-50x slower.
 * That dwarfs every other performance knob in this codebase (`keep_alive`,
 * `num_ctx`, memory budgeting), so it's worth surfacing directly rather than
 * leaving the user to guess from wall-clock latency alone.
 *
 * The only signal for *where* a model runs is `RunningModel.size_vram` from
 * `GET /api/ps` — see {@link describeModelPlacement}.
 */

import type { RunningModel } from "./types.js";
import type { IOllamaAdminClient } from "../orchestration/interfaces/ollamaInterfaces.js";
import type { logger } from "../utils/logger.js";

/** Where a loaded model is actually running. */
export type ModelPlacementKind = "gpu" | "partial" | "cpu" | "unknown";

/** Classification result for one loaded model. */
export type ModelPlacement = {
  /** Model tag as reported by Ollama (e.g. `"gemma3:27b"`). */
  model: string;
  kind: ModelPlacementKind;
  /**
   * Percentage of the model resident in GPU VRAM, rounded. `null` when
   * `kind` is `"unknown"` — there's nothing to compute a percentage from.
   */
  gpuPercent: number | null;
};

/**
 * Fraction of a model's size that must be VRAM-resident to count as "on GPU".
 *
 * @remarks
 * Ollama's own VRAM accounting can undershoot `size` by a few MB even for a
 * fully-resident model — without this tolerance, every healthy model would
 * classify as `"partial"` and warn.
 */
const GPU_RESIDENT_THRESHOLD = 0.99;

/**
 * Classifies where a loaded model is actually running, from Ollama's
 * `size`/`size_vram` fields.
 *
 * @remarks
 * `size_vram` is Ollama-specific — the OpenAI-compatible admin shim
 * (`providers/openAiCompatibleAdapter.ts`) reports `{ name, size: 0 }` with
 * no VRAM data at all, which this function classifies as `"unknown"` rather
 * than `"cpu"`, so non-Ollama providers never trigger a false warning.
 *
 * @param model - One entry from {@link IOllamaAdminClient.listRunning}.
 * @returns The placement classification, with a GPU percentage when known.
 *
 * @example
 * ```ts
 * describeModelPlacement({ name: "gemma3:27b", size: 100, size_vram: 100 });
 * // { model: "gemma3:27b", kind: "gpu", gpuPercent: 100 }
 *
 * describeModelPlacement({ name: "gemma3:27b", size: 100, size_vram: 52 });
 * // { model: "gemma3:27b", kind: "partial", gpuPercent: 52 }
 *
 * describeModelPlacement({ name: "mistral-7b", size: 0 }); // OpenAI-compatible shim
 * // { model: "mistral-7b", kind: "unknown", gpuPercent: null }
 * ```
 */
export const describeModelPlacement = (model: RunningModel): ModelPlacement => {
  const name = model.name ?? model.model ?? "unknown-model";
  const { size, size_vram: sizeVram } = model;

  if (
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    size <= 0 ||
    typeof sizeVram !== "number" ||
    !Number.isFinite(sizeVram)
  ) {
    return { model: name, kind: "unknown", gpuPercent: null };
  }

  const ratio = sizeVram / size;

  if (ratio >= GPU_RESIDENT_THRESHOLD) {
    return { model: name, kind: "gpu", gpuPercent: 100 };
  }

  const gpuPercent = Math.max(0, Math.round(ratio * 100));

  if (sizeVram <= 0) {
    return { model: name, kind: "cpu", gpuPercent: 0 };
  }

  return { model: name, kind: "partial", gpuPercent };
};

/**
 * Finds a running model entry matching a configured model tag.
 *
 * @remarks
 * `GET /api/ps` reports fully-qualified tags (e.g. `"gemma3:27b"`), while
 * config may hold a bare name (e.g. `"gemma3"`). Without normalizing, the
 * placement check would either silently no-op (false negative) or match the
 * wrong loaded model.
 *
 * @param running - Models currently loaded, from {@link IOllamaAdminClient.listRunning}.
 * @param wanted - The configured model tag to find.
 * @returns The matching entry, or `undefined` if not currently loaded.
 */
export const matchRunningModel = (
  running: RunningModel[],
  wanted: string,
): RunningModel | undefined => {
  return (
    running.find((entry) => entry.name === wanted) ??
    running.find((entry) => entry.name === `${wanted}:latest`) ??
    running.find((entry) => entry.model === wanted)
  );
};

/** Fraction of `gpuPercent` shown in a spill warning message, appended per-model. */
const formatSpillMessage = (placement: ModelPlacement): string => {
  const percent = placement.gpuPercent ?? 0;

  // The two cases have genuinely different causes, so they get different
  // remedies. Ollama offloads as many layers as will fit, so a model that
  // merely exceeds VRAM lands as a *partial* split. Exactly 0% means no
  // usable GPU was found at all — telling that user to "free VRAM" sends
  // them chasing a capacity problem they don't have.
  if (placement.kind === "cpu") {
    const driverHint =
      process.platform === "darwin"
        ? "On Apple Silicon, check iogpu.wired_limit_mb — run loopy-detect-hardware."
        : "Check that `nvidia-smi` runs and the GPU driver is loaded — 0% (rather than a partial split) usually means Ollama found no usable GPU, not that the model is too big. `journalctl -u ollama | grep -i cuda` shows which compute library it chose at startup.";
    return `⚠ ${placement.model} is running entirely on CPU (0% GPU) — expect roughly 10x slower responses. ${driverHint}`;
  }

  const remedy =
    "Free VRAM (stop other models with 'ollama stop <model>'), lower the " +
    "context window (/set numCtx <smaller>), or switch to a smaller or " +
    "more-quantized model.";
  const appleHint =
    process.platform === "darwin"
      ? " On Apple Silicon also check iogpu.wired_limit_mb — run loopy-detect-hardware."
      : "";

  return `⚠ ${placement.model} is running ${percent}% on GPU / ${100 - percent}% on CPU — expect slower responses. ${remedy}${appleHint}`;
};

/**
 * Reports GPU/CPU placement for a set of loaded models, once per connection.
 *
 * @remarks
 * A model that isn't currently loaded (subagent model not yet used this
 * task, or an older Ollama without `size_vram`) is silently skipped rather
 * than treated as a spill — see {@link describeModelPlacement}. This is
 * intentionally lossy: catching it on a later task, once the model has
 * actually loaded, is preferable to a false alarm from absent data.
 */
export interface IModelPlacementReporter {
  /**
   * Checks placement for the given models and returns any new warning
   * messages (already deduped against prior calls for this `scope`).
   *
   * @param models - Model tags to check (e.g. the resolved agent/subagent
   *   models for a task). Never throws — resolves `[]` on any failure
   *   (Ollama unreachable, malformed response, etc.).
   * @param scope - Isolates dedup per client connection (typically the
   *   session's `requesterId`) so one client's warning doesn't silently
   *   suppress the same warning for a client that connects later. Pair every
   *   scope with a {@link IModelPlacementReporter.forgetScope} call when that
   *   connection ends.
   */
  reportPlacement(models: string[], scope: string): Promise<string[]>;

  /**
   * Drops all dedup state for one scope, so a later connection reusing the
   * same identifier starts fresh.
   *
   * @remarks
   * The reporter is a process-lifetime singleton but `scope` is a per-connection
   * UUID, so without this the dedup set grows by one entry per
   * (connection × spilled model × placement kind) and never shrinks — a client
   * in a reconnect loop adds entries with no upper bound. Call this from the
   * connection-closed hook.
   *
   * @param scope - The `requesterId` whose entries should be released.
   */
  forgetScope(scope: string): void;
}

/**
 * Constructs an {@link IModelPlacementReporter} backed by a real Ollama admin
 * client, deduping warnings per connection scope.
 *
 * @param deps.admin - Client used to query currently loaded models.
 * @param deps.log - Logger for the server-side warning record (in addition
 *   to the messages returned for the caller to forward to the client).
 *
 * @example
 * ```ts
 * const reporter = createModelPlacementReporter({ admin: ollamaClient, log: logger });
 * const warnings = await reporter.reportPlacement(["gemma3:27b"], session.requesterId);
 * warnings.forEach((message) => emit({ kind: "warning", message }));
 * ```
 */
export const createModelPlacementReporter = (deps: {
  admin: IOllamaAdminClient;
  log: Pick<typeof logger, "warn">;
}): IModelPlacementReporter => {
  // Keyed by scope first so `forgetScope` is a single delete rather than a
  // scan over every entry ever recorded — this reporter lives for the whole
  // server process while scopes are per-connection UUIDs.
  const warnedKeysByScope = new Map<string, Set<string>>();

  return {
    reportPlacement: async (models, scope) => {
      const uniqueModels = [...new Set(models)];
      if (uniqueModels.length === 0) {
        return [];
      }

      let running: RunningModel[];
      try {
        running = await deps.admin.listRunning();
      } catch {
        return [];
      }

      const messages: string[] = [];

      for (const wanted of uniqueModels) {
        const runningEntry = matchRunningModel(running, wanted);
        if (!runningEntry) {
          // Not loaded yet this task — skip rather than false-alarm.
          continue;
        }

        const placement = describeModelPlacement(runningEntry);
        if (placement.kind === "gpu" || placement.kind === "unknown") {
          continue;
        }

        let warnedKeys = warnedKeysByScope.get(scope);
        if (!warnedKeys) {
          warnedKeys = new Set<string>();
          warnedKeysByScope.set(scope, warnedKeys);
        }

        const key = `${placement.model}|${placement.kind}`;
        if (warnedKeys.has(key)) {
          continue;
        }
        warnedKeys.add(key);

        const message = formatSpillMessage(placement);
        deps.log.warn(message);
        messages.push(message);
      }

      return messages;
    },

    forgetScope: (scope) => {
      warnedKeysByScope.delete(scope);
    },
  };
};
