/**
 * Unit tests — server providers/openAiCompatibleAdapter.ts
 *
 * Covers the SSE streaming parser, fragmented tool-call accumulation (OpenAI
 * splits `arguments` across multiple chunks keyed by `index`), the
 * includeThinking gate on reasoning_content, and error translation to
 * ModelProviderError. `fetch` is injected so no real network calls happen.
 */

import { describe, expect, it } from "vitest";
import { OpenAiCompatibleAdapter } from "../../packages/server/src/providers/openAiCompatibleAdapter.js";
import { ModelProviderError } from "../../packages/server/src/providers/errors.js";
import type { Message } from "../../packages/server/src/orchestration/types.js";

const sseBody = (frames: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const text = frames.map((frame) => `data: ${frame}\n`).join("") + "data: [DONE]\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
};

type FakeResponseInit = {
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array>;
  text?: () => Promise<string>;
};

const fakeFetch = (init: FakeResponseInit): typeof fetch =>
  (async () =>
    ({
      ok: init.ok,
      status: init.status,
      body: init.body,
      text: init.text ?? (async () => ""),
    }) as unknown as Response) as unknown as typeof fetch;

const USER_MESSAGES: Message[] = [{ role: "user", content: "hi" }];

describe("OpenAiCompatibleAdapter.chatStream", () => {
  it("yields content pieces across multiple SSE frames", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
      JSON.stringify({ choices: [{ delta: { content: " world" } }] }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const tokens: string[] = [];
    for await (const token of adapter.chatStream("m", USER_MESSAGES, {
      temperature: 0.1,
    })) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("Hello world");
  });

  it("ignores reasoning_content when includeThinking is not set", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const tokens: string[] = [];
    for await (const token of adapter.chatStream("m", USER_MESSAGES, {
      temperature: 0,
    })) {
      tokens.push(token);
    }

    expect(tokens).toEqual([]);
  });

  it("yields reasoning_content when includeThinking is set", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const tokens: string[] = [];
    for await (const token of adapter.chatStream("m", USER_MESSAGES, {
      temperature: 0,
      includeThinking: true,
    })) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("thinking");
  });

  it("skips malformed SSE frames instead of throwing", async () => {
    const frames = [
      "not json",
      JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const tokens: string[] = [];
    for await (const token of adapter.chatStream("m", USER_MESSAGES, {
      temperature: 0,
    })) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("ok");
  });
});

describe("OpenAiCompatibleAdapter.chat", () => {
  it("accumulates the full chatStream output into one string", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { content: "foo" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "bar" } }] }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const result = await adapter.chat("m", USER_MESSAGES, { temperature: 0 });
    expect(result).toBe("foobar");
  });
});

describe("OpenAiCompatibleAdapter.chatWithTools", () => {
  it("accumulates fragmented tool-call arguments across chunks by index", async () => {
    const frames = [
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: "read_file" } }] } },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }],
            },
          },
        ],
      }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const result = await adapter.chatWithTools(
      "m",
      USER_MESSAGES,
      [],
      { temperature: 0 },
    );

    expect(result.toolCalls).toEqual([
      { name: "read_file", args: { path: "a.ts" } },
    ]);
  });

  it("accumulates content via onToken callback and returns it in content", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
      JSON.stringify({ choices: [{ delta: { content: " world" } }] }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const tokens: string[] = [];
    const result = await adapter.chatWithTools(
      "m",
      USER_MESSAGES,
      [],
      { temperature: 0 },
      (token) => tokens.push(token),
    );

    expect(tokens.join("")).toBe("Hello world");
    expect(result.content).toBe("Hello world");
  });

  it("keeps multiple concurrent tool calls separated by index", async () => {
    const frames = [
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
                { index: 1, function: { name: "run_command", arguments: '{"cmd":"ls"}' } },
              ],
            },
          },
        ],
      }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const result = await adapter.chatWithTools("m", USER_MESSAGES, [], {
      temperature: 0,
    });

    expect(result.toolCalls).toEqual([
      { name: "read_file", args: { path: "a.ts" } },
      { name: "run_command", args: { cmd: "ls" } },
    ]);
  });

  it("falls back to empty args when accumulated JSON is malformed", async () => {
    const frames = [
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: "finish", arguments: "{not json" } }],
            },
          },
        ],
      }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const result = await adapter.chatWithTools("m", USER_MESSAGES, [], {
      temperature: 0,
    });

    expect(result.toolCalls).toEqual([{ name: "finish", args: {} }]);
  });
});

describe("OpenAiCompatibleAdapter error handling", () => {
  it("throws ModelProviderError with the response status on non-2xx", async () => {
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: false, status: 500, text: async () => "boom" }),
    });

    await expect(
      adapter.chat("m", USER_MESSAGES, { temperature: 0 }),
    ).rejects.toThrow(ModelProviderError);

    try {
      await adapter.chat("m", USER_MESSAGES, { temperature: 0 });
      expect.fail("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderError);
      expect((error as InstanceType<typeof ModelProviderError>).status).toBe(500);
    }
  });

  it("throws ModelProviderError when the response has no body", async () => {
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: undefined }),
    });

    await expect(
      adapter.chat("m", USER_MESSAGES, { temperature: 0 }),
    ).rejects.toThrow(ModelProviderError);
  });

  it("wraps a thrown network error into ModelProviderError", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: throwingFetch,
    });

    await expect(
      adapter.chat("m", USER_MESSAGES, { temperature: 0 }),
    ).rejects.toThrow(ModelProviderError);
  });
});
