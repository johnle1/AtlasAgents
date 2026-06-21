/**
 * <Summary>
 * What it does:
 *   Error types specific to advisor operations.
 *
 * How it fits in the system:
 *   Defines advisor-specific errors that can occur during planning and execution.
 *   Currently only contains TaskSkippedError, but provides a namespace for
 *   future advisor-specific error types.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - advisor.ts — throws TaskSkippedError when user skips task.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Error thrown when the user skips the task at plan review (no agents started).
 *
 * How it fits in the system:
 *   Thrown by Advisor.plan when the plan review hook returns a "skip" decision.
 *   This is a controlled cancellation that indicates the task should not proceed
 *   without starting any agents. It's different from a normal error because it
 *   represents a deliberate user decision rather than a failure.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - Advisor.plan — throws when reviewPlan returns skip decision.
 *   - AdvisorOrchestrator.runTask — catches and handles as user cancellation.
 * </Summary>
 */
export class TaskSkippedError extends Error {
  /**
   * Constructor
   *
   * How it does it (step by step):
   *   1. Call parent Error constructor with the error message.
   *   2. Set the error name to "TaskSkippedError" for identification.
   */
  constructor() {
    // Step 1: Call parent Error constructor with the error message
    super("Task skipped by user");
    // Step 2: Set the error name to "TaskSkippedError" for identification
    this.name = "TaskSkippedError";
  }
}
