/**
 * Cross-Backend Contract Tests
 *
 * Validates the core claim: "Unified internal representation across all backends".
 *
 * Table-driven test suite executed against fixtures modeled on real wire outputs
 * from Ollama, a generic OpenAI-compatible server, and MLX-LM. Asserts that
 * regardless of the backend source, the parsed ChatWithToolsResult and
 * streaming outputs converge to identical internal shapes.
 */

import { describe, expect, it } from "vitest";
import { OpenAiCompatibleAdapter } from "../../../../packages/server/src/providers/openAiCompatibleAdapter.js";
import type { Message } from "../../../../packages/server/src/orchestration/types.js";
import type { ToolSchema } from "../../../../packages/server/src/orchestration/tools/types.js";
import {
  createOllamaOpenAiSseFrames,
  createOpenAiCompatibleTextSseFrames,
  createOpenAiCompatibleToolCallSseFrames,
  createOpenAiCompatibleReasoningSseFrames,
  createMlxlmTextSseFrames,
  createMlxlmToolFallbackSseFrames,
} from "../../../helpers/fixtures/index.js";

const encoder = new TextEncoder();

const sseBody = (frames: string[]): ReadableStream<Uint8Array> => {
  const text = frames.map((frame) => `data: ${frame}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
};

const fakeFetch = (frames: string[]): typeof fetch =>
  (async () =>
    ({
      ok: true,
      status: 200,
      body: sseBody(frames),
      text: async () => "",
    }) as unknown as Response) as unknown as typeof fetch;

const SAMPLE_MESSAGES: Message[] = [
  { role: "user", content: "List the files in the directory" },
];

const SAMPLE_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
        },
        required: ["cmd"],
      },
    },
  },
];

describe("Cross-Backend Contract Tests — Text Streaming (chatStream)", () => {
  const testCases = [
    {
      backend: "Ollama (/v1/chat/completions)",
      frames: createOllamaOpenAiSseFrames(["Here ", "are ", "the files."]),
      expectedOutput: "Here are the files.",
    },
    {
      backend: "OpenAI-compatible server (with usage stats chunk)",
      frames: createOpenAiCompatibleTextSseFrames(["Here ", "are ", "the files."], { includeUsage: true }),
      expectedOutput: "Here are the files.",
    },
    {
      backend: "MLX-LM (minimal Apple Silicon server)",
      frames: createMlxlmTextSseFrames(["Here ", "are ", "the files."]),
      expectedOutput: "Here are the files.",
    },
  ];

  testCases.forEach(({ backend, frames, expectedOutput }) => {
    it(`converges to exact string on ${backend}`, async () => {
      const adapter = new OpenAiCompatibleAdapter("http://localhost:8000/v1", "test-key", {
        fetch: fakeFetch(frames),
      });

      const tokens: string[] = [];
      for await (const token of adapter.chatStream("test-model", SAMPLE_MESSAGES, {
        temperature: 0,
      })) {
        tokens.push(token);
      }

      expect(tokens.join("")).toBe(expectedOutput);
    });

    it(`accumulates to same single string via chat() on ${backend}`, async () => {
      const adapter = new OpenAiCompatibleAdapter("http://localhost:8000/v1", "test-key", {
        fetch: fakeFetch(frames),
      });

      const result = await adapter.chat("test-model", SAMPLE_MESSAGES, { temperature: 0 });
      expect(result).toBe(expectedOutput);
    });
  });
});

describe("Cross-Backend Contract Tests — Tool Invocations (chatWithTools)", () => {
  it("normalizes OpenAI-compatible fragmented multi-turn tool calls into standard OllamaToolCall shape", async () => {
    const frames = createOpenAiCompatibleToolCallSseFrames([
      {
        name: "run_command",
        argChunks: ['{"cmd":', ' "ls ', '-la"}'],
      },
      {
        name: "read_file",
        argChunks: ['{"path":', ' "package', '.json"}'],
      },
    ]);

    const adapter = new OpenAiCompatibleAdapter("http://localhost:8000/v1", "test-key", {
      fetch: fakeFetch(frames),
    });

    const result = await adapter.chatWithTools(
      "test-model",
      SAMPLE_MESSAGES,
      SAMPLE_TOOLS,
      { temperature: 0 },
    );

    expect(result.toolCalls).toEqual([
      { name: "run_command", args: { cmd: "ls -la" } },
      { name: "read_file", args: { path: "package.json" } },
    ]);
  });

  it("handles MLX-LM fallback when backend does not invoke tools and returns plain text", async () => {
    const frames = createMlxlmToolFallbackSseFrames("I don't have tool calling, here is text.");

    const adapter = new OpenAiCompatibleAdapter("http://localhost:8000/v1", "test-key", {
      fetch: fakeFetch(frames),
    });

    const result = await adapter.chatWithTools(
      "test-model",
      SAMPLE_MESSAGES,
      SAMPLE_TOOLS,
      { temperature: 0 },
    );

    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe("I don't have tool calling, here is text.");
  });
});

describe("Cross-Backend Contract Tests — Reasoning & Thinking Tokens", () => {
  it("normalizes reasoning_content channel on reasoning-capable OpenAI-compatible backends", async () => {
    const frames = createOpenAiCompatibleReasoningSseFrames(
      ["Let me think... ", "Checking directory contents."],
      ["Files: file1.txt, file2.txt"],
    );

    const adapter = new OpenAiCompatibleAdapter("http://localhost:8000/v1", "test-key", {
      fetch: fakeFetch(frames),
    });

    const thinkTokens: string[] = [];
    const contentTokens: string[] = [];

    const result = await adapter.chatWithTools(
      "test-model",
      SAMPLE_MESSAGES,
      SAMPLE_TOOLS,
      {
        temperature: 0,
        onThinkToken: (token) => thinkTokens.push(token),
      },
      (token) => contentTokens.push(token),
    );

    expect(result.thinking).toBe("Let me think... Checking directory contents.");
    expect(result.content).toBe("Files: file1.txt, file2.txt");
    expect(thinkTokens).toEqual(["Let me think... ", "Checking directory contents."]);
    expect(contentTokens).toEqual(["Files: file1.txt, file2.txt"]);
  });
});
