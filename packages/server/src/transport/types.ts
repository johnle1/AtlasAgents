/**
 * Type definitions for the transport layer.
 *
 * @remarks
 * Consolidates all types used across transport modules for better organization
 * and discoverability.
 */

import type { PlanReviewResponse } from "../orchestration/types.js";
import type { PlanReviewTransport } from "../workspace/review/planReviewBroker.js";
import type { TaskFrame } from "@loopycode/shared";

// Re-export shared types
export type { TaskFrame } from "@loopycode/shared";
export type {
  PlanReviewEnvelope,
  PlanReviewTransport,
} from "../workspace/review/planReviewBroker.js";

/**
 * Internal handlers for stream operations.
 *
 * @remarks
 * Tracks callbacks for different stream kinds (plan review, etc.) to route
 * responses back to the appropriate handler.
 */
export type StreamHandlers = {
  plan: ((id: string, response: PlanReviewResponse) => void) | null;
};

/**
 * RSocket transport implementations for different stream kinds.
 *
 * @remarks
 * Provides specialized transport bridges for each type of server→client stream,
 * along with utility methods to resolve and rebind responses.
 *
 * @example
 * ```ts
 * const transports = createStreamTransports(emit);
 * transports.plan.send(planEnvelope);
 * transports.resolvePlan(id, userResponse);
 * ```
 */
export type RSocketStreamTransports = {
  /** Transport bridge for plan review streams. */
  plan: PlanReviewTransport;

  /**
   * Resolves a pending plan review with the user's response.
   *
   * @param id - Plan review id.
   * @param response - User's approval/rejection and reasoning.
   */
  resolvePlan: (id: string, response: PlanReviewResponse) => void;

  /**
   * Rebinds the emit callback (e.g., when connection parameters change).
   *
   * @param emit - New emit function for sending frames.
   */
  rebindEmit: (emit: (frame: TaskFrame) => void) => void;
};
