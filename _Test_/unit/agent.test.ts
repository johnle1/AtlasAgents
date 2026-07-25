/**
 * Unit tests — server orchestration/agent/agent.ts (plan + search tools)
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../../packages/server/src/errors/validationError.js";
import { Agent } from "../../packages/server/src/orchestration/agent/agent.js";
import { MAX_AGENT_SEARCH_CALLS } from "../../packages/server/src/orchestration/agent/agentConstants.js";
import {
  EXPLORE_CODEBASE_TOOL_NAME,
  SUBMIT_PLAN_TOOL,
  SUBMIT_PLAN_TOOL_NAME,
} from "../../packages/server/src/orchestration/agent/agentTools.js";
import type {
  IConfigManager,
  IOllamaClient,
} from "../../packages/server/src/orchestration/interfaces.js";
import type { ToolSchema } from "../../packages/server/src/orchestration/tools/types.js";
import type { Message } from "../../packages/server/src/orchestration/types.js";

const VALID_THINK_BLOCK = `<agent-think>
COMPLEXITY: simple
  reasoning: fix one bug with tests

UNDERSTAND:
  literal: fix bug
  actual: fix bug
  implicit: none

EXPLORATION:
  need explore? no
  if no: typescript monorepo with _Test_/ vitest suite

PLAN:
  agent count: 1
  execution: sequential

  Agent 1 — implementation:
    1. do work

SELF-CHECK:
  issues? none
  file conflicts? none
  wave assumptions? none

COMMAND PLAN:
  setup commands: none
  verify commands: npm test
</agent-think>`;

const VALID_PLAN_ARGS = {
  subtasks: [
    {
      id: 1,
      text: "do work",
      dependsOn: [],
      agentId: 1,
      agentLabel: "implementation",
    },
  ],
  execution: "sequential",
  agentCount: 1,
  risks: [] as string[],
};

const SEARCH_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: "tokensave_search",
    description: "Search the codebase",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

const mockConfig = {
  getAgentModel: async () => "test-agent",
  getAgentTemperature: async () => 0,
  getAgentModelSupportsTools: async () => true,
} as unknown as IConfigManager;

const createAgent = (ollama: IOllamaClient): Agent =>
  new Agent({ ollama, config: mockConfig });

describe("Agent.plan search tools", () => {
  it("plans on first turn when no searchTools are provided", async () => {
    let chatCallCount = 0;
    const ollama = {
      chatWithTools: async () => {
        chatCallCount += 1;
        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const agent = createAgent(ollama);
    const plan = await agent.plan("fix the bug", "", "");

    expect(chatCallCount).toBe(1);
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("executes a search tool before proposing a plan", async () => {
    let chatCallCount = 0;
    let searchInvoked = false;
    const toolMessages: string[] = [];
    const ollama = {
      chatWithTools: async (
        _model: string,
        messages: Message[],
        tools: ToolSchema[],
      ) => {
        chatCallCount += 1;
        if (chatCallCount === 1) {
          expect(
            tools.some((tool) => tool.function.name === "tokensave_search"),
          ).toBe(true);
          return {
            content: "",
            toolCalls: [
              { name: "tokensave_search", args: { query: "orchestrator" } },
            ],
          };
        }

        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === "tool") {
          toolMessages.push(lastMessage.content);
        }

        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const agent = createAgent(ollama);
    const plan = await agent.plan("fix the bug", "", "", undefined, {
      searchTools: [SEARCH_TOOL],
      callSearchTool: async (name, args) => {
        searchInvoked = true;
        expect(name).toBe("tokensave_search");
        expect(args).toEqual({ query: "orchestrator" });
        return { isError: false, data: "packages/server/src/orchestrator" };
      },
    });

    expect(chatCallCount).toBe(2);
    expect(searchInvoked).toBe(true);
    expect(toolMessages.some((text) => text.includes("orchestrator"))).toBe(
      true,
    );
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("executes explore_codebase before proposing a plan", async () => {
    let chatCallCount = 0;
    let exploreInvoked = false;
    const toolMessages: string[] = [];
    const ollama = {
      chatWithTools: async (
        _model: string,
        messages: Message[],
        tools: ToolSchema[],
      ) => {
        chatCallCount += 1;
        if (chatCallCount === 1) {
          expect(
            tools.some((tool) => tool.function.name === EXPLORE_CODEBASE_TOOL_NAME),
          ).toBe(true);
          return {
            content: "",
            toolCalls: [
              {
                name: EXPLORE_CODEBASE_TOOL_NAME,
                args: { reason: "unknown stack" },
              },
            ],
          };
        }

        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === "tool") {
          toolMessages.push(lastMessage.content);
        }

        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const agent = createAgent(ollama);
    const plan = await agent.plan("add world time display", "", "", undefined, {
      exploreCodebase: async () => {
        exploreInvoked = true;
        return {
          snapshot: "Structure:\npackages/\n_Test_/\n",
        };
      },
    });

    expect(chatCallCount).toBe(2);
    expect(exploreInvoked).toBe(true);
    expect(toolMessages.some((text) => text.includes("_Test_/"))).toBe(true);
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("stops offering search tools after the search budget is exhausted", async () => {
    let chatCallCount = 0;
    const toolsPerCall: string[][] = [];

    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: Message[],
        tools: ToolSchema[],
      ) => {
        chatCallCount += 1;
        toolsPerCall.push(tools.map((tool) => tool.function.name));

        if (chatCallCount <= MAX_AGENT_SEARCH_CALLS) {
          return {
            content: "",
            toolCalls: [
              {
                name: "tokensave_search",
                args: { query: `q${chatCallCount}` },
              },
            ],
          };
        }

        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const agent = createAgent(ollama);
    await agent.plan("fix the bug", "", "", undefined, {
      searchTools: [SEARCH_TOOL],
      callSearchTool: async () => ({
        isError: false,
        data: "hit",
      }),
    });

    expect(chatCallCount).toBe(MAX_AGENT_SEARCH_CALLS + 1);
    expect(toolsPerCall[0]).toEqual(["submit_plan", "tokensave_search"]);
    expect(toolsPerCall[MAX_AGENT_SEARCH_CALLS]).toEqual(["submit_plan"]);
    expect(toolsPerCall[MAX_AGENT_SEARCH_CALLS]?.length).toBe(1);
    expect(toolsPerCall[MAX_AGENT_SEARCH_CALLS]?.[0]).toBe(
      SUBMIT_PLAN_TOOL.function.name,
    );
  });

  it("propagates search tool errors into tool messages", async () => {
    let chatCallCount = 0;
    const toolMessages: string[] = [];
    const ollama = {
      chatWithTools: async (
        _model: string,
        messages: Message[],
        _tools: ToolSchema[],
      ) => {
        chatCallCount += 1;
        if (chatCallCount === 1) {
          return {
            content: "",
            toolCalls: [
              { name: "tokensave_search", args: { query: "missing" } },
            ],
          };
        }
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === "tool") {
          toolMessages.push(lastMessage.content);
        }
        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    await createAgent(ollama).plan("fix the bug", "", "", undefined, {
      searchTools: [SEARCH_TOOL],
      callSearchTool: async () => ({
        isError: true,
        errorMessage: "index not found",
      }),
    });

    expect(toolMessages.some((text) => text.includes("[tokensave error]"))).toBe(
      true,
    );
    expect(toolMessages.some((text) => text.includes("index not found"))).toBe(
      true,
    );
  });

  it("uses unknown error fallback when search returns isError without errorMessage", async () => {
    const toolMessages: string[] = [];
    let chatCallCount = 0;
    const ollama = {
      chatWithTools: async (
        _model: string,
        messages: Message[],
        _tools: ToolSchema[],
      ) => {
        chatCallCount += 1;
        if (chatCallCount === 1) {
          return {
            content: "",
            toolCalls: [{ name: "tokensave_search", args: { query: "x" } }],
          };
        }
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === "tool") {
          toolMessages.push(lastMessage.content);
        }
        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    await createAgent(ollama).plan("fix the bug", "", "", undefined, {
      searchTools: [SEARCH_TOOL],
      callSearchTool: async () => ({ isError: true }),
    });

    expect(toolMessages.some((text) => text.includes("unknown error"))).toBe(
      true,
    );
  });

  it("supports multiple searches before proposing a plan", async () => {
    let chatCallCount = 0;
    const searchQueries: string[] = [];
    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: Message[],
        _tools: ToolSchema[],
      ) => {
        chatCallCount += 1;
        if (chatCallCount <= 2) {
          return {
            content: "",
            toolCalls: [
              {
                name: "tokensave_search",
                args: { query: `q${chatCallCount}` },
              },
            ],
          };
        }
        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const plan = await createAgent(ollama).plan("fix the bug", "", "", undefined, {
      searchTools: [SEARCH_TOOL],
      callSearchTool: async (_name, args) => {
        searchQueries.push(String(args.query));
        return { isError: false, data: "hit" };
      },
    });

    expect(chatCallCount).toBe(3);
    expect(searchQueries).toEqual(["q1", "q2"]);
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("includes AGENT_RETRIEVAL_RULES in system prompt when searchTools are provided", async () => {
    let systemPrompt = "";
    const ollama = {
      chatWithTools: async (
        _model: string,
        messages: Message[],
        _tools: ToolSchema[],
      ) => {
        systemPrompt = messages[0]?.content ?? "";
        return {
          content: VALID_THINK_BLOCK,
          toolCalls: [{ name: "submit_plan", args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    await createAgent(ollama).plan("fix the bug", "", "", undefined, {
      searchTools: [SEARCH_TOOL],
      callSearchTool: async () => ({ isError: false, data: "ok" }),
    });

    expect(systemPrompt).toContain("AGENT RETRIEVAL RULES");
    expect(systemPrompt).toContain("tokensave_search");
  });
});

describe("Agent.plan without native tool support", () => {
  it("uses chatStream and parses inline JSON when submit_plan tool is unavailable", async () => {
    let chatWithToolsCalled = false;
    let chatStreamCalled = false;
    let systemPrompt = "";

    const inlinePlanJson = JSON.stringify(VALID_PLAN_ARGS);
    const ollama = {
      chatWithTools: async () => {
        chatWithToolsCalled = true;
        return { content: "", toolCalls: [] };
      },
      chatStream: async function* (
        _model: string,
        messages: Message[],
      ): AsyncGenerator<string> {
        chatStreamCalled = true;
        systemPrompt = messages[0]?.content ?? "";
        yield `${VALID_THINK_BLOCK}\n${inlinePlanJson}`;
      },
    } as unknown as IOllamaClient;

    const config = {
      getAgentModel: async () => "gemma4:12b",
      getAgentTemperature: async () => 0,
      getAgentModelSupportsTools: async () => false,
    } as unknown as IConfigManager;

    const agent = new Agent({ ollama, config });
    const plan = await agent.plan("fix the bug", "", "", undefined, {
      searchTools: [SEARCH_TOOL],
      callSearchTool: async () => ({ isError: false, data: "hit" }),
    });

    expect(chatWithToolsCalled).toBe(false);
    expect(chatStreamCalled).toBe(true);
    expect(systemPrompt).not.toContain("AGENT RETRIEVAL RULES");
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("parses trailing-comma JSON from chatStream output", async () => {
    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        yield `${VALID_THINK_BLOCK}\n{"subtasks":[{"id":1,"text":"do work","dependsOn":[],},],"execution":"sequential",}`;
      },
    } as unknown as IOllamaClient;

    const config = {
      getAgentModel: async () => "gemma4:26b",
      getAgentTemperature: async () => 0,
      getAgentModelSupportsTools: async () => false,
    } as unknown as IConfigManager;

    const plan = await new Agent({ ollama, config }).plan("fix the bug", "", "");
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("builds a plan from redacted_thinking when JSON is missing", async () => {
    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        yield `<think>
PLAN:
  agent count: 1
  execution: sequential

  Agent 1 — implementation:
    1. inspect failing test
    2. apply fix

SELF-CHECK:
  issues? none

COMMAND PLAN:
  setup commands: none
  verify commands: npm test
</think>`;
      },
    } as unknown as IOllamaClient;

    const config = {
      getAgentModel: async () => "gemma4:26b",
      getAgentTemperature: async () => 0,
      getAgentModelSupportsTools: async () => false,
    } as unknown as IConfigManager;

    const plan = await new Agent({ ollama, config }).plan("fix the bug", "", "");
    expect(plan.subtasks.length).toBeGreaterThanOrEqual(1);
    expect(plan.subtasks[0]?.text).toContain("inspect failing test");
  });

  it("passes includeThinking to chatStream for reasoning models", async () => {
    let includeThinking = false;
    const inlinePlanJson = JSON.stringify(VALID_PLAN_ARGS);
    const ollama = {
      chatStream: async function* (
        _model: string,
        _messages: Message[],
        options: { temperature: number; includeThinking?: boolean },
      ): AsyncGenerator<string> {
        includeThinking = options.includeThinking === true;
        yield `${VALID_THINK_BLOCK}\n${inlinePlanJson}`;
      },
    } as unknown as IOllamaClient;

    const config = {
      getAgentModel: async () => "gemma4:26b",
      getAgentTemperature: async () => 0,
      getAgentModelSupportsTools: async () => false,
    } as unknown as IConfigManager;

    const plan = await new Agent({ ollama, config }).plan("fix the bug", "", "");
    expect(includeThinking).toBe(true);
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("parses plan from chatStream when output arrives only via thinking channel", async () => {
    const inlinePlanJson = JSON.stringify(VALID_PLAN_ARGS);
    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        yield `${VALID_THINK_BLOCK}\n${inlinePlanJson}`;
      },
    } as unknown as IOllamaClient;

    const config = {
      getAgentModel: async () => "gemma4:26b",
      getAgentTemperature: async () => 0,
      getAgentModelSupportsTools: async () => false,
    } as unknown as IConfigManager;

    const plan = await new Agent({ ollama, config }).plan("fix the bug", "", "");
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("throws a distinct empty-response error when chatStream yields nothing", async () => {
    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        // simulate reasoning model with no captured output
      },
    } as unknown as IOllamaClient;

    const config = {
      getAgentModel: async () => "gemma4:26b",
      getAgentTemperature: async () => 0,
      getAgentModelSupportsTools: async () => false,
    } as unknown as IConfigManager;

    await expect(
      new Agent({ ollama, config }).plan("fix the bug", "", ""),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain(
        "returned an empty response",
      );
      expect((error as ValidationError).message).toContain("gemma4:26b");
      expect((error as ValidationError).message).not.toContain(
        "invalid plan JSON",
      );
      return true;
    });
  });
});

describe("Agent.plan with reasoning output via chatWithTools", () => {
  it("uses thinking when content is empty", async () => {
    const inlinePlanJson = JSON.stringify(VALID_PLAN_ARGS);
    const ollama = {
      chatWithTools: async () => ({
        content: "",
        thinking: `${VALID_THINK_BLOCK}\n${inlinePlanJson}`,
        toolCalls: [{ name: SUBMIT_PLAN_TOOL_NAME, args: VALID_PLAN_ARGS }],
      }),
    } as unknown as IOllamaClient;

    const plan = await createAgent(ollama).plan("fix the bug", "", "");
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("passes includeThinking to chatWithTools for reasoning models", async () => {
    let includeThinking = false;
    const ollama = {
      chatWithTools: async (
        _model: string,
        _messages: Message[],
        _tools: unknown[],
        options: { temperature: number; includeThinking?: boolean },
      ) => {
        includeThinking = options.includeThinking === true;
        return {
          content: "",
          thinking: `${VALID_THINK_BLOCK}`,
          toolCalls: [{ name: SUBMIT_PLAN_TOOL_NAME, args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const plan = await createAgent(ollama).plan("fix the bug", "", "");
    expect(includeThinking).toBe(true);
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("does not re-prompt when SELF-CHECK notes an applied fix with [added ...]", async () => {
    let chatCallCount = 0;
    const thinkWithAppliedFix = VALID_THINK_BLOCK.replace(
      "issues? none",
      "issues? [added verify step to COMMAND PLAN]",
    );
    const ollama = {
      chatWithTools: async () => {
        chatCallCount += 1;
        return {
          content: thinkWithAppliedFix,
          thinking: "",
          toolCalls: [{ name: SUBMIT_PLAN_TOOL_NAME, args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const plan = await createAgent(ollama).plan("fix the bug", "", "");
    expect(chatCallCount).toBe(1);
    expect(plan.subtasks[0]?.text).toBe("do work");
  });

  it("recovers when a turn returns conversational prose instead of a plan", async () => {
    let chatCallCount = 0;
    const ollama = {
      chatWithTools: async (
        _model: string,
        messages: Message[],
      ) => {
        chatCallCount += 1;
        if (chatCallCount === 1) {
          return {
            content:
              "The user is pointing out that my SELF-CHECK section was still not quite right.",
            thinking: "",
            toolCalls: [],
          };
        }

        const lastUser = [...messages]
          .reverse()
          .find((message) => message.role === "user");
        expect(lastUser?.content).toContain("Do not explain");

        return {
          content: VALID_THINK_BLOCK,
          thinking: "",
          toolCalls: [{ name: SUBMIT_PLAN_TOOL_NAME, args: VALID_PLAN_ARGS }],
        };
      },
    } as unknown as IOllamaClient;

    const plan = await createAgent(ollama).plan("fix the bug", "", "");
    expect(chatCallCount).toBe(2);
    expect(plan.subtasks[0]?.text).toBe("do work");
  });
});
