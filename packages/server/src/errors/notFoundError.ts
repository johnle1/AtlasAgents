import { AppError } from "./appError.js";

/**
 * Thrown when a requested resource cannot be found.
 *
 * @remarks
 * Used for:
 * - Missing files or directories
 * - Non-existent models or skills
 * - Missing configuration values
 * - Deleted records or resources
 *
 * Always returns HTTP 404 (Not Found) status code. Callers should verify
 * the resource exists before operating on it, or handle missing resources gracefully.
 *
 * @example
 * ```ts
 *  * Check if model exists
 * const models = await ollama.listModels();
 * if (!models.includes("gemma3:27b")) {
 *   throw new NotFoundError("Model 'gemma3:27b'");
 * }
 *
 *  * Handle not found errors
 * try {
 *   const file = await fs.readFile(path);
 * } catch (err) {
 *   if (err.code === "ENOENT") {
 *     throw new NotFoundError(`File '${path}'`);
 *   }
 * }
 * ```
 */
export class NotFoundError extends AppError {
  /**
   * Creates a not-found error for a missing resource.
   *
   * @param resource - Name or description of the missing resource.
   *   The message will be formatted as "resource not found".
   */
  constructor(resource: string) {
    super(`${resource} not found`, 404, "NOT_FOUND");
  }
}
