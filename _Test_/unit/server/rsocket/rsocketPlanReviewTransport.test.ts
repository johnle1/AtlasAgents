/**
 * Unit tests — transport/rsocketPlanReviewTransport.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
  createStreamTransports,
  RSocketPlanReviewTransport,
} from "../../../../packages/server/src/transport/rsocketPlanReviewTransport.js";
import type { TaskFrame } from "../../../../packages/server/src/transport/frames.js";

describe("RSocketPlanReviewTransport", () => {
  it("emits confirm-plan frames from envelopes", () => {
    const frames: TaskFrame[] = [];
    const handlers = { plan: null as ((id: string) => void) | null };
    const transport = new RSocketPlanReviewTransport(
      (frame) => frames.push(frame),
      handlers,
    );

    transport.send({
      type: "confirm-plan",
      id: "plan-1",
      task: "build",
      steps: ["step"],
      risks: ["risk"],
      agents: [],
      agentCount: 1,
      execution: "sequential",
      modeLabel: "fast",
    });

    expect(frames).toEqual([
      {
        kind: "confirm-plan",
        id: "plan-1",
        task: "build",
        steps: ["step"],
        risks: ["risk"],
        agents: [],
        agentCount: 1,
        execution: "sequential",
        modeLabel: "fast",
      },
    ]);
  });

  it("registers and clears plan response handlers", () => {
    const handlers = { plan: null as ((id: string, response: unknown) => void) | null };
    const transport = new RSocketPlanReviewTransport(vi.fn(), handlers);
    const handler = vi.fn();

    const unsubscribe = transport.onResponse(handler);
    expect(handlers.plan).toBe(handler);

    unsubscribe();
    expect(handlers.plan).toBeNull();
  });
});

describe("createStreamTransports", () => {
  it("routes resolvePlan to the registered handler and supports emit rebind", () => {
    const framesA: TaskFrame[] = [];
    const framesB: TaskFrame[] = [];
    const transports = createStreamTransports((frame) => framesA.push(frame));

    const handler = vi.fn();
    transports.plan.onResponse(handler);
    transports.resolvePlan("id-1", { decision: "implement" });

    expect(handler).toHaveBeenCalledWith("id-1", { decision: "implement" });

    transports.rebindEmit((frame) => framesB.push(frame));
    transports.plan.send({
      type: "confirm-plan",
      id: "plan-2",
      task: "t",
      steps: [],
      risks: [],
      agents: [],
      agentCount: 1,
      execution: "sequential",
      modeLabel: null,
    });

    expect(framesA).toHaveLength(0);
    expect(framesB).toHaveLength(1);
    expect(framesB[0]?.kind).toBe("confirm-plan");
  });
});
