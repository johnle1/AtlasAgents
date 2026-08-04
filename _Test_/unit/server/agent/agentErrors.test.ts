/**
 * Unit tests — TaskSkippedError / PlanRevisionRequestedError.
 */

import { describe, expect, it } from "vitest";
import {
  PlanRevisionRequestedError,
  TaskSkippedError,
} from "../../../../packages/server/src/orchestration/agent/agentErrors.js";

describe("TaskSkippedError", () => {
  it("extends Error via super with a fixed message and name", () => {
    const err = new TaskSkippedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TaskSkippedError");
    expect(err.message).toBe("Task skipped by user");
  });
});

describe("PlanRevisionRequestedError", () => {
  it("extends Error via super and exposes feedback", () => {
    const err = new PlanRevisionRequestedError("add tests");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PlanRevisionRequestedError");
    expect(err.message).toBe("Plan revision requested by user");
    expect(err.feedback).toBe("add tests");
  });
});
