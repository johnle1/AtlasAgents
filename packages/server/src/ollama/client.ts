/**
 * HTTP client for Ollama's chat and model administration APIs.
 *
 * @remarks
 * LoopyCode communicates with a local Ollama server to perform two categories of operations:
 *
 * **Chat operations** (for inference):
 * - `chat()` — Single-turn blocking inference (wait for full response)
 * - `chatStream()` — Streaming inference (get tokens as they arrive)
 * - `chatWithTools()` — Function calling (send tool schemas, get back structured calls)
 *
 * **Admin operations** (for model management):
 * - `listModels()` — List all downloaded models
 * - `pullModel()` — Download a model from the registry (with progress updates)
 * - `deleteModel()` — Remove a downloaded model
 * - `showModel()` — Query a model's metadata (size, parameters, capabilities)
 * - `listRunning()` — List models currently in memory
 *
 * **Transport details:**
 * - Uses Undici (high-performance Node.js HTTP) for low-level requests
 * - Configurable timeouts (default 10 minutes for long model operations)
 * - Respects AbortSignal for cancellation (e.g., orchestrator-level timeout)
 * - Handles NDJSON streaming (newline-delimited JSON) for progress updates
 * - Defensive error handling: readable error messages, graceful degradation
 *
 * **Error handling:**
 * - Non-2xx responses throw `OllamaError` with status code + response body
 * - Aborted requests throw `AbortError` with the cancellation reason
 * - Network/timeout errors are caught and wrapped with context
 *
 * @example
 * ```ts
 * const client = new OllamaClient({ baseUrl: "http://localhost:11434" });
 *
 * Chat: simple text completion
 * const reply = await client.chat("gemma3:27b", messages, { temperature: 0.7 });
 * console.log(reply); // "Here's what I think..."
 *
 * Streaming: token-by-token output
 * for await (const token of client.chatStream("gemma3:27b", messages)) {
 *   process.stdout.write(token);
 * }
 *
 * Function calling: ask the model to invoke a tool
 * const result = await client.chatWithTools("gemma3:27b", messages, toolSchemas);
 * console.log(result.toolCalls); // [{ name: "search", args: { query: "..." } }]
 *
 * Model management: pull a large model with progress
 * for await (const progress of client.pullModel("llama3:70b")) {
 *   if (progress.completed && progress.total) {
 *     const pct = Math.round((progress.completed / progress.total) * 100);
 *     console.log(`${pct}%`);
 *   }
 * }
 * ```
 */

import type {
  IOllamaAdminClient,
  IOllamaClient,
  ChatWithToolsResult,
} from "../orchestration/interfaces.js";
import type { ChatOptions, Message } from "../orchestration/types.js";
import type { ToolSchema } from "../orchestration/tools/types.js";
import type {
  ModelInfo,
  OllamaModelSummary,
  PullProgress,
  RunningModel,
} from "./types.js";
import { Agent, fetch as undiciFetch } from "undici";
import { AbortError } from "../errors/index.js";
import { enrichOllamaFetchError } from "../orchestration/taskErrors.js";
import { logger } from "../utils/logger.js";
import { OllamaError } from "./types.js";

/** Default Ollama server URL when not specified in configuration. */
const DEFAULT_BASE_URL = "http://localhost:11434";

/** Default timeout for HTTP requests in milliseconds (10 minutes). */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Maps ChatOptions reasoning flags to Ollama API fields.
 *
 * @remarks
 * Some models (like reasoning models) support extended thinking via a `think` field.
 * This helper converts LoopyCode's ChatOptions format into Ollama's field names.
 *
 * @param options - Chat options from the caller.
 * @returns Object with optional `think` field matching Ollama's schema.
 */
const ollamaThinkField = (
  options: ChatOptions,
): { think?: boolean | "low" | "medium" | "high" | "max" } => {
  // Explicit think value takes precedence (e.g., { think: "high" } for deep reasoning).
  if (options.think !== undefined) {
    return { think: options.think };
  }
  // Fallback: includeThinking flag enables thinking (defaults to true for reasoning).
  if (options.includeThinking) {
    return { think: true };
  }
  // No thinking requested.
  return {};
};

/**
 * Maps ChatOptions runtime-tuning fields to Ollama API request fields.
 *
 * @remarks
 * `num_ctx` and `keep_alive` sit at different nesting levels in Ollama's
 * request body — `num_ctx` lives inside the `options` object alongside
 * `temperature`, while `keep_alive` is a top-level sibling of `model` and
 * `messages`. Both are omitted from the request entirely when unset, so a
 * caller that never sets them (any non-Ollama-tuned call) produces the exact
 * same wire body as before this option existed.
 *
 * @param options - Chat options from the caller.
 * @returns Object spreadable into the request body: `options.num_ctx` plus
 *   `temperature`, and a top-level `keep_alive` when configured.
 */
const ollamaRuntimeFields = (
  options: ChatOptions,
): {
  options: { temperature: number; num_ctx?: number };
  keep_alive?: string | number;
} => ({
  options: {
    temperature: options.temperature,
    ...(options.numCtx !== undefined ? { num_ctx: options.numCtx } : {}),
  },
  ...(options.keepAlive !== undefined ? { keep_alive: options.keepAlive } : {}),
});

/**
 * Builds an Undici HTTP agent with configured timeouts.
 *
 * @remarks
 * Undici is Node.js's high-performance HTTP client. This factory sets three timeout
 * values to handle different stages of an HTTP request:
 * - `headersTimeout`: Max time to receive response headers (inherited from bodyTimeout)
 * - `bodyTimeout`: Max time to receive the response body (long for streaming/model downloads)
 * - `connectTimeout`: Max time to establish a socket connection (fixed at 60s)
 *
 * Long timeouts are important for model operations (pulling a 30GB model can take hours).
 *
 * @param timeoutMs - Timeout for headers/body in milliseconds.
 * @returns Configured Undici Agent for HTTP requests.
 *
 * @example
 * ```ts
 * const agent = buildDispatcher(10 * 60_000); // 10 minutes
 * ```
 */
const buildDispatcher = (timeoutMs: number): Agent =>
  new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connectTimeout: 60_000,
  });

/**
 * Extracts a human-readable message from an AbortSignal.
 *
 * @remarks
 * When a request is aborted, the signal may carry a reason (string or Error).
 * This extracts that reason, or falls back to a generic message.
 *
 * @param signal - The AbortSignal that was triggered.
 * @returns A human-readable reason string.
 */
const abortReasonMessage = (signal: AbortSignal): string => {
  const reason = signal.reason;
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  if (reason instanceof Error && reason.message.length > 0) {
    return reason.message;
  }
  return "Request aborted";
};

/**
 * Throws an AbortError if the signal has been aborted.
 *
 * @remarks
 * Used as a guard in async loops: before fetching, check if the caller
 * already requested cancellation. This is a no-op if the signal isn't
 * aborted, so it can be called frequently.
 *
 * @param signal - The AbortSignal to check (optional).
 * @throws {@link AbortError} if the signal is aborted.
 */
const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new AbortError(abortReasonMessage(signal));
  }
};

/**
 * Safely reads the error body from an HTTP response.
 *
 * @remarks
 * When an HTTP request fails, the response body often contains an error message
 * from Ollama. This helper safely reads that body text, gracefully handling
 * cases where the connection is closed or the body is already consumed.
 *
 * @param response - HTTP response object with a `text()` method.
 * @returns Response body text, or empty string if reading fails.
 *
 * @example
 * ```ts
 * const res = await fetch(url);
 * if (!res.ok) {
 *   const body = await readErrorBody(res);
 *   console.error(`HTTP ${res.status}: ${body}`);
 * }
 * ```
 */
const readErrorBody = async (response: {
  text: () => Promise<string>;
}): Promise<string> => {
  try {
    // Attempt to read the response body as text.
    return await response.text();
  } catch {
    // If reading fails (e.g., connection already closed), return empty string.
    // This is a defensive measure; an empty error body is better than crashing.
    return "";
  }
};

/**
 * Parses a buffer containing newline-delimited JSON (NDJSON) into complete lines and a partial remainder.
 *
 * @remarks
 * HTTP streaming delivers data in chunks, and NDJSON lines may span multiple chunks.
 * This helper splits a buffer into complete JSON lines (safe to parse) and a partial
 * line (incomplete, hold for the next chunk). This pattern enables processing of
 * large NDJSON streams (like model pulls with progress updates) without buffering
 * the entire response in memory.
 *
 * **Example flow:**
 * - Chunk 1: `{"status":"pulling"}\\n{"status":"download` → lines: 1, rest: partial
 * - Chunk 2: `ing","completed":100}\\n` → lines: 1 (from rest), rest: empty
 *
 * @param buffer - String buffer containing one or more NDJSON lines (possibly incomplete at the end).
 * @returns Object with `lines` (complete JSON strings) and `rest` (partial, or empty).
 *
 * @example
 * ```ts
 * const { lines, rest } = parseNdjsonLines(chunk);
 * for (const line of lines) {
 *   const json = JSON.parse(line); // Safe to parse
 *   console.log(json.status);
 * }
 * Hold rest for the next chunk
 * ```
 */
const parseNdjsonLines = (
  buffer: string,
): { lines: string[]; rest: string } => {
  // Split the buffer by newlines.
  const bufferParts = buffer.split("\n");

  // Remove and hold the last element as a partial (it may be incomplete).
  // Example: if buffer is "line1\nline2\npartial", we get partialBuffer = "partial"
  const partialBuffer = bufferParts.pop() ?? "";

  // Filter out empty lines (which don't contain valid JSON).
  // Example: "line1\nline2\n\n" → splits to ["line1", "line2", "", ""]
  // Filter removes the empty strings.
  const completeLines = bufferParts.filter((line) => line.trim().length > 0);

  // Step 4: Return complete lines and the partial buffer
  return { lines: completeLines, rest: partialBuffer };
};

/**
 * HTTP client implementing both chat inference and model administration for Ollama.
 *
 * @remarks
 * Implements `IOllamaClient` (chat operations) and `IOllamaAdminClient` (model
 * management) as a single class because both share the same transport plumbing:
 * base URL, timeout-configured Undici dispatcher, and error handling. See the
 * module-level documentation above for the full method list and usage examples.
 */
export class OllamaClient implements IOllamaClient, IOllamaAdminClient {
  /** Base URL for the Ollama server API (trailing slash stripped). */
  private readonly baseUrl: string;

  /** Timeout in milliseconds applied to the Undici dispatcher for HTTP requests. */
  private timeoutMs: number;

  /** Undici Agent managing connection-level timeouts for all requests from this client. */
  private dispatcher: Agent;

  /**
   * Creates an Ollama client bound to a server URL and request timeout.
   *
   * @param deps - Optional configuration.
   * @param deps.baseUrl - Ollama server URL. Defaults to `http://localhost:11434`.
   *   A trailing slash is stripped so endpoint paths can be appended directly.
   * @param deps.timeoutMs - Request timeout in milliseconds. Defaults to 600000 (10 minutes) —
   *   generous because model downloads and slow local inference can take a long time.
   *
   * @example
   * ```ts
   * const client = new OllamaClient({ baseUrl: "http://localhost:11434", timeoutMs: 300_000 });
   * ```
   */
  constructor(readonly deps: { baseUrl?: string; timeoutMs?: number } = {}) {
    const configuredBaseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

    // Strip a trailing slash so `${this.baseUrl}/api/...` never produces a double slash.
    this.baseUrl = configuredBaseUrl.replace(/\/$/, "");

    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // The dispatcher bakes in the timeout at construction time, so it must be
    // built here (and rebuilt in setTimeoutMs if the timeout later changes).
    this.dispatcher = buildDispatcher(this.timeoutMs);
  }

  /**
   * Updates the request timeout and rebuilds the underlying HTTP dispatcher.
   *
   * @remarks
   * Undici's `Agent` bakes its timeout in at construction, so changing the
   * timeout requires constructing a new dispatcher — there's no way to mutate
   * an existing one in place. Invalid values (non-finite or ≤ 0) are ignored
   * with a warning rather than applied, since a zero or negative timeout
   * would make every request fail instantly.
   *
   * @param timeoutMs - New timeout in milliseconds. Ignored if not finite or ≤ 0.
   */
  setTimeoutMs = (timeoutMs: number): void => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      logger.warn({ timeoutMs }, "Ignoring invalid Ollama client timeout");
      return;
    }

    this.timeoutMs = timeoutMs;
    this.dispatcher = buildDispatcher(timeoutMs);
  };

  /**
   * Performs a fetch request through this client's configured dispatcher.
   *
   * @remarks
   * Every HTTP call in this class goes through here so the timeout-configured
   * dispatcher is applied uniformly — callers never need to remember to pass it.
   *
   * @param url - Full URL to fetch.
   * @param init - Standard fetch init options (method, headers, body, signal, etc.).
   * @returns The Undici fetch Response promise.
   */
  private ollamaFetch = (
    url: string,
    init: Parameters<typeof undiciFetch>[1] = {},
  ): ReturnType<typeof undiciFetch> =>
    undiciFetch(url, { ...init, dispatcher: this.dispatcher });

  /**
   * Throws {@link OllamaError} if the response status is not 2xx.
   *
   * @remarks
   * Centralizes the "check status, read error body, throw" sequence that
   * every endpoint method in this class needs. Reading the error body is
   * async, which is why this can't be a simple synchronous guard.
   *
   * @param fetchResponse - The response to check.
   * @throws {@link OllamaError} with the response's status and (truncated) body text.
   */
  private assertOk = async (
    fetchResponse: Awaited<ReturnType<typeof undiciFetch>>,
  ): Promise<void> => {
    if (!fetchResponse.ok) {
      throw new OllamaError(
        fetchResponse.status,
        await readErrorBody(fetchResponse),
      );
    }
  };

  /**
   * Consumes a fetch response body as an NDJSON stream, yielding each parsed line.
   *
   * @remarks
   * Shared low-level stream consumer used by `chatStream`, `chatWithTools`, and
   * `pullModel` — Ollama's three streaming endpoints all emit newline-delimited
   * JSON, one object per token/progress update. This generator owns the
   * mechanics all three need: reading raw bytes, decoding to text, splitting
   * into complete lines vs. a trailing partial (via `parseNdjsonLines`),
   * parsing each line as JSON, and releasing the underlying reader when
   * iteration stops — whether that's a natural end, an early `break` in the
   * caller's `for await`, or an error.
   *
   * Malformed lines are silently skipped rather than thrown: under normal
   * operation Ollama does not emit invalid JSON, but skipping is safer than
   * crashing the whole stream over one bad line (e.g. from a boundary
   * misdetected by `parseNdjsonLines`).
   *
   * @param body - The `ReadableStream<Uint8Array>` from a fetch Response.
   * @param signal - Optional AbortSignal, checked before each read so
   *   cancellation stops promptly instead of waiting for the next chunk.
   * @returns Async generator yielding each successfully parsed line as `unknown` —
   *   callers cast to the shape they expect (chat message envelope, `PullProgress`, etc.).
   * @throws {@link AbortError} if `signal` is aborted mid-stream.
   */
  private readNdjsonStream = async function* (
    this: OllamaClient,
    body: NonNullable<Awaited<ReturnType<typeof undiciFetch>>["body"]>,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown> {
    const streamReader = body.getReader();
    const textDecoder = new TextDecoder();
    let carryBuffer = "";

    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await streamReader.read();
        if (done) {
          break;
        }

        // { stream: true } handles multibyte characters split across chunk boundaries.
        carryBuffer += textDecoder.decode(value, { stream: true });

        const { lines: completeLines, rest: partialData } =
          parseNdjsonLines(carryBuffer);
        carryBuffer = partialData;

        for (const jsonLine of completeLines) {
          try {
            yield JSON.parse(jsonLine);
          } catch {
            // Skip malformed NDJSON lines (defensive — shouldn't happen normally).
          }
        }
      }

      // The stream ended — one final line may remain in the buffer if it
      // wasn't terminated by a trailing newline.
      if (carryBuffer.trim().length > 0) {
        try {
          yield JSON.parse(carryBuffer);
        } catch {
          // Ignore a trailing partial line that never completed.
        }
      }
    } finally {
      // Always release the reader, even on early break or thrown error, so
      // the underlying connection can be cleaned up.
      await streamReader.cancel().catch(() => undefined);
    }
  };

  /**
   * <Summary>
   * What it does:
   *   Sends a non-streaming chat request to Ollama and returns the complete response.
   *
   * How it does it (step by step):
   *   1. Consume the streaming endpoint to avoid timeout issues.
   *   2. Accumulate all streaming response chunks.
   *   3. Return the complete accumulated response.
   *
   * Parameters:
   *   @param model - The Ollama model name to use.
   *   @param messages - Array of conversation messages.
   *   @param options - Chat options including temperature.
   *
   * Returns:
   *   @returns The complete AI response text.
   *
   * Implementation Note:
   *   We use the streaming endpoint internally even for non-streaming requests.
   *   With stream:false, Ollama only sends headers after the FULL generation completes,
   *   which can exceed undici's default headersTimeout (~300s) for large/slow models
   *   and surface as UND_ERR_HEADERS_TIMEOUT. Using stream=true ensures headers arrive
   *   immediately, avoiding this timeout issue.
   * </Summary>
   */
  /**
   * Sends a chat request to Ollama and returns the complete response text.
   *
   * @remarks
   * Internally delegates to `chatStream` and accumulates every chunk — see
   * that method's remarks for why streaming is used even for this "blocking"
   * call (it avoids a header-timeout failure mode with slow models). Prefer
   * `chatStream` directly if you want to render tokens as they arrive.
   *
   * @param model - Ollama model name (e.g. `"gemma3:27b"`).
   * @param messages - Ordered conversation history.
   * @param options - Sampling and behavior options (temperature, thinking, abort signal).
   * @returns The model's complete response text.
   * @throws {@link OllamaError} if Ollama returns a non-2xx response.
   * @throws {@link AbortError} if `options.signal` is aborted mid-stream.
   *
   * @example
   * ```ts
   * const reply = await client.chat("gemma3:4b", messages, { temperature: 0 });
   * ```
   */
  chat = async (
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): Promise<string> => {
    let accumulatedResponse = "";
    for await (const responseChunk of this.chatStream(
      model,
      messages,
      options,
    )) {
      accumulatedResponse += responseChunk;
    }
    return accumulatedResponse;
  };

  /**
   * Streams a chat response from Ollama, yielding text as it arrives.
   *
   * @remarks
   * Sends `stream: true` to Ollama's `/api/chat` endpoint and yields each
   * content (and optionally thinking) piece as soon as it's parsed off the
   * wire, via the shared `readNdjsonStream` consumer.
   *
   * **Why streaming even here:** With `stream: false`, Ollama withholds the
   * HTTP response entirely until generation finishes, which can exceed
   * Undici's default headers timeout (~300s) for large or slow models and
   * surface as `UND_ERR_HEADERS_TIMEOUT`. Streaming makes headers arrive
   * immediately, sidestepping that failure mode — `chat()` uses this same
   * method internally and just accumulates the chunks.
   *
   * @param model - Ollama model name.
   * @param messages - Ordered conversation history.
   * @param options - Sampling options. `includeThinking` also yields the
   *   model's reasoning/thinking text interleaved with content.
   * @returns Async generator yielding response text chunks (content, and
   *   thinking text if `options.includeThinking` is set).
   * @throws {@link OllamaError} if the request fails or Ollama returns a non-2xx response.
   * @throws {@link AbortError} if `options.signal` is aborted mid-stream.
   *
   * @example
   * ```ts
   * for await (const token of client.chatStream("gemma3:27b", messages, { temperature: 0.7 })) {
   *   process.stdout.write(token);
   * }
   * ```
   */
  chatStream = async function* (
    this: OllamaClient,
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    const chatApiUrl = `${this.baseUrl}/api/chat`;

    let fetchResponse: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      fetchResponse = await this.ollamaFetch(chatApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          ...ollamaRuntimeFields(options),
          ...ollamaThinkField(options),
        }),
        signal: options.signal,
      });
    } catch (networkError) {
      throw enrichOllamaFetchError(
        this.baseUrl,
        "chat stream",
        model,
        networkError,
      );
    }

    await this.assertOk(fetchResponse);
    if (!fetchResponse.body) {
      throw new OllamaError(500, "No response body from Ollama chat stream");
    }

    for await (const parsedLine of this.readNdjsonStream(
      fetchResponse.body,
      options.signal,
    )) {
      const responseChunk = parsedLine as {
        message?: { content?: string; thinking?: string };
      };

      const contentPiece = responseChunk.message?.content;
      if (typeof contentPiece === "string" && contentPiece.length > 0) {
        yield contentPiece;
      }

      if (options.includeThinking) {
        const thinkingPiece = responseChunk.message?.thinking;
        if (typeof thinkingPiece === "string" && thinkingPiece.length > 0) {
          yield thinkingPiece;
        }
      }
    }
  };

  /**
   * Sends a chat request with tool schemas and returns the complete response plus any tool calls.
   *
   * @remarks
   * Like `chatStream`, this streams internally (for the same header-timeout
   * reason) but accumulates content, thinking, and structured tool calls
   * into a single result rather than yielding incrementally. An optional
   * `onToken` callback lets the caller observe content tokens as they arrive
   * (e.g. for live UI updates) without changing the return shape. Reasoning
   * tokens (`message.thinking`) are similarly observable via
   * `options.onThinkToken`.
   *
   * Tool call arguments are defensively normalized: if Ollama sends a
   * non-object `arguments` value (or omits it), it's replaced with `{}`
   * rather than propagated as-is, so downstream tool handlers always
   * receive a plain object.
   *
   * @param model - Ollama model name. Must support native tool calling —
   *   see `modelSupportsNativeTools()`.
   * @param messages - Ordered conversation history.
   * @param tools - Tool schemas describing what the model may call.
   * @param options - Sampling options.
   * @param onToken - Optional callback invoked with each content token as it streams in.
   * @returns The accumulated `content`, `thinking` text, and any parsed `toolCalls`.
   * @throws {@link OllamaError} if the request fails or Ollama returns a non-2xx response.
   * @throws {@link AbortError} if `options.signal` is aborted mid-stream.
   *
   * @example
   * ```ts
   * const result = await client.chatWithTools("gemma3:27b", messages, toolSchemas, { temperature: 0 });
   * if (result.toolCalls.length > 0) {
   *   console.log(result.toolCalls[0].name, result.toolCalls[0].args);
   * }
   * ```
   */
  chatWithTools = async (
    model: string,
    messages: Message[],
    tools: ToolSchema[],
    options: ChatOptions,
    onToken?: (token: string) => void,
  ): Promise<ChatWithToolsResult> => {
    const chatApiUrl = `${this.baseUrl}/api/chat`;

    let fetchResponse: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      fetchResponse = await this.ollamaFetch(chatApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          tools,
          stream: true,
          ...ollamaRuntimeFields(options),
          ...ollamaThinkField(options),
        }),
        signal: options.signal,
      });
    } catch (networkError) {
      throw enrichOllamaFetchError(
        this.baseUrl,
        "chat with tools",
        model,
        networkError,
      );
    }

    await this.assertOk(fetchResponse);
    if (!fetchResponse.body) {
      throw new OllamaError(500, "No response body from Ollama chat stream");
    }

    let content = "";
    let thinking = "";
    const toolCalls: ChatWithToolsResult["toolCalls"] = [];

    // Accumulates one parsed NDJSON line into the running content/thinking/toolCalls
    // state. Defined inline since it closes over the three accumulator variables above.
    const ingestChunk = (responseChunk: {
      message?: {
        content?: string;
        thinking?: string;
        tool_calls?: Array<{
          function?: {
            name?: string;
            arguments?: Record<string, unknown>;
          };
        }>;
      };
    }): void => {
      const contentPiece = responseChunk.message?.content;
      if (typeof contentPiece === "string" && contentPiece.length > 0) {
        content += contentPiece;
        onToken?.(contentPiece);
      }

      const thinkingPiece = responseChunk.message?.thinking;
      if (typeof thinkingPiece === "string" && thinkingPiece.length > 0) {
        thinking += thinkingPiece;
        options.onThinkToken?.(thinkingPiece);
      }

      for (const toolCall of responseChunk.message?.tool_calls ?? []) {
        const name = toolCall.function?.name;
        if (typeof name !== "string" || name.length === 0) {
          continue;
        }
        const rawArgs = toolCall.function?.arguments;
        const args =
          rawArgs !== null &&
          typeof rawArgs === "object" &&
          !Array.isArray(rawArgs)
            ? rawArgs
            : {};
        toolCalls.push({ name, args });
      }
    };

    for await (const parsedLine of this.readNdjsonStream(
      fetchResponse.body,
      options.signal,
    )) {
      ingestChunk(
        parsedLine as {
          message?: {
            content?: string;
            thinking?: string;
            tool_calls?: Array<{
              function?: {
                name?: string;
                arguments?: Record<string, unknown>;
              };
            }>;
          };
        },
      );
    }

    return { content, thinking, toolCalls };
  };

  /**
   * @async
   * <Summary>
   * Lists all installed Ollama models with full metadata.
   *
   * @remarks
   * Queries `GET /api/tags`. Entries missing a valid, non-empty `name` are
   * filtered out — Ollama shouldn't send those, but this guards against a
   * malformed or version-mismatched response silently producing entries
   * with `undefined` names downstream.
   *
   * @returns Array of installed models with size, digest, and metadata.
   * @throws {@link OllamaError} if the request fails or Ollama returns a non-2xx response.
   *
   * @example
   * ```ts
   * const models = await client.listModelsDetailed();
   * console.log(models[0].name, models[0].size);
   * ```
   */
  listModelsDetailed = async (): Promise<OllamaModelSummary[]> => {
    const fetchResponse = await this.ollamaFetch(`${this.baseUrl}/api/tags`, {
      method: "GET",
    });
    await this.assertOk(fetchResponse);

    const responseData = (await fetchResponse.json()) as {
      models?: Array<{
        name?: string;
        size?: number;
        digest?: string;
        modified_at?: string;
        details?: OllamaModelSummary["details"];
      }>;
    };
    const modelEntries = responseData.models ?? [];

    // Only include entries with a valid, non-empty name — everything downstream
    // assumes `name` is a usable string.
    const validModels = modelEntries.filter(
      (modelEntry) =>
        typeof modelEntry.name === "string" && modelEntry.name.length > 0,
    );

    return validModels.map((modelEntry) => ({
      name: modelEntry.name as string,
      size: modelEntry.size,
      digest: modelEntry.digest,
      modified_at: modelEntry.modified_at,
      details: modelEntry.details,
    }));
  };

  /**
   * Lists the names of all installed Ollama models.
   *
   * @remarks
   * A thin convenience wrapper over `listModelsDetailed` for callers that
   * only need names (e.g. checking whether a model is installed before
   * pulling it), without the full metadata payload.
   *
   * @returns Array of installed model names.
   * @throws {@link OllamaError} if the request fails or Ollama returns a non-2xx response.
   *
   * @example
   * ```ts
   * const models = await client.listModels();
   * if (!models.includes("gemma3:27b")) {
   *   console.log("Not installed — run pullModel first");
   * }
   * ```
   */
  listModels = async (): Promise<string[]> => {
    const detailedModels = await this.listModelsDetailed();
    return detailedModels.map((model) => model.name);
  };

  /**
   * Downloads a model from the Ollama registry, yielding progress updates as it streams in.
   *
   * @remarks
   * Sends `POST /api/pull` with `stream: true` and forwards each parsed NDJSON
   * line as a `PullProgress` update via the shared `readNdjsonStream` consumer.
   * Progress objects vary by phase — `completed`/`total` are only present
   * during active download; other phases (manifest pull, digest verification)
   * only carry a `status` string.
   *
   * @param name - Model name to pull (e.g. `"llama3:70b"`), using Ollama's registry naming.
   * @returns Async generator yielding progress updates until the pull completes.
   * @throws {@link OllamaError} if the request fails or Ollama returns a non-2xx response.
   *
   * @example
   * ```ts
   * for await (const progress of client.pullModel("llama3:70b")) {
   *   if (progress.completed && progress.total) {
   *     console.log(`${Math.round((progress.completed / progress.total) * 100)}%`);
   *   } else {
   *     console.log(progress.status);
   *   }
   * }
   * ```
   */
  pullModel = async function* (
    this: OllamaClient,
    name: string,
  ): AsyncGenerator<PullProgress> {
    const fetchResponse = await this.ollamaFetch(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, stream: true }),
    });

    await this.assertOk(fetchResponse);
    if (!fetchResponse.body) {
      throw new OllamaError(500, "No response body from Ollama pull stream");
    }

    for await (const parsedLine of this.readNdjsonStream(fetchResponse.body)) {
      yield parsedLine as PullProgress;
    }
  };

  /**
   * Permanently deletes an installed model from the Ollama server.
   *
   * @remarks
   * Checks `listModels()` first so a missing model produces a clear
   * `OllamaError(404, "Model not found: ...")` instead of whatever generic
   * error Ollama's `/api/delete` would return for an unknown name.
   * Irreversible — the model must be re-pulled via `pullModel` to use it again.
   *
   * @param name - Exact model name to delete, including tag (e.g. `"gemma3:4b"`).
   * @throws {@link OllamaError} with status 404 if the model isn't installed,
   *   or with Ollama's status/body if the delete request itself fails.
   *
   * @example
   * ```ts
   * await client.deleteModel("gemma3:4b");
   * ```
   */
  deleteModel = async (name: string): Promise<void> => {
    const availableModels = await this.listModels();
    if (!availableModels.includes(name)) {
      throw new OllamaError(404, `Model not found: ${name}`);
    }

    const fetchResponse = await this.ollamaFetch(`${this.baseUrl}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await this.assertOk(fetchResponse);
  };

  /**
   * Retrieves metadata for one installed model, including its tool-calling capabilities.
   *
   * @remarks
   * Queries `POST /api/show`. The returned `capabilities` array is what
   * `modelSupportsNativeTools()` checks to decide whether the agent can use
   * native tool calling for this model.
   *
   * @param name - Model name to inspect, including tag.
   * @returns Model metadata: size, parameters, family, quantization, capabilities, etc.
   * @throws {@link OllamaError} if the request fails or Ollama returns a non-2xx response.
   * @throws {@link AbortError} if the underlying fetch is aborted (via `enrichOllamaFetchError` wrapping).
   *
   * @example
   * ```ts
   * const info = await client.showModel("gemma3:27b");
   * console.log(info.capabilities?.includes("tools"));
   * ```
   */
  showModel = async (name: string): Promise<ModelInfo> => {
    const showApiUrl = `${this.baseUrl}/api/show`;

    let fetchResponse: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      fetchResponse = await this.ollamaFetch(showApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch (networkError) {
      throw enrichOllamaFetchError(
        this.baseUrl,
        "show model",
        name,
        networkError,
      );
    }

    await this.assertOk(fetchResponse);
    return (await fetchResponse.json()) as ModelInfo;
  };

  /**
   * Lists models currently loaded in Ollama's memory (RAM/VRAM).
   *
   * @remarks
   * Queries `GET /api/ps`. Useful for checking whether a model is "warm"
   * (immediately available for inference) versus needing to be loaded from
   * disk first — each entry's `expires_at` indicates when Ollama will unload
   * it if idle.
   *
   * @returns Array of currently loaded models. Empty if nothing is in memory.
   * @throws {@link OllamaError} if the request fails or Ollama returns a non-2xx response.
   *
   * @example
   * ```ts
   * const running = await client.listRunning();
   * const isWarm = running.some((m) => m.name === "gemma3:27b");
   * ```
   */
  listRunning = async (): Promise<RunningModel[]> => {
    const fetchResponse = await this.ollamaFetch(`${this.baseUrl}/api/ps`, {
      method: "GET",
    });
    await this.assertOk(fetchResponse);

    const responseData = (await fetchResponse.json()) as {
      models?: RunningModel[];
    };
    return responseData.models ?? [];
  };
}
