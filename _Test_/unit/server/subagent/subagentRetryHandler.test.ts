/**
 * Unit tests — subagentRetryHandler messaging for missing tool calls
 */

import { describe, expect, it } from "vitest";
import { handleAgentRetry } from "../../../../packages/server/src/orchestration/subagent/subagentRetryHandler.js";

describe("handleAgentRetry", () => {
  it("tells the model to emit a real finish tool call, not finish({...}) in action", () => {
    const result = handleAgentRetry(
      "thought about finishing",
      "action: finish\nexits: yes",
      0,
      false,
      0,
      3,
    );

    expect(result.shouldRetry).toBe(true);
    const userMessage = result.updatedMessages.find(
      (message) => message.role === "user",
    );
    expect(userMessage?.content).toContain("<<TOOL>>");
    expect(userMessage?.content).toContain('"tool":"finish"');
    expect(userMessage?.content).not.toContain('finish({"summary"');
  });

  it("rejects action: none with a legacy finish tool example", () => {
    const result = handleAgentRetry(
      "done",
      "action: none",
      0,
      false,
      0,
      3,
    );

    expect(result.shouldRetry).toBe(true);
    const userMessage = result.updatedMessages.find(
      (message) => message.role === "user",
    );
    expect(userMessage?.content).toContain("action: none is not valid");
    expect(userMessage?.content).toContain('"tool":"finish"');
  });

  // Characterization tests: these two branches deliberately never increment
  // thinkRetryCount or set shouldEscalate — a model producing no thinking
  // and no tool call, or a tool call with no thinking, is treated as a
  // one-off format error rather than a reasoning failure that should count
  // toward escalation. That means a model stuck in either shape is bounded
  // only by Subagent's MAX_UNPRODUCTIVE_TURNS breaker (subagent.ts), not by
  // this handler's own budget. Pinned here so nobody "fixes" these into a
  // double-count without also reconsidering the breaker.
  it("never increments or escalates when there is no thinking and no tool call", () => {
    const result = handleAgentRetry("garbled output", null, 0, false, 2, 3);

    expect(result.shouldRetry).toBe(true);
    expect(result.shouldEscalate).toBeFalsy();
    expect(result.updatedThinkRetryCount).toBe(2);
  });

  it("never increments or escalates when a tool call arrives with no thinking block", () => {
    const result = handleAgentRetry("garbled output", null, 1, false, 2, 3);

    expect(result.shouldRetry).toBe(true);
    expect(result.shouldEscalate).toBeFalsy();
    expect(result.updatedThinkRetryCount).toBe(2);
  });
});
