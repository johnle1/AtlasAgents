/**
 * Agent-specific error types for planning and execution signals.
 *
 * @remarks
 * Defines controlled cancellation and revision signals that arise during
 * task planning and review. These are not failures but deliberate user decisions.
 * Future agent-specific error types can be added here as the orchestration grows.
 */

/**
 * Thrown when the user skips the task during plan review.
 *
 * @remarks
 * Thrown by `Agent.plan()` when the `reviewPlan` hook returns `{ decision: "skip" }`.
 * This indicates the user reviewed the proposed plan and chose not to proceed.
 * No agents will be started; the task is abandoned.
 *
 * This is a controlled cancellation signal, not a failure. Callers should catch
 * this and report it to the user as "task skipped" rather than as an error.
 *
 * @example
 * ```ts
 * try {
 *   const plan = await agent.plan(task, context, skill);
 * } catch (err) {
 *   if (err instanceof TaskSkippedError) {
 *     console.log("User skipped the task");
 *   }
 * }
 * ```
 */
export class TaskSkippedError extends Error {
  /**
   * Creates a new TaskSkippedError with a fixed message.
   *
   * @remarks
   * The error name is set to "TaskSkippedError" for identification in error handling.
   */
  constructor() {
    super("Task skipped by user");
    this.name = "TaskSkippedError";
  }
}

/**
 * Thrown when the user requests plan revisions during plan review.
 *
 * @remarks
 * Thrown by `Agent.plan()` when the `reviewPlan` hook returns `{ decision: "edit", feedback: "..." }`.
 * Signals that the user reviewed the plan and wants it revised based on their feedback.
 *
 * This is a controlled revision signal, not a failure. The caller should:
 * 1. Catch this error.
 * 2. Fold the feedback into the task text (e.g., via `buildPlanRevisionTask` in agentHelpers).
 * 3. Re-invoke `Agent.plan()` with the updated task.
 *
 * The feedback is provided as a public readonly field for easy access.
 *
 * @example
 * ```ts
 * try {
 *   const plan = await agent.plan(task, context, skill);
 * } catch (err) {
 *   if (err instanceof PlanRevisionRequestedError) {
 *     const revisedTask = buildPlanRevisionTask(task, err.feedback);
 *     const revisedPlan = await agent.plan(revisedTask, context, skill);
 *   }
 * }
 * ```
 */
export class PlanRevisionRequestedError extends Error {
  /**
   * Creates a new PlanRevisionRequestedError with user feedback.
   *
   * @param feedback - Free-text feedback the user provided about the proposed plan.
   *   Typically describes what the user wants changed or clarified.
   *
   * @remarks
   * The error name is set to "PlanRevisionRequestedError" for identification.
   */
  constructor(public readonly feedback: string) {
    super("Plan revision requested by user");
    this.name = "PlanRevisionRequestedError";
  }
}
