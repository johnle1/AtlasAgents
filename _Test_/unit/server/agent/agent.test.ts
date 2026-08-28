/**
 * Unit tests — server orchestration/agent/agent.ts
 *
 * @remarks
 * Covers what remains of the `Agent` class now that planning lives in
 * `agentTurn.ts`: `advise()` (escalation guidance, still called live by
 * `escalateHandler.ts` for a subagent dispatched via `run_steps_parallel`)
 * and `combine()` (multi-result synthesis — not currently wired into the
 * default pipeline, but a tested, documented extension point).
 */

import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../../../packages/server/src/orchestration/agent/agent.js";
import type {
  IConfigManager,
  IOllamaClient,
} from "../../../../packages/server/src/orchestration/interfaces.js";
import type { Message } from "../../../../packages/server/src/orchestration/types.js";

const mockConfig = {
  getAgentModel: async () => "test-agent",
  getAgentTemperature: async () => 0,
} as unknown as IConfigManager;

const createAgent = (ollama: IOllamaClient): Agent =>
  new Agent({ ollama, config: mockConfig });

describe("Agent.advise", () => {
  it("sends the subtask, reason, and flattened history to the model and returns its guidance", async () => {
    const chat = vi.fn(async () => "Install Jest: npm install --save-dev jest");
    const agent = createAgent({ chat } as unknown as IOllamaClient);

    const history: Message[] = [
      { role: "user", content: "Write unit tests for the login module" },
      { role: "assistant", content: "Trying to find a test runner..." },
    ];

    const guidance = await agent.advise(
      "Write unit tests for the login module",
      "Test framework not installed; unclear which to use",
      history,
    );

    expect(guidance).toBe("Install Jest: npm install --save-dev jest");
    expect(chat).toHaveBeenCalledTimes(1);
    const [model, messages] = chat.mock.calls[0]!;
    expect(model).toBe("test-agent");
    const userMessage = messages.find((m: Message) => m.role === "user");
    expect(userMessage?.content).toContain("Write unit tests for the login module");
    expect(userMessage?.content).toContain(
      "Test framework not installed; unclear which to use",
    );
    expect(userMessage?.content).toContain("Trying to find a test runner");
  });

  it("uses per-task model/temperature overrides when provided", async () => {
    const chat = vi.fn(async () => "guidance");
    const agent = createAgent({ chat } as unknown as IOllamaClient);

    await agent.advise("subtask", "reason", [], {
      agentModel: "override-model",
      agentTemp: 0.9,
    });

    const [model, , options] = chat.mock.calls[0]!;
    expect(model).toBe("override-model");
    expect(options.temperature).toBe(0.9);
  });
});

describe("Agent.combine", () => {
  it("streams tokens from a system+user prompt built from the results", async () => {
    const chatStream = vi.fn(async function* () {
      yield "Both ";
      yield "changes landed.";
    });
    const agent = createAgent({ chatStream } as unknown as IOllamaClient);

    const tokens: string[] = [];
    for await (const token of agent.combine("Ship the feature", [
      { id: 1, content: "Wrote the backend endpoint" },
      { id: 2, content: "Wrote the frontend form" },
    ])) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("Both changes landed.");
    expect(chatStream).toHaveBeenCalledTimes(1);
    const [model, messages] = chatStream.mock.calls[0]!;
    expect(model).toBe("test-agent");
    const userMessage = messages.find((m: Message) => m.role === "user");
    expect(userMessage?.content).toContain("Ship the feature");
    expect(userMessage?.content).toContain("Wrote the backend endpoint");
    expect(userMessage?.content).toContain("Wrote the frontend form");
  });

  it("yields nothing for an empty result list without throwing", async () => {
    const chatStream = vi.fn(async function* () {});
    const agent = createAgent({ chatStream } as unknown as IOllamaClient);

    const tokens: string[] = [];
    for await (const token of agent.combine("task", [])) {
      tokens.push(token);
    }

    expect(tokens).toEqual([]);
  });
});
