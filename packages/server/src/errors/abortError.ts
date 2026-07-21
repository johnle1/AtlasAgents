import { AppError } from "./appError.js";

/**
 * Thrown when an operation is intentionally aborted or cancelled.
 *
 * @remarks
 * Used for:
 * - User-initiated cancellations
 * - System shutdown or abort signals
 * - Resource cleanup during process termination
 * - Intentional operation stops before completion
 *
 * Returns HTTP 499 (Client Closed Request) status code, indicating the client
 * or system deliberately stopped the operation, not a server failure.
 * This is not a server error and requires no action other than cleanup.
 *
 * @example
 * ```ts
 * Handle abort signal
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 5000);
 *
 * try {
 *   await longRunningTask(controller.signal);
 * } catch (err) {
 *   if (err instanceof AbortError) {
 *     console.log("Operation cancelled by user");
 *     Perform cleanup, no error reporting needed
 *   }
 * }
 * ```
 */
export class AbortError extends AppError {
  /**
   * Creates an abort error with optional custom message.
   *
   * @param message - Description of why the operation was aborted.
   *   Defaults to "Operation aborted" if not provided.
   */
  constructor(message: string = "Operation aborted") {
    super(message, 499, "ABORTED");
  }
}
