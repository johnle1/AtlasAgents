import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../packages/server/src/errors/validationError.js";
import { OllamaError } from "../../../packages/server/src/ollama/types.js";
import {
  enrichOllamaFetchError,
  extractNetworkCause,
  formatOrchestratorFailure,
  isOrchestratorErrorReported,
  markOrchestratorErrorReported,
} from "../../../packages/server/src/orchestration/taskErrors.js";

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
      agentModel: "gemma4:26b",
    });

    expect(formatted).toContain("Task failed during agent planning.");
    expect(formatted).toContain("Agent returned invalid plan JSON");
    expect(formatted).toContain("Agent model: gemma4:26b");
    expect(formatted).not.toContain("Network detail:");
  });

  it("includes the subagent model during the agent.pool phase", () => {
    const error = new Error("subtask execution failed");
    const formatted = formatOrchestratorFailure(error, {
      phase: "agent.pool",
      agentModel: "gemma4:26b",
      subagentModel: "gemma3:4b",
    });

    expect(formatted).toContain("Agent model: gemma4:26b");
    expect(formatted).toContain("Subagent model: gemma3:4b");
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

describe("enrichOllamaFetchError", () => {
  it("passes through OllamaError unchanged", () => {
    const original = new OllamaError(404, "missing");
    expect(
      enrichOllamaFetchError("http://localhost:11434", "chat", "m", original),
    ).toBe(original);
  });

  it("enriches connection refused errors", () => {
    const err = new Error("connect ECONNREFUSED");
    (err as Error & { code: string }).code = "ECONNREFUSED";
    const enriched = enrichOllamaFetchError(
      "http://localhost:11434",
      "chat stream",
      "llama3",
      err,
    );
    expect(enriched.message).toMatch(/Ollama|connect|11434/i);
  });

  it("enriches timeout errors", () => {
    const err = new Error("UND_ERR_HEADERS_TIMEOUT");
    err.name = "TimeoutError";
    const enriched = enrichOllamaFetchError(
      "http://localhost:11434",
      "chat",
      "m",
      err,
    );
    expect(enriched.message).toMatch(/timed out/i);
  });
});

describe("OllamaError", () => {
  it("includes status and truncated body in the message", () => {
    const err = new OllamaError(500, "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(500);
    expect(err.message).toContain("500");
    expect(err.message).toContain("boom");
  });
});
