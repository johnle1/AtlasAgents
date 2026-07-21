import { describe, expect, it } from "vitest";
import { ValidationError } from "../../packages/server/src/errors/validationError.js";
import {
  extractNetworkCause,
  formatOrchestratorFailure,
  isOrchestratorErrorReported,
  markOrchestratorErrorReported,
} from "../../packages/server/src/orchestration/taskErrors.js";

describe("extractNetworkCause", () => {
  it("does not treat AppError codes as network causes", () => {
    const error = new ValidationError("Agent returned invalid plan JSON");
    expect(extractNetworkCause(error)).toBeNull();
  });

  it("still reports errno-style network error codes", () => {
    const networkError = new Error("Connection refused");
    (networkError as Error & { code: string }).code = "ECONNREFUSED";
    expect(extractNetworkCause(networkError)).toBe(
      "ECONNREFUSED: Connection refused",
    );
  });
});

describe("formatOrchestratorFailure", () => {
  it("omits Network detail for validation failures", () => {
    const error = new ValidationError("Agent returned invalid plan JSON");
    const formatted = formatOrchestratorFailure(error, {
      phase: "agent.plan",
      subagentModel: "gemma4:26b",
    });

    expect(formatted).toContain("Task failed during agent planning.");
    expect(formatted).toContain("Agent returned invalid plan JSON");
    expect(formatted).toContain("Agent model: gemma4:26b");
    expect(formatted).not.toContain("Network detail:");
  });
});

describe("orchestrator error reporting marker", () => {
  it("marks and detects reported orchestrator errors", () => {
    const error = new Error("boom");
    expect(isOrchestratorErrorReported(error)).toBe(false);
    markOrchestratorErrorReported(error);
    expect(isOrchestratorErrorReported(error)).toBe(true);
  });
});
