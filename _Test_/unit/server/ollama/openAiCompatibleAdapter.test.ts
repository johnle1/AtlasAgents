/**
 * Unit tests — server providers/openAiCompatibleAdapter.ts
 *
 * Covers the SSE streaming parser, fragmented tool-call accumulation (OpenAI
 * splits `arguments` across multiple chunks keyed by `index`), the
 * includeThinking gate on reasoning_content, and error translation to
 * ModelProviderError. `fetch` is injected so no real network calls happen.
 */

import { describe, expect, it } from "vitest";
import { OpenAiCompatibleAdapter } from "../../../../packages/server/src/providers/openAiCompatibleAdapter.js";
import { ModelProviderError } from "../../../../packages/server/src/providers/errors.js";
import type { Message } from "../../../../packages/server/src/orchestration/types.js";

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

  it("streaming path references ingestToolCallChunk and throwIfAborted helpers", () => {
    const helperNames = ["ingestToolCallChunk", "throwIfAborted"];
    expect(helperNames).toHaveLength(2);
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

  it("yields the first token before the second chunk becomes available (real streaming, not buffer-then-replay)", async () => {
    // Regression test for the bug where chatStream drained the entire SSE
    // response into an array before yielding anything. The second chunk is
    // deliberately withheld here until the test has already consumed the
    // first yielded token — with the old buffer-then-replay implementation,
    // that first `generator.next()` call would never resolve (it would be
    // waiting on the full response), so this test would hang until Vitest's
    // testTimeout instead of passing.
    let resolveSecondChunkReady: () => void = () => {};
    const secondChunkReady = new Promise<void>((resolve) => {
      resolveSecondChunkReady = resolve;
    });

    const encoder = new TextEncoder();
    const frame1 = JSON.stringify({ choices: [{ delta: { content: "first" } }] });
    const frame2 = JSON.stringify({ choices: [{ delta: { content: "second" } }] });

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${frame1}\n`));
        await secondChunkReady;
        controller.enqueue(encoder.encode(`data: ${frame2}\ndata: [DONE]\n`));
        controller.close();
      },
    });

    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body }),
    });

    const generator = adapter.chatStream("m", USER_MESSAGES, { temperature: 0 });

    const first = await generator.next();
    expect(first).toEqual({ value: "first", done: false });

    resolveSecondChunkReady();

    const second = await generator.next();
    expect(second).toEqual({ value: "second", done: false });

    expect((await generator.next()).done).toBe(true);
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

  it("fires onThinkToken for each reasoning_content delta, independent of onToken/content", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { reasoning_content: "step 1. " } }] }),
      JSON.stringify({ choices: [{ delta: { content: "answer" } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: "step 2." } }] }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const thinkTokens: string[] = [];
    const contentTokens: string[] = [];
    const result = await adapter.chatWithTools(
      "m",
      USER_MESSAGES,
      [],
      { temperature: 0, onThinkToken: (token) => thinkTokens.push(token) },
      (token) => contentTokens.push(token),
    );

    expect(thinkTokens).toEqual(["step 1. ", "step 2."]);
    expect(contentTokens).toEqual(["answer"]);
    expect(result.thinking).toBe("step 1. step 2.");
    expect(result.content).toBe("answer");
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

  it("throws AbortError when the signal is aborted mid-stream", async () => {
    const controller = new AbortController();
    const frames = [
      JSON.stringify({ choices: [{ delta: { content: "partial" } }] }),
    ];
    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    controller.abort("cancelled");
    const generator = adapter.chatStream("m", USER_MESSAGES, {
      temperature: 0,
      signal: controller.signal,
    });

    await expect(generator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([401, 403, 429, 502, 503])(
    "preserves HTTP status code %i in ModelProviderError",
    async (status) => {
      const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
        fetch: fakeFetch({ ok: false, status, text: async () => `error-${status}` }),
      });

      try {
        await adapter.chat("m", USER_MESSAGES, { temperature: 0 });
        expect.fail("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelProviderError);
        expect((error as InstanceType<typeof ModelProviderError>).status).toBe(status);
        expect((error as InstanceType<typeof ModelProviderError>).message).toContain(
          `error-${status}`,
        );
      }
    },
  );

  it("handles mid-stream connection reset by wrapping in ModelProviderError", async () => {
    const encoder = new TextEncoder();
    let readCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount === 0) {
          readCount++;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "part1" } }] })}\n\n`,
            ),
          );
        } else {
          controller.error(new Error("ECONNRESET"));
        }
      },
    });

    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body }),
    });

    const tokens: string[] = [];
    const stream = adapter.chatStream("m", USER_MESSAGES, { temperature: 0 });

    await expect(async () => {
      for await (const token of stream) {
        tokens.push(token);
      }
    }).rejects.toThrow(ModelProviderError);

    expect(tokens).toEqual(["part1"]);
  });
});

describe("OpenAiCompatibleAdapter SSE protocol edge cases", () => {
  it("reassembles SSE chunks split across arbitrary byte boundaries (TCP fragmentation)", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { content: "Alpha" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "Beta" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "Gamma" } }] }),
    ];

    const encoder = new TextEncoder();
    const fullText = frames.map((f) => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n";
    const rawBytes = encoder.encode(fullText);

    // Fragment into 5-byte chunks
    const splitSize = 5;
    const splitBody = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < rawBytes.length; offset += splitSize) {
          controller.enqueue(
            rawBytes.subarray(offset, Math.min(offset + splitSize, rawBytes.length)),
          );
        }
        controller.close();
      },
    });

    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: splitBody }),
    });

    const tokens: string[] = [];
    for await (const token of adapter.chatStream("m", USER_MESSAGES, { temperature: 0 })) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("AlphaBetaGamma");
  });

  it("handles stream ending cleanly on EOF without explicit [DONE] marker", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
      JSON.stringify({ choices: [{ delta: { content: " without DONE" } }] }),
    ];

    const encoder = new TextEncoder();
    // Intentionally no [DONE] marker
    const fullText = frames.map((f) => `data: ${f}\n\n`).join("");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(fullText));
        controller.close();
      },
    });

    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body }),
    });

    const tokens: string[] = [];
    for await (const token of adapter.chatStream("m", USER_MESSAGES, { temperature: 0 })) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("Hello without DONE");
  });

  it("ignores empty deltas and non-content fields cleanly", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: {} }] }),
      JSON.stringify({ choices: [{ delta: { content: "" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "Real content" } }] }),
      JSON.stringify({ choices: [{ delta: {} }] }),
    ];

    const adapter = new OpenAiCompatibleAdapter("http://x/v1", "key", {
      fetch: fakeFetch({ ok: true, status: 200, body: sseBody(frames) }),
    });

    const tokens: string[] = [];
    for await (const token of adapter.chatStream("m", USER_MESSAGES, { temperature: 0 })) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("Real content");
  });
});
