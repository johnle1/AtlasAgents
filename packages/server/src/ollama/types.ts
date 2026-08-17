/**
 * Shared TypeScript type definitions for the Ollama HTTP client.
 *
 * @remarks
 * Defines the shapes of responses from Ollama's REST API endpoints:
 * - `GET /api/tags` → `OllamaModelSummary[]` (list installed models)
 * - `POST /api/pull` → streaming `PullProgress` objects (download progress)
 * - `POST /api/show` → `ModelInfo` (model metadata + capabilities)
 * - `GET /api/ps` → `RunningModel[]` (models currently in memory)
 *
 * These types are version-tolerant: Ollama versions may add, remove, or rename
 * fields, so all fields are optional. Consumers should defensively check for
 * presence before relying on a field's value.
 *
 * Also exports `OllamaError` — a typed error for HTTP failures and pre-checks
 * that the client catches and wraps.
 */

/**
 * Nested model metadata details from Ollama's tags or show endpoints, and
 * the summary of one installed model from `GET /api/tags`.
 *
 * @remarks
 * Re-exported under Ollama-specific names from `@atlasagents/shared`'s
 * `ModelDetails`/`ModelSummary` — this is the same wire shape the client's
 * `InstalledModel` type aliases, since `models.list` round-trips it as-is
 * with no transformation.
 *
 * @example
 * ```ts
 * const models = await ollama.listModels();
 * // [
 * //   { name: "llama3:8b", size: 4741432393, digest: "..." },
 * //   { name: "gemma3:27b", size: 16000000000, digest: "..." }
 * // ]
 * ```
 */
export type {
  ModelSummary as OllamaModelSummary,
  ModelDetails as OllamaModelDetails,
} from "@atlasagents/shared";

/**
 * One progress update streamed from `POST /api/pull` (model download).
 *
 * @remarks
 * When pulling a model, Ollama returns an NDJSON stream of progress objects.
 * Each line represents a stage in the download: pulling manifest, downloading
 * chunks, verifying digest, etc. The `completed` and `total` fields only appear
 * during active download.
 *
 * @example
 * ```ts
 * for await (const progress of ollama.pullModel("llama3:8b")) {
 *   if (progress.completed && progress.total) {
 *     const pct = Math.round((progress.completed / progress.total) * 100);
 *     console.log(`${pct}%`);
 *   } else {
 *     console.log(progress.status); // "pulling manifest", "success", etc.
 *   }
 * }
 * ```
 */
export interface PullProgress {
  /** Human-readable status message (e.g. "pulling manifest", "downloading", "verifying sha256", "success"). */
  status?: string;

  /** Error description if a pull chunk fails. */
  error?: string;

  /** Bytes downloaded so far. Only present during active download. */
  completed?: number;

  /** Total bytes to download. Only present during active download. */
  total?: number;

  /** SHA256 digest of the layer being downloaded. */
  digest?: string;
}

/**
 * Model metadata from `POST /api/show`.
 *
 * @remarks
 * Contains everything Ollama knows about a model: size, parameters, family,
 * quantization, context window, **and critically, capabilities** (whether it
 * supports native tool calling). Fields vary by Ollama version and model type,
 * so all are optional.
 *
 * The `capabilities` field is used by `modelSupportsNativeTools()` to determine
 * whether the agent can use native tool calling or must fall back to text-based.
 *
 * @example
 * ```ts
 * const info = await ollama.showModel("gemma3:27b");
 * if (info.capabilities?.includes("tools")) {
 *   console.log("Supports native tool calling");
 * }
 * console.log(`Context: ${info.context_length} tokens`);
 * ```
 */
export interface ModelInfo {
  /** Model tag name when present (e.g. "llama3:8b"). */
  name?: string;

  /** Technical model identifier, may include version/digest info. */
  model?: string;

  /** Total size in bytes. */
  size?: number;

  /** Parameter count as a string (e.g. "8B") or number. */
  parameters?: string | number;

  /** Model family (e.g. "llama", "gemma"). May be top-level or nested in `details`. */
  family?: string;

  /** Quantization level (e.g. "Q4_K_M", "Q8_0"). */
  quantization?: string;

  /** Context window size in tokens supported by this model. */
  context_length?: number;

  /** Array of capabilities — crucially includes "tools" if native tool calling is supported. */
  capabilities?: string[];

  /** Raw Modelfile text used to build this model. */
  modelfile?: string;

  /** Chat template string for this model. */
  template?: string;

  /** Model license text. */
  license?: string;

  /** Nested metadata keys (varies by Ollama version and model type). */
  model_info?: Record<string, unknown>;

  /** Catch-all for additional fields from newer Ollama servers. */
  [key: string]: unknown;
}

/**
 * Metadata for one model currently loaded in Ollama's memory.
 *
 * @remarks
 * Returned by `GET /api/ps` (Ollama's "process" list — models in RAM).
 * Includes the model name, size, expiration time (when Ollama will unload it
 * from memory if unused), and an optional digest for integrity checking.
 *
 * The `expires_at` field is critical for determining whether a model is "warm"
 * in memory (still available for immediate inference) or about to be unloaded.
 *
 * @example
 * ```ts
 * const running = await ollama.listRunning();
 * for (const model of running) {
 *   const isWarm = new Date(model.expires_at) > new Date();
 *   console.log(`${model.name}: ${isWarm ? "warm" : "expiring soon"}`);
 * }
 * ```
 */
export interface RunningModel {
  /** Model tag/name (e.g. "llama3:8b"). The name users reference. */
  name?: string;

  /** Technical model identifier with version/digest info. */
  model?: string;

  /** Size in bytes of the loaded model in memory (VRAM + system RAM combined). */
  size?: number;

  /**
   * Bytes of this model resident in GPU VRAM.
   *
   * @remarks
   * Compared against {@link RunningModel.size} this is the only signal Ollama
   * gives for *where* a model actually runs — it's what `ollama ps` uses to
   * print its `100% GPU` / `52%/48% CPU/GPU` column:
   * - `size_vram === size` — fully on GPU
   * - `0 < size_vram < size` — split; the remainder runs on CPU
   * - `size_vram === 0` — entirely on CPU
   *
   * A model that spilled to CPU is typically an order of magnitude slower,
   * so this is usually the first thing to check when inference feels slow.
   * See {@link describeModelPlacement} in `ollama/modelPlacement.ts`.
   *
   * Absent on older Ollama servers and on OpenAI-compatible providers (whose
   * admin shim reports `size: 0` with no VRAM data) — treated as "unknown"
   * rather than "on CPU" so non-Ollama backends never trigger false warnings.
   */
  size_vram?: number;

  /** SHA256 digest for model integrity verification. */
  digest?: string;

  /** ISO-8601 timestamp when Ollama will unload this model from memory if unused. */
  expires_at?: string;

  /** Additional metadata blob (structure varies by Ollama version). */
  details?: Record<string, unknown>;

  /** Catch-all for additional fields from newer Ollama servers. */
  [key: string]: unknown;
}

/**
 * Typed error for Ollama HTTP failures and logical errors.
 *
 * @remarks
 * Wraps non-2xx HTTP responses from Ollama and pre-check failures (e.g.,
 * attempting to delete a non-existent model). Includes both the HTTP status
 * code and up to 500 characters of the response body for debugging.
 *
 * Throw this error when Ollama operations fail, so callers can catch
 * `instanceof OllamaError` and distinguish Ollama failures from network errors.
 *
 * @example
 * ```ts
 * try {
 *   await ollama.pullModel("nonexistent:99b");
 * } catch (err) {
 *   if (err instanceof OllamaError && err.status === 404) {
 *     console.log("Model not found in Ollama registry");
 *   }
 * }
 * ```
 */
export class OllamaError extends Error {
  /**
   * Creates a new OllamaError with HTTP status and optional response body.
   *
   * @param status - HTTP status code (e.g. 404, 503), or a logical status like 404 for not-found pre-checks.
   * @param body - Optional response body text for debugging (truncated to 500 chars in the error message).
   */
  constructor(
    public readonly status: number,
    body?: string,
  ) {
    // Build an optional suffix from the response body: if present and non-empty,
    // append the first 500 chars (in case the body is huge) after a colon.
    // Otherwise, keep the suffix empty so the error message is just the status.
    const suffix = body && body.length > 0 ? `: ${body.slice(0, 500)}` : "";

    // Call the Error constructor with the formatted message.
    // Example: "OllamaError HTTP 404: model not found"
    super(`OllamaError HTTP ${status}${suffix}`);

    // Set the name for easier identification in catch blocks and logging.
    this.name = "OllamaError";
  }
}
