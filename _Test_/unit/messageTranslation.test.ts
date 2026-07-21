/**
 * Unit tests — server providers/messageTranslation.ts
 *
 * This is the sharpest edge of the OpenAI-compatible provider path: Ollama's
 * native message shape (object tool_calls, tool_name correlation) must
 * translate losslessly to OpenAI's shape (JSON-string arguments, id-based
 * tool_call_id correlation) so the ReAct loop behaves identically regardless
 * of which provider serves the model.
 */

import { describe, expect, it } from "vitest";
import {
  toOpenAiMessages,
  toOpenAiTools,
} from "../../packages/server/src/providers/messageTranslation.js";
import type { Message } from "../../packages/server/src/orchestration/types.js";
import type { ToolSchema } from "../../packages/server/src/orchestration/tools/types.js";

describe("toOpenAiMessages — plain turns", () => {
  it("passes system/user/assistant text turns through unchanged", () => {
    const messages: Message[] = [
      { role: "system", content: "You are an agent." },
      { role: "user", content: "Do the thing." },
      { role: "assistant", content: "Sure." },
    ];

    expect(toOpenAiMessages(messages)).toEqual([
      { role: "system", content: "You are an agent." },
      { role: "user", content: "Do the thing." },
      { role: "assistant", content: "Sure." },
    ]);
  });
});

describe("toOpenAiMessages — assistant tool calls", () => {
  it("synthesizes an id and stringifies object arguments", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "a.ts" } } },
        ],
      },
    ];

    const [translated] = toOpenAiMessages(messages);
    expect(translated.role).toBe("assistant");
    expect(translated.content).toBeNull();
    expect(translated.tool_calls).toHaveLength(1);
    expect(translated.tool_calls?.[0]?.type).toBe("function");
    expect(translated.tool_calls?.[0]?.function.name).toBe("read_file");
    expect(translated.tool_calls?.[0]?.function.arguments).toBe(
      JSON.stringify({ path: "a.ts" }),
    );
    expect(translated.tool_calls?.[0]?.id).toMatch(/^call_\d+$/);
  });

  it("keeps non-empty content alongside tool_calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "Reading the file first.",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "a.ts" } } },
        ],
      },
    ];

    const [translated] = toOpenAiMessages(messages);
    expect(translated.content).toBe("Reading the file first.");
  });

  it("assigns a unique id per call across multiple tool calls in one turn", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "a.ts" } } },
          { function: { name: "run_command", arguments: { cmd: "ls" } } },
        ],
      },
    ];

    const [translated] = toOpenAiMessages(messages);
    const ids = translated.tool_calls?.map((call) => call.id) ?? [];
    expect(new Set(ids).size).toBe(2);
  });

  it("defaults missing arguments to an empty object", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "finish",
              arguments: undefined as unknown as Record<string, unknown>,
            },
          },
        ],
      },
    ];

    const [translated] = toOpenAiMessages(messages);
    expect(translated.tool_calls?.[0]?.function.arguments).toBe("{}");
  });
});

describe("toOpenAiMessages — tool results", () => {
  it("correlates a tool result to the most recent call id for that tool name", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "a.ts" } } },
        ],
      },
      { role: "tool", content: "file contents", tool_name: "read_file" },
    ];

    const translated = toOpenAiMessages(messages);
    const assistantCallId = translated[0].tool_calls?.[0]?.id;
    const toolResult = translated[1];

    expect(toolResult.role).toBe("tool");
    expect(toolResult.content).toBe("file contents");
    expect(toolResult.tool_call_id).toBe(assistantCallId);
    expect(toolResult.tool_call_id).toBeDefined();
  });

  it("re-correlates to the newer call id after a second call to the same tool", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "a.ts" } } },
        ],
      },
      { role: "tool", content: "first result", tool_name: "read_file" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "b.ts" } } },
        ],
      },
      { role: "tool", content: "second result", tool_name: "read_file" },
    ];

    const translated = toOpenAiMessages(messages);
    const firstCallId = translated[0].tool_calls?.[0]?.id;
    const secondCallId = translated[2].tool_calls?.[0]?.id;

    expect(translated[1].tool_call_id).toBe(firstCallId);
    expect(translated[3].tool_call_id).toBe(secondCallId);
    expect(firstCallId).not.toBe(secondCallId);
  });

  it("falls back to a synthetic id when no prior call matches the tool name", () => {
    const messages: Message[] = [
      { role: "tool", content: "orphaned result", tool_name: "read_file" },
    ];

    const [translated] = toOpenAiMessages(messages);
    expect(translated.tool_call_id).toBe("call_read_file");
  });
});

describe("toOpenAiTools", () => {
  it("wraps tool schemas in the OpenAI function-tool envelope", () => {
    const tools: ToolSchema[] = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Reads a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ];

    expect(toOpenAiTools(tools)).toEqual([
      {
        type: "function",
        function: tools[0].function,
      },
    ]);
  });

  it("returns an empty array for an empty tool list", () => {
    expect(toOpenAiTools([])).toEqual([]);
  });
});
