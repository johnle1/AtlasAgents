/**
 * Model list / find displays and live pull-progress streaming UI.
 *
 * @remarks
 * Pull progress intentionally updates a **single** streaming row via
 * {@link setStreamingText} (keyed by operation id) so history is not flooded
 * with percentage updates. {@link finishPullProgress} promotes the last line
 * into scrollback when the stream ends.
 */

import { getTheme } from "../theme/themeManager.js";
import { setStreamingText } from "../ui/uiBridge.js";
import { renderProgressBar } from "../utils/progressBar.js";
import { appendBlock, appendText } from "./sink.js";
import type { ModelStorageReport } from "@loopycode/shared";

/**
 * Last rendered pull-progress line per concurrent operation id.
 *
 * @remarks
 * Dedupes identical updates and lets {@link finishPullProgress} persist the
 * final status into history after clearing the live stream row.
 */
let lastPullLineByOperation = new Map<string, string>();

/**
 * Normalizes an optional operation id for the progress Map key.
 *
 * @param operationId - Usually the model name; omitted → `"default"`.
 * @returns Stable tracker key.
 */
const resolveOperationId = (operationId?: string): string =>
  operationId ?? "default";

/**
 * Clears live pull progress for an operation before a new pull starts.
 *
 * @param operationId - Tracker key (typically the model name).
 *
 * @example
 * ```ts
 * resetPullProgress("gemma3:4b");
 * ```
 */
export const resetPullProgress = (operationId?: string): void => {
  const trackerKey = resolveOperationId(operationId);
  lastPullLineByOperation.delete(trackerKey);
  setStreamingText(null);
};

/**
 * Ends live pull progress: clears the stream row and appends the last line.
 *
 * @remarks
 * Call from both success and failure paths so the streaming status does not
 * linger after `/models pull` finishes.
 *
 * @param operationId - Tracker key used during {@link printProgress}.
 */
export const finishPullProgress = (operationId?: string): void => {
  const trackerKey = resolveOperationId(operationId);
  const lastLine = lastPullLineByOperation.get(trackerKey);
  lastPullLineByOperation.delete(trackerKey);
  setStreamingText(null);
  if (lastLine) {
    appendText(lastLine, "secondary");
  }
};

/**
 * Metadata shape accepted for installed-model listings (Ollama-style).
 */
type InstalledModelView = {
  name: string;
  size?: number;
  modified_at?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
};

/**
 * Prints installed models with size / family / parameter details.
 *
 * @remarks
 * Empty list hints at `/models pull <name>`. Size is shown in GB when present.
 *
 * @param models - Detailed model records from the server.
 *
 * @example
 * ```ts
 * printInstalledModels(await connection.fetchModelsDetailed());
 * ```
 */
export const printInstalledModels = (models: InstalledModelView[]): void => {
  const theme = getTheme();
  const outputLines: string[] = [""];

  if (models.length === 0) {
    outputLines.push(
      `${theme.textSecondary}  No models installed. Pull one with: /models pull <name>${theme.reset}`,
      "",
    );
    appendBlock(outputLines);
    return;
  }

  outputLines.push(
    `${theme.textBold}  Found ${models.length} model(s):${theme.reset}`,
    "",
  );

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex]!;

    outputLines.push(
      `  ${theme.warning}${modelIndex + 1}.${theme.reset} ${model.name}`,
    );

    if (typeof model.size === "number" && model.size > 0) {
      outputLines.push(
        `     ${theme.textSecondary}Size:${theme.reset} ${(model.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
      );
    }

    if (typeof model.modified_at === "string" && model.modified_at.length > 0) {
      outputLines.push(
        `     ${theme.textSecondary}Modified:${theme.reset} ${new Date(model.modified_at).toLocaleString()}`,
      );
    }

    if (model.details?.family) {
      outputLines.push(
        `     ${theme.textSecondary}Family:${theme.reset} ${model.details.family}`,
      );
    }

    if (model.details?.parameter_size) {
      outputLines.push(
        `     ${theme.textSecondary}Parameters:${theme.reset} ${model.details.parameter_size}`,
      );
    }

    outputLines.push("");
  }

  appendBlock(outputLines);
};

/**
 * Prints `/models find` results: details on hit, or alternatives + pull hint.
 *
 * @param query - Search substring the user typed.
 * @param found - Matching model record, or `undefined` if none.
 * @param all - Full installed list (used for the “Available:” fallback line).
 */
export const printModelFind = (
  query: string,
  found: InstalledModelView | undefined,
  all: Array<{ name: string }>,
): void => {
  const theme = getTheme();
  const outputLines: string[] = [""];

  if (found) {
    outputLines.push(
      `${theme.textBold}${theme.success}  Model found:${theme.reset}`,
    );
    outputLines.push(
      `    ${theme.textAccent}Name:${theme.reset} ${found.name}`,
    );

    if (typeof found.size === "number" && found.size > 0) {
      outputLines.push(
        `    ${theme.textAccent}Size:${theme.reset} ${(found.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
      );
    }

    if (typeof found.modified_at === "string" && found.modified_at.length > 0) {
      outputLines.push(
        `    ${theme.textAccent}Modified:${theme.reset} ${new Date(found.modified_at).toLocaleString()}`,
      );
    }

    if (found.details?.family) {
      outputLines.push(
        `    ${theme.textAccent}Family:${theme.reset} ${found.details.family}`,
      );
    }

    if (found.details?.parameter_size) {
      outputLines.push(
        `    ${theme.textAccent}Parameters:${theme.reset} ${found.details.parameter_size}`,
      );
    }

    if (found.details?.quantization_level) {
      outputLines.push(
        `    ${theme.textAccent}Quantization:${theme.reset} ${found.details.quantization_level}`,
      );
    }
  } else {
    outputLines.push(
      `${theme.warning}  Model "${query}" not found locally.${theme.reset}`,
    );

    if (all.length > 0) {
      outputLines.push(
        `  ${theme.textSecondary}Available:${theme.reset} ${all.map((model) => model.name).join(", ")}`,
      );
    }

    outputLines.push(
      `  ${theme.textSecondary}Pull it with:${theme.reset} /models pull ${query}`,
    );
  }

  outputLines.push("");
  appendBlock(outputLines);
};

/**
 * Formats one pull-progress status line (bar + GB, or textual status).
 *
 * @param progress - Bytes completed/total and optional digest/status.
 * @param theme - Active theme (for non-numeric status coloring).
 * @returns Single display line without trailing newline.
 */
const formatPullProgressLine = (
  progress: {
    status?: string;
    completed?: number;
    total?: number;
    digest?: string;
  },
  theme: ReturnType<typeof getTheme>,
): string => {
  const statusMessage =
    typeof progress.status === "string" && progress.status.length > 0
      ? progress.status
      : "pulling…";

  if (
    progress.total !== undefined &&
    progress.completed !== undefined &&
    progress.total > 0
  ) {
    const ratio = Math.min(1, Math.max(0, progress.completed / progress.total));
    const percentage = (ratio * 100).toFixed(1);
    const progressBarWidth = 30;
    const progressBar = renderProgressBar(ratio, progressBarWidth);
    const totalSizeGB = (progress.total / 1024 / 1024 / 1024).toFixed(2);
    const completedSizeGB = (progress.completed / 1024 / 1024 / 1024).toFixed(
      2,
    );
    let progressOutput = `  [${progressBar}] ${percentage}% | ${completedSizeGB}GB / ${totalSizeGB}GB`;
    if (typeof progress.digest === "string" && progress.digest.length > 0) {
      // Truncate digest — full hash is noisy in a one-line status.
      progressOutput += ` | ${progress.digest.substring(0, 12)}...`;
    }
    return progressOutput;
  }

  return `  ${theme.textSecondary}${statusMessage}${theme.reset}`;
};

/**
 * Writes a progress line to the live stream if it differs from the last one.
 *
 * @param trackerKey - Operation map key.
 * @param line - Newly formatted status line.
 * @returns `true` if the live UI was updated; `false` if unchanged (deduped).
 */
const updatePullProgressLine = (
  trackerKey: string,
  line: string,
): boolean => {
  const lastLine = lastPullLineByOperation.get(trackerKey) ?? "";
  if (line === lastLine) {
    return false;
  }

  lastPullLineByOperation.set(trackerKey, line);
  setStreamingText(line);
  return true;
};

/**
 * Updates live model-pull progress, or prints a terminal error.
 *
 * @remarks
 * When `progress.error` is set: clears the stream tracker, appends an error
 * line, and returns `true` so callers can mark the pull as failed. Otherwise
 * formats a progress bar / status via {@link formatPullProgressLine} and
 * updates the streaming row (deduping identical lines). Returns `false` for
 * non-error updates.
 *
 * @param progress - Frame payload from `models.pull` streaming.
 * @param operationId - Usually the model name; isolates concurrent pulls.
 * @returns `true` if this frame was a fatal error; otherwise `false`.
 *
 * @example
 * ```ts
 * resetPullProgress(name);
 * const { done } = await connection.sendStream({
 *   kind: "models.pull",
 *   payload: { name },
 *   onFrame: (frame) => {
 *     if (frame.kind === "progress" && frame.data) {
 *       if (printProgress(frame.data, name)) pullFailed = true;
 *     }
 *   },
 * });
 * await done;
 * finishPullProgress(name);
 * ```
 */
export const printProgress = (
  progress: {
    status?: string;
    completed?: number;
    total?: number;
    error?: string;
    digest?: string;
  },
  operationId?: string,
): boolean => {
  const trackerKey = resolveOperationId(operationId);
  const theme = getTheme();

  if (typeof progress.error === "string" && progress.error.length > 0) {
    setStreamingText(null);
    lastPullLineByOperation.delete(trackerKey);
    appendText(
      `  ${theme.error}error: ${progress.error}${theme.reset}`,
      "error",
    );
    return true;
  }

  updatePullProgressLine(trackerKey, formatPullProgressLine(progress, theme));
  return false;
};

/**
 * Formats a byte count as `"0 B"` (exact zero, common for "deleting this tag
 * frees nothing") or a 2-decimal GB figure — matching the GB formatting used
 * elsewhere in this file for consistency.
 *
 * @example
 * ```ts
 * formatStorageBytes(0);            // "0 B"
 * formatStorageBytes(8_100_000_000); // "7.55 GB"
 * ```
 */
export const formatStorageBytes = (bytes: number): string =>
  bytes === 0 ? "0 B" : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;

/**
 * Prints the `/models storage` report: real on-disk usage from Ollama's
 * manifests + blobs, per-tag unique-vs-shared bytes, and any orphaned blob
 * files (interrupted pulls) with copy-pasteable `rm -rf` lines.
 *
 * @remarks
 * Purely a display of what {@link ModelStorageReport} already computed — this
 * function neither deletes anything nor recomputes byte totals. When
 * `report.available` is `false`, prints the server's `reason` and returns.
 *
 * @param report - Response from the `models.storage` command.
 *
 * @example
 * ```ts
 * const report = await connection.sendCommand<ModelStorageReport>("models.storage", {});
 * printModelStorage(report);
 * ```
 */
export const printModelStorage = (report: ModelStorageReport): void => {
  const theme = getTheme();
  const outputLines: string[] = [
    "",
    `${theme.textBold}  Ollama model storage${theme.reset}`,
  ];

  if (!report.available) {
    outputLines.push(
      `  ${theme.textSecondary}${report.reason}${theme.reset}`,
      "",
    );
    appendBlock(outputLines);
    return;
  }

  outputLines.push(
    `  ${theme.textSecondary}${report.dir}  (${report.dirSource})${theme.reset}`,
    "",
    `  ${theme.textAccent}on disk${theme.reset}     ${formatStorageBytes(report.totals.onDiskBytes)}`,
    `  ${theme.textAccent}referenced${theme.reset}  ${formatStorageBytes(report.totals.referencedBytes)}`,
    `  ${theme.textAccent}orphaned${theme.reset}    ${formatStorageBytes(report.totals.orphanedBytes)}${report.orphans.length > 0 ? ` (${report.orphans.length} file${report.orphans.length === 1 ? "" : "s"})` : ""}`,
    "",
  );

  if (report.models.length === 0) {
    outputLines.push(
      `  ${theme.textSecondary}No installed models found.${theme.reset}`,
      "",
    );
  } else {
    outputLines.push(`${theme.textBold}  Installed models${theme.reset}`, "");
    for (const model of report.models) {
      const sharedNote =
        model.sharedBytes > 0
          ? `  ${theme.textSecondary}${formatStorageBytes(model.sharedBytes)} shared with ${model.sharedWith.join(", ")}${theme.reset}`
          : "";
      const freesNothingNote =
        model.uniqueBytes === 0
          ? `  ${theme.warning}⚠ deleting frees nothing${theme.reset}`
          : "";
      outputLines.push(
        `  ${theme.warning}${model.tag}${theme.reset}  ${formatStorageBytes(model.totalBytes)} total, ${formatStorageBytes(model.uniqueBytes)} unique${sharedNote}${freesNothingNote}`,
      );
    }
    outputLines.push("");
  }

  if (report.orphans.length > 0) {
    outputLines.push(
      `${theme.textBold}  Orphaned blobs${theme.reset} ${theme.textSecondary}— not visible to /models list, not removed by /models delete${theme.reset}`,
      `  ${theme.textSecondary}(left behind by interrupted pulls). Delete manually if you don't need them:${theme.reset}`,
      "",
    );
    for (const orphan of report.orphans) {
      outputLines.push(
        `  ${theme.textSecondary}rm -rf '${orphan.path}'${theme.reset}   ${formatStorageBytes(orphan.bytes)}`,
      );
    }
    outputLines.push("");
  }

  appendBlock(outputLines);
};
