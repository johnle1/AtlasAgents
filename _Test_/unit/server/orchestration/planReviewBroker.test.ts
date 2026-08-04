/**
 * Unit tests — workspace/review/planReviewBroker.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanReviewBroker } from "../../../../packages/server/src/workspace/review/planReviewBroker.js";
import type { PlanReviewTransport } from "../../../../packages/server/src/workspace/review/planReviewBroker.js";
import type { PlanReviewResponse } from "../../../../packages/server/src/orchestration/types.js";

const makePlanPayload = () => ({
  task: "Run tests",
  steps: ["npm test"],
  risks: [] as string[],
  agents: [],
  agentCount: 1,
  execution: "sequential" as const,
  modeLabel: null,
});

describe("PlanReviewBroker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a plan and resolves when the transport reports a response", async () => {
    // A ref object rather than a `let`: TS narrows a closure-only-assigned
    // `let` back to `null`, which makes the call below non-callable.
    const responseHandler: {
      current: ((id: string, response: PlanReviewResponse) => void) | null;
    } = { current: null };
    const send = vi.fn();
    const transport: PlanReviewTransport = {
      send,
      onResponse: (handler) => {
        responseHandler.current = handler;
        return () => {
          responseHandler.current = null;
        };
      },
    };

    const broker = new PlanReviewBroker({ transport, timeoutMs: 60_000 });
    const pending = broker.request(makePlanPayload());

    expect(send).toHaveBeenCalledTimes(1);
    const envelope = send.mock.calls[0]![0]!;
    expect(envelope.type).toBe("confirm-plan");
    expect(envelope.task).toBe("Run tests");

    responseHandler.current?.(envelope.id, { decision: "implement" });
    await expect(pending).resolves.toEqual({ decision: "implement" });
    broker.dispose();
  });

  it("auto-skips on timeout (clearTimeout path in settle)", async () => {
    vi.useFakeTimers();
    const transport: PlanReviewTransport = {
      send: vi.fn(),
      onResponse: (handler) => () => {
        void handler;
      },
    };

    const broker = new PlanReviewBroker({ transport, timeoutMs: 1_000 });
    const pending = broker.request(makePlanPayload());

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ decision: "skip" });
    broker.dispose();
  });

  it("dispose resolves pending plans with skip", async () => {
    const transport: PlanReviewTransport = {
      send: vi.fn(),
      onResponse: () => () => {},
    };
    const broker = new PlanReviewBroker({ transport });
    const pending = broker.request(makePlanPayload());
    broker.dispose();
    await expect(pending).resolves.toEqual({ decision: "skip" });
  });
});
