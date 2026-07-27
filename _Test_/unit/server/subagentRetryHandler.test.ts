/**
 * Unit tests — subagentRetryHandler messaging for missing tool calls
 */

import { describe, expect, it } from "vitest";
import { handleAgentRetry } from "../../../packages/server/src/orchestration/subagent/subagentRetryHandler.js";

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
});
