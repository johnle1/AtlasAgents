import { AppError } from "./appError.js";

/**
 * Thrown when an operation conflicts with current state or concurrent modifications.
 *
 * @remarks
 * Used for:
 * - Resource state conflicts (e.g., already running, already completed)
 * - Concurrent modification conflicts (optimistic lock failures)
 * - Version mismatches or stale data
 * - Duplicate resource creation attempts
 *
 * Always returns HTTP 409 (Conflict) status code. Callers should retry
 * the operation, potentially after refreshing state information.
 *
 * @example
 * ```ts
 *  * Check for concurrent modification
 * if (data.version !== expectedVersion) {
 *   throw new ConflictError(
 *     `Version mismatch: expected ${expectedVersion}, got ${data.version}`
 *   );
 * }
 *
 * * Check resource state
 * if (workspace.isRunning) {
 *   throw new ConflictError("Workspace already has an active operation");
 * }
 * ```
 */
export class ConflictError extends AppError {
  /**
   * Creates a conflict error with a descriptive message.
   *
   * @param message - Description of the conflict (e.g., state information,
   *   version mismatch details, concurrent operation details)
   */
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}
