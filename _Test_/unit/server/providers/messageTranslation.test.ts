/**
 * Unit tests — server providers/messageTranslation.ts
 *
 * Tests the translation layer between AtlasAgents internal Message/Tool types
 * and OpenAI-compatible `/v1/chat/completions` request wire formats.
 */

import { describe, expect, it } from "vitest";
import {
  toOpenAiMessages,
  toOpenAiTools,
} from "../../../../packages/server/src/providers/messageTranslation.js";
import type { Message } from "../../../../packages/server/src/orchestration/types.js";
import type { ToolSchema } from "../../../../packages/server/src/orchestration/tools/types.js";

describe("toOpenAiMessages", () => {
  it("translates user and system messages unchanged", () => {
    const messages: Message[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
    ];

    const result = toOpenAiMessages(messages);
    expect(result).toEqual([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
    ]);
  });

  it("sets content to null for assistant messages with tool calls and empty content", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "read_file",
              arguments: { path: "src/index.ts" },
            },
          },
        ],
      },
    ];

    const result = toOpenAiMessages(messages);
    expect(result[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "src/index.ts" }),
          },
        },
      ],
    });
  });

  it("preserves assistant content when non-empty alongside tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "I will read the file for you.",
        tool_calls: [
          {
            function: {
              name: "read_file",
              arguments: { path: "package.json" },
            },
          },
        ],
      },
    ];

    const result = toOpenAiMessages(messages);
    expect(result[0].content).toBe("I will read the file for you.");
    expect(result[0].tool_calls?.[0].id).toBe("call_1");
  });

  it("correlates role: 'tool' message with synthesized tool_call_id", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "exec_cmd",
              arguments: { cmd: "ls" },
            },
          },
        ],
      },
      {
        role: "tool",
        tool_name: "exec_cmd",
        content: "file1.txt\nfile2.txt",
      },
    ];

    const result = toOpenAiMessages(messages);
    expect(result[0].tool_calls?.[0].id).toBe("call_1");
    expect(result[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "file1.txt\nfile2.txt",
    });
  });

  it("handles multi-turn tool calling with incrementing call IDs", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "toolA", arguments: { a: 1 } } },
          { function: { name: "toolB", arguments: { b: 2 } } },
        ],
      },
      {
        role: "tool",
        tool_name: "toolA",
        content: "result A",
      },
      {
        role: "tool",
        tool_name: "toolB",
        content: "result B",
      },
    ];

    const result = toOpenAiMessages(messages);
    expect(result[0].tool_calls?.[0].id).toBe("call_1");
    expect(result[0].tool_calls?.[1].id).toBe("call_2");
    expect(result[1].tool_call_id).toBe("call_1");
    expect(result[2].tool_call_id).toBe("call_2");
  });

  it("falls back to synthesized tool_call_id when tool result has no prior call", () => {
    const messages: Message[] = [
      {
        role: "tool",
        tool_name: "unmatched_tool",
        content: "some result",
      },
      {
        role: "tool",
        content: "missing tool_name",
      },
    ];

    const result = toOpenAiMessages(messages);
    expect(result[0].tool_call_id).toBe("call_unmatched_tool");
    expect(result[1].tool_call_id).toBe("call_unknown");
  });

  it("handles undefined or empty arguments in tool call gracefully", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "ping",
              arguments: undefined as unknown as Record<string, unknown>,
            },
          },
        ],
      },
    ];

    const result = toOpenAiMessages(messages);
    expect(result[0].tool_calls?.[0].function.arguments).toBe("{}");
  });
});

describe("toOpenAiTools", () => {
  it("wraps ToolSchema array into OpenAI function tool definitions", () => {
    const tools: ToolSchema[] = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Fetch weather for location",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
        },
      },
    ];

    const result = toOpenAiTools(tools);
    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Fetch weather for location",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
        },
      },
    ]);
  });

  it("returns empty array when no tools are given", () => {
    expect(toOpenAiTools([])).toEqual([]);
  });
});
