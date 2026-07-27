/**
 * RSocket transport adapters for streaming task execution.
 *
 * @remarks
 * Implements transport bridges for server→client streams (plan reviews, etc),
 * managing frame emission and response routing with callback injection.
 */

import type { PlanReviewResponse } from "../orchestration/types.js";
import type {
  PlanReviewEnvelope,
  PlanReviewTransport,
} from "../workspace/review/planReviewBroker.js";
import type { TaskFrame, StreamHandlers, RSocketStreamTransports } from "./types.js";

/**
 * Factory function that creates bidirectional transport bindings for all stream kinds.
 *
 * @param emit - Callback to send frames to the client.
 * @returns Transport implementations and routing methods.
 */
export const createStreamTransports = (
  emit: (frame: TaskFrame) => void,
): RSocketStreamTransports => {
  const handlers: StreamHandlers = { plan: null };
  const emitHolder = { fn: emit };
  const boundEmit = (frame: TaskFrame): void => {
    emitHolder.fn(frame);
  };
  return {
    plan: new RSocketPlanReviewTransport(boundEmit, handlers),
    resolvePlan: (id, response) => {
      handlers.plan?.(id, response);
    },
    rebindEmit: (nextEmit) => {
      emitHolder.fn = nextEmit;
    },
  };
};

/**
 * Implements plan review transport via task stream frames.
 *
 * @remarks
 * Converts plan review envelopes into TaskFrames and routes client responses
 * through registered handlers.
 */
export class RSocketPlanReviewTransport implements PlanReviewTransport {
  constructor(
    private readonly emit: (frame: TaskFrame) => void,
    private readonly handlers: StreamHandlers,
  ) {}

  /**
   * Sends a plan review to the client as a task frame.
   */
  send = (envelope: PlanReviewEnvelope): void => {
    this.emit({
      kind: "confirm-plan",
      id: envelope.id,
      task: envelope.task,
      steps: envelope.steps,
      risks: envelope.risks,
      agents: envelope.agents,
      agentCount: envelope.agentCount,
      execution: envelope.execution,
      modeLabel: envelope.modeLabel,
    });
  };

  /**
   * Registers a handler for plan review responses from the client.
   *
   * @param handler - Called when the client responds to a plan review.
   * @returns Unsubscribe function to remove the handler.
   */
  onResponse = (
    handler: (id: string, response: PlanReviewResponse) => void,
  ): (() => void) => {
    this.handlers.plan = handler;
    return () => {
      if (this.handlers.plan === handler) {
        this.handlers.plan = null;
      }
    };
  };
}
