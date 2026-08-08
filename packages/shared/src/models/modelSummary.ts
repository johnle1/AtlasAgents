/**
 * Wire shape for one entry in a `models.list` response — the metadata
 * available for a model regardless of which provider (Ollama, an
 * OpenAI-compatible endpoint, etc.) is serving it.
 */

/** Nested model metadata (family, quantization level, parameter count, etc.). Often partially or fully absent. */
export interface ModelDetails {
  /** Model family e.g., "Gemma", "Llama". */
  family?: string;

  /** Parameter size e.g., "27B", "8B". */
  parameter_size?: string;

  /** Quantization level e.g., "Q4_K_M", "F16". */
  quantization_level?: string;

  /** Model file format e.g., "GGUF". */
  format?: string;
}

/**
 * One model as reported by `models.list`.
 *
 * @example
 * ```ts
 * const model: ModelSummary = {
 *   name: "gemma3:27b",
 *   size: 17_200_000_000,
 *   digest: "sha256:...",
 *   modified_at: "2025-01-15T10:30:00Z",
 *   details: {
 *     family: "Gemma",
 *     parameter_size: "27B",
 *     quantization_level: "Q4_K_M",
 *     format: "GGUF",
 *   },
 * };
 * ```
 */
export interface ModelSummary {
  /** Model tag name (e.g. "llama3:8b", "gemma3:latest"). The name used in chat/pull requests. */
  name: string;

  /** Total size in bytes, when the provider reports it. */
  size?: number;

  /** SHA256 digest for model verification. */
  digest?: string;

  /** ISO-8601 timestamp when the model was last modified. */
  modified_at?: string;

  /** Detailed model metadata; often absent for non-Ollama providers. */
  details?: ModelDetails;
}
