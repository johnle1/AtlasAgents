/**
 * Error types for OpenAI-compatible model providers (LM Studio, llama.cpp's server, ...).
 *
 * @remarks
 * Mirrors the shape of {@link OllamaError} so callers can handle provider
 * failures the same way regardless of which backend served the request.
 */

/**
 * Typed HTTP failure for non-2xx responses (or transport errors) from an
 * OpenAI-compatible chat completions endpoint.
 */
export class ModelProviderError extends Error {
  /**
   * @param status - HTTP status code (or 0 for transport/network failures).
   * @param body - Optional response body snippet for debugging.
   */
  constructor(
    public readonly status: number,
    body?: string,
  ) {
    const suffix = body && body.length > 0 ? `: ${body.slice(0, 500)}` : "";
    super(`ModelProviderError HTTP ${status}${suffix}`);
    this.name = "ModelProviderError";
  }
}

/**
 * Thrown when an admin operation (pull, delete) is not supported by a
 * single-model backend such as LM Studio, where the model is fixed at launch.
 */
export class AdminUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminUnsupportedError";
  }
}
