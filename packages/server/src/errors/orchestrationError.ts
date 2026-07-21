import { AppError } from "./appError.js";

/**
 * Thrown when agent orchestration or execution fails.
 *
 * @remarks
 * Used for:
 * - Agent planning failures or invalid plans
 * - Orchestrator execution errors during task processing
 * - Subsubagent failures or coordination issues
 * - Agent lifecycle management failures
 * - Orchestration pipeline breakdowns
 *
 * Always returns HTTP 500 (Internal Server Error) status code, indicating
 * a server-side failure in the orchestration system. Callers should not
 * retry immediately; logs should be checked for root cause.
 *
 * This error wraps failures from the orchestration layer (agents, planning,
 * coordination) to distinguish them from other server errors.
 *
 * @example
 * ```ts
 *  * Handle orchestration failures
 * try {
 *   const result = await orchestrator.execute(task);
 * } catch (err) {
 *   if (err instanceof OrchestrationError) {
 *     logger.error("Orchestration failed", {
 *       task: task.id,
 *       error: err.message
 *     });
 *     * Alert on-call, do not retry
 *   }
 * }
 * ```
 */
export class OrchestrationError extends AppError {
  /**
   * Creates an orchestration error with failure details.
   *
   * @param message - Description of what failed in the orchestration pipeline
   *   (e.g., "Agent planning exceeded token limit", "Subsubagent execution failed")
   */
  constructor(message: string) {
    super(message, 500, "ORCHESTRATION_ERROR");
  }
}
