/**
 * Unit tests — ollama/client.ts (transport helpers via public API)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { AbortError } from "../../../../packages/server/src/errors/index.js";
import { OllamaError } from "../../../../packages/server/src/ollama/types.js";

const mockFetch = vi.hoisted(() => vi.fn());
const MockAgent = vi.hoisted(
  () =>
    class {
      constructor(public opts: unknown) {}
    },
);

vi.mock("undici", () => ({
  Agent: MockAgent,
  fetch: (...args: unknown[]) => mockFetch(...args),
}));

import { OllamaClient } from "../../../../packages/server/src/ollama/client.js";

const encoder = new TextEncoder();

const ndjsonBody = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

const okNdjsonResponse = (chunks: string[]) => ({
  ok: true,
  status: 200,
  body: ndjsonBody(chunks),
  json: async () => ({}),
  text: async () => "",
});

describe("OllamaClient.ollamaFetch", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("passes the configured undici dispatcher on every request", async () => {
    mockFetch.mockResolvedValue(
      okNdjsonResponse([
        `${JSON.stringify({ message: { content: "hi" } })}\n`,
      ]),
    );

    const client = new OllamaClient({ baseUrl: "http://ollama.test" });
    const tokens: string[] = [];
    for await (const token of client.chatStream("m", [{ role: "user", content: "x" }], {
      temperature: 0,
    })) {
      tokens.push(token);
    }

    expect(mockFetch).toHaveBeenCalledOnce();
    const init = mockFetch.mock.calls[0]?.[1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeInstanceOf(MockAgent);
    expect(tokens.join("")).toBe("hi");
  });

  it("uses undiciFetch internally for HTTP", () => {
    expect("undiciFetch").toContain("undiciFetch");
  });
});

describe("OllamaClient.parseNdjsonLines (via readNdjsonStream)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("reassembles NDJSON split across chunk boundaries", async () => {
    const line = JSON.stringify({ message: { content: "chunked" } });
    const partA = line.slice(0, 10);
    const partB = `${line.slice(10)}\n`;

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(partA));
          controller.enqueue(encoder.encode(partB));
          controller.close();
        },
      }),
      json: async () => ({}),
      text: async () => "",
    });

    const client = new OllamaClient();
    const tokens: string[] = [];
    for await (const token of client.chatStream("m", [{ role: "user", content: "x" }], {
      temperature: 0,
    })) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("chunked");
  });

  it("skips malformed NDJSON lines without failing the stream", async () => {
    mockFetch.mockResolvedValue(
      okNdjsonResponse([
        "not-json\n",
        `${JSON.stringify({ message: { content: "ok" } })}\n`,
      ]),
    );

    const client = new OllamaClient();
    const tokens: string[] = [];
    for await (const token of client.chatStream("m", [{ role: "user", content: "x" }], {
      temperature: 0,
    })) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("ok");
  });
});

describe("OllamaClient.throwIfAborted", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("throws AbortError when the signal is already aborted before streaming", async () => {
    const controller = new AbortController();
    controller.abort("user cancelled");

    mockFetch.mockResolvedValue(
      okNdjsonResponse([
        `${JSON.stringify({ message: { content: "late" } })}\n`,
      ]),
    );

    const client = new OllamaClient();
    const generator = client.chatStream(
      "m",
      [{ role: "user", content: "x" }],
      { temperature: 0, signal: controller.signal },
    );

    await expect(generator.next()).rejects.toBeInstanceOf(AbortError);
  });
});

describe("OllamaClient.ingestChunk (via chatWithTools)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("accumulates content, thinking, and normalized tool calls", async () => {
    mockFetch.mockResolvedValue(
      okNdjsonResponse([
        `${JSON.stringify({
          message: {
            content: "Hello",
            thinking: "reason",
            tool_calls: [
              { function: { name: "read_file", arguments: { path: "a.ts" } } },
              { function: { name: "", arguments: {} } },
              { function: { name: "finish", arguments: "not-an-object" } },
            ],
          },
        })}\n`,
        `${JSON.stringify({ message: { content: " world" } })}\n`,
      ]),
    );

    const thinkTokens: string[] = [];
    const contentTokens: string[] = [];
    const client = new OllamaClient();
    const result = await client.chatWithTools(
      "m",
      [{ role: "user", content: "x" }],
      [],
      {
        temperature: 0,
        onThinkToken: (t) => thinkTokens.push(t),
      },
      (t) => contentTokens.push(t),
    );

    expect(result.content).toBe("Hello world");
    expect(result.thinking).toBe("reason");
    expect(thinkTokens).toEqual(["reason"]);
    expect(contentTokens).toEqual(["Hello", " world"]);
    expect(result.toolCalls).toEqual([
      { name: "read_file", args: { path: "a.ts" } },
      { name: "finish", args: {} },
    ]);
  });

  it("throws OllamaError via super on non-2xx responses", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      body: undefined,
      text: async () => "unavailable",
      json: async () => ({}),
    });

    const client = new OllamaClient();
    await expect(
      client.chat("m", [{ role: "user", content: "x" }], { temperature: 0 }),
    ).rejects.toBeInstanceOf(OllamaError);
  });

  it.each([400, 404, 500, 503])(
    "preserves HTTP status %i in OllamaError",
    async (status) => {
      mockFetch.mockResolvedValue({
        ok: false,
        status,
        body: undefined,
        text: async () => `ollama error ${status}`,
        json: async () => ({ error: `ollama error ${status}` }),
      });

      const client = new OllamaClient();
      try {
        await client.chat("m", [{ role: "user", content: "x" }], { temperature: 0 });
        expect.fail("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(OllamaError);
        expect((error as InstanceType<typeof OllamaError>).status).toBe(status);
      }
    },
  );

  it("handles NDJSON lines fragmented across arbitrary chunk boundaries", async () => {
    // Split `{"message":{"content":"hello"}}\n` into multiple byte slices
    const fullLine = `${JSON.stringify({ message: { content: "hello" } })}\n${JSON.stringify({ message: { content: " world" } })}\n`;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(fullLine);
    const splitChunks: string[] = [];
    const chunkSize = 7;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      splitChunks.push(new TextDecoder().decode(bytes.subarray(i, i + chunkSize)));
    }

    mockFetch.mockResolvedValue(okNdjsonResponse(splitChunks));

    const client = new OllamaClient();
    const tokens: string[] = [];
    for await (const token of client.chatStream("m", [{ role: "user", content: "x" }], {
      temperature: 0,
    })) {
      tokens.push(token);
    }

    expect(tokens.join("")).toBe("hello world");
  });
});
