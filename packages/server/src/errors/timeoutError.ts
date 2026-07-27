import { AppError } from "./appError.js";

/**
 * Thrown when an operation exceeds its configured time limit.
 *
 * @remarks
 * Used for:
 * - API requests exceeding timeout limits
 * - Database queries taking too long
 * - Long-running tasks exceeding allowed duration
 * - Deadlock detection timeouts
 *
 * Always returns HTTP 408 (Request Timeout) status code. Callers may retry
 * the operation or consider optimizing it to complete faster.
 *
 * @example
 * ```ts
 *  * Set operation timeout
 * const timeout = setTimeout(() => {
 *   throw new TimeoutError("Database query exceeded 30s limit");
 * }, 30000);
 *
 * try {
 *   await longRunningOperation();
 * } finally {
 *   clearTimeout(timeout);
 * }
 * ```
 */
export class TimeoutError extends AppError {
  /**
   * Creates a timeout error with operation details.
   *
   * @param message - Description including operation name and timeout limit
   *   (e.g., "Workspace initialization exceeded 60s timeout")
   */
  constructor(message: string) {
    super(message, 408, "TIMEOUT");
  }
}
