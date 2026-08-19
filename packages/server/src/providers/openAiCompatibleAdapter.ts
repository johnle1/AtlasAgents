/**
 * HTTP client for any OpenAI-compatible `/v1/chat/completions` backend.
 *
 * @remarks
 * This is the one client every non-Ollama provider uses — vLLM on a local GPU,
 * AWS Trainium, Google TPU, or any other OpenAI-compatible server. They differ
 * only by `baseUrl`; the wire protocol (SSE streaming, tool-call shape) is the
 * same for all of them, so a single adapter implementation covers every case.
 *
 * Implements the same {@link IOllamaClient} contract as the native Ollama
 * client so callers (Agent, Subagent) don't need to know which backend they're
 * talking to.
 */

import type {
  ChatWithToolsResult,
  IOllamaClient,
} from "../orchestration/interfaces/ollamaInterfaces.js";
import type { ChatOptions, Message } from "../orchestration/types.js";
import type { ToolSchema } from "../orchestration/tools/types.js";
import { AbortError } from "../errors/index.js";
import { ModelProviderError } from "./errors.js";
import { toOpenAiMessages, toOpenAiTools } from "./messageTranslation.js";

/** OpenAI-compatible API endpoint for chat completions. */
const CHAT_COMPLETIONS_ENDPOINT = "chat/completions";

/** Server-Sent Events (SSE) frame prefix. */
const SSE_DATA_PREFIX = "data:";

/** SSE stream termination marker. */
const SSE_DONE_MARKER = "[DONE]";

/** HTTP Authorization header prefix for Bearer token authentication. */
const BEARER_PREFIX = "Bearer ";

/**
 * One `choices[].delta` fragment from an OpenAI-compatible streaming chunk.
 *
 * @remarks
 * OpenAI streaming uses Server-Sent Events (SSE) with incremental deltas.
 * Each delta contains optional `content` (streamed text output), `reasoning_content`
 * (thinking tokens when using reasoning modes), and `tool_calls` (streamed function calls).
 *
 * @example
 * ```ts
 * // Typical text delta
 * const delta: OpenAiStreamDelta = { content: "Hello w" };
 *
 * // Tool call delta (streamed as fragments)
 * const delta: OpenAiStreamDelta = {
 *   tool_calls: [{
 *     index: 0,
 *     function: { name: "search", arguments: "{\"q\": \"" }
 *   }]
 * };
 * ```
 */
type OpenAiStreamDelta = {
  /** Chunk of the model's text response (content of the assistant message). */
  content?: string;
  /** Reasoning/thinking tokens (present when the backend runs with a reasoning parser like o1). */
  reasoning_content?: string;
  /** Array of streamed tool call fragments, incrementally building function calls. */
  tool_calls?: Array<{
    /** Index of the tool call (0-based), used to group fragments of the same call. */
    index?: number;
    /** The function being called, streamed as fragments. */
    function?: { name?: string; arguments?: string };
  }>;
};

/**
 * One streamed chunk from an OpenAI-compatible `/v1/chat/completions` response.
 *
 * @remarks
 * OpenAI's SSE format wraps all response data in a `choices` array with one element
 * per chunk. This is the shape received from any OpenAI-compatible server (vLLM, Ollama
 * with OpenAI wrapper, AWS Bedrock, Google Vertex, etc.).
 */
type OpenAiStreamChunk = {
  /** Array of completion choices (typically one element per response stream). */
  choices?: Array<{ delta?: OpenAiStreamDelta }>;
};

/**
 * In-progress accumulation of one streamed tool call, indexed by its position.
 *
 * @remarks
 * When a model calls multiple tools, OpenAI streams each call as fragments.
 * Tool calls are keyed by `index` (which tool in the array) and fragments
 * arrive out of order. This type accumulates name and arguments until complete.
 *
 * @example
 * ```ts
 * const accumulator: ToolCallAccumulator = {
 *   name: "search",
 *   argsText: "{\"query\": \"what is AI?\"}"
 * };
 * ```
 */
type ToolCallAccumulator = { name: string; argsText: string };

/**
 * Extracts the reason message from an AbortSignal, falling back to a generic message.
 *
 * @remarks
 * When a request is aborted, the signal's `.reason` field may contain an Error with
 * a descriptive message. This helper safely extracts it and provides a fallback.
 *
 * @param signal - The AbortSignal, if present.
 * @returns A human-readable abort reason, never empty.
 *
 * @example
 * ```ts
 * const controller = new AbortController();
 * controller.abort(new Error("User clicked cancel"));
 * abortReasonMessage(controller.signal); // "User clicked cancel"
 * ```
 */
const abortReasonMessage = (signal?: AbortSignal): string => {
  const reason = signal?.reason as unknown;
  // Try to extract the error message from the abort reason.
  if (reason instanceof Error && reason.message.length > 0) {
    return reason.message;
  }
  // Fall back to a generic message if no reason was provided.
  return "Request aborted";
};

/**
 * Throws an AbortError if the signal has been aborted.
 *
 * @remarks
 * This is a guard check that should be called periodically during long-running
 * operations (like streaming) to allow callers to cancel work gracefully.
 * The error includes a descriptive message from the abort reason if available.
 *
 * @param signal - The AbortSignal to check, if present.
 * @throws {@link AbortError} if the signal is aborted.
 *
 * @example
 * ```ts
 * while (true) {
 *   throwIfAborted(options.signal); // Check once per iteration
 *   // do work...
 * }
 * ```
 */
const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new AbortError(abortReasonMessage(signal));
  }
};

/**
 * Safely reads the response body, returning empty string on failure.
 *
 * @remarks
 * When an HTTP error occurs, we want to include the server's error message in our
 * exception. However, reading the body can fail (EOF, encoding errors, etc.), so
 * we wrap it and return "" if reading fails. This prevents error handling from
 * cascading into a new error.
 *
 * @param response - The HTTP response object with a `.text()` method.
 * @returns The response body as a string, or empty string if reading failed.
 *
 * @example
 * ```ts
 * const response = await fetch(...);
 * if (!response.ok) {
 *   const body = await readErrorBody(response); // Never throws
 *   throw new ModelProviderError(response.status, body);
 * }
 * ```
 */
const readErrorBody = async (response: {
  text: () => Promise<string>;
}): Promise<string> => {
  try {
    return await response.text();
  } catch {
    // If we can't read the body, return empty string so the error handler
    // can still produce a meaningful error message.
    return "";
  }
};

/**
 * Splits a text buffer into complete SSE `data:` frames and a leftover partial line.
 *
 * @remarks
 * Server-Sent Events (SSE) are newline-delimited with `data:` prefixes. Streaming I/O
 * may deliver partial frames, so we need a carry buffer to hold incomplete lines until
 * the next chunk arrives. This pattern mirrors NDJSON parsing.
 *
 * **Frame format:**
 * ```
 * data: {"choices":[{"delta":{"content":"Hello"}}]}
 * data: {"choices":[{"delta":{"content":" world"}}]}
 * data: [DONE]
 * ```
 *
 * **Algorithm:**
 * 1. Split buffer by newlines
 * 2. The last (possibly incomplete) part becomes the carry buffer
 * 3. All complete lines are scanned for `data:` prefix
 * 4. Empty lines and `[DONE]` are skipped
 * 5. Remaining payloads are returned as JSON strings ready to parse
 *
 * @param buffer - The received text buffer, containing zero or more complete lines and possibly one partial line.
 * @returns Object with:
 *   - `frames`: Array of SSE payload strings (without `data:` prefix), ready for JSON parsing
 *   - `rest`: The leftover partial line (or empty string), to carry into the next chunk
 *
 * @example
 * ```ts
 * const buffer = 'data: {"content":"hi"}\ndata: {"content":"bye"}\ndata: {';
 * const result = parseSseFrames(buffer);
 * // result.frames = ['{"content":"hi"}', '{"content":"bye"}']
 * // result.rest = 'data: {'
 * ```
 */
const parseSseFrames = (
  buffer: string,
): { frames: string[]; rest: string } => {
  // Split the buffer by newlines. The last element may be incomplete.
  const parts = buffer.split("\n");
  // Pop and save the last (possibly incomplete) part to carry into the next chunk.
  const rest = parts.pop() ?? "";
  const frames: string[] = [];

  // Process all complete lines (everything except the last partial line).
  for (const line of parts) {
    const trimmed = line.trim();
    // Skip lines that don't have the SSE `data:` prefix.
    if (!trimmed.startsWith(SSE_DATA_PREFIX)) {
      continue;
    }
    // Extract the payload (everything after the SSE prefix).
    const payload = trimmed.slice(SSE_DATA_PREFIX.length).trim();
    // Skip empty lines and the final stream termination marker.
    if (payload.length === 0 || payload === SSE_DONE_MARKER) {
      continue;
    }
    // Add this complete SSE frame to the results.
    frames.push(payload);
  }
  return { frames, rest };
};

/**
 * Minimal `fetch`-compatible surface this adapter needs, for test injection.
 *
 * @remarks
 * We accept this type instead of importing `fetch` directly to allow tests to
 * inject a mock fetch for controlled testing without network calls.
 */
export type FetchLike = typeof fetch;

/**
 * HTTP client for any OpenAI-compatible `/v1/chat/completions` backend.
 *
 * @remarks
 * This adapter implements the {@link IOllamaClient} interface for any backend
 * that speaks OpenAI's wire protocol — vLLM on local GPU, AWS SageMaker, Google Vertex AI,
 * or any other OpenAI-compatible server. A single adapter covers all of them because
 * they differ only by `baseUrl`; the SSE streaming format and tool-call shape are identical.
 *
 * **Design:**
 * - Accepts any OpenAI-compatible endpoint via baseUrl
 * - Translates internal Message/Tool shapes to OpenAI format via {@link toOpenAiMessages}
 *   and {@link toOpenAiTools}
 * - Handles SSE streaming with proper carry buffers for incomplete lines
 * - Supports both text generation and tool-calling
 * - Respects AbortSignal for cancellation
 *
 * **Usage:**
 * One instance per non-Ollama provider in ProviderRegistry. The caller (Agent, Subagent)
 * doesn't know which backend it's talking to — it just calls the same interface methods.
 *
 * @example
 * ```ts
 * const adapter = new OpenAiCompatibleAdapter(
 *   "https://vllm.example.com/v1",
 *   "sk-xxx"
 * );
 * const text = await adapter.chat("mistral-7b", messages, { temperature: 0.7 });
 *
 * // Streaming with cancellation
 * const controller = new AbortController();
 * for await (const token of adapter.chatStream(model, messages, {
 *   temperature: 0.7,
 *   signal: controller.signal
 * })) {
 *   console.log(token);
 * }
 * ```
 *
 * @see {@link IOllamaClient} for the interface contract
 * @see {@link toOpenAiMessages} and {@link toOpenAiTools} for shape translation
 */
export class OpenAiCompatibleAdapter implements IOllamaClient {
  /** Base URL of the OpenAI-compatible server (trailing slash removed). */
  private readonly baseUrl: string;
  /** API key for authentication via Bearer token. */
  private readonly apiKey: string;
  /** Fetch implementation, injected for testing or overridden for custom HTTP. */
  private readonly fetchImpl: FetchLike;

  /**
   * Creates an adapter for an OpenAI-compatible backend.
   *
   * @param baseUrl - Base URL of the OpenAI-compatible API server, e.g. "https://api.openai.com/v1".
   *   Trailing slashes are removed to normalize paths.
   * @param apiKey - API key for authentication. Sent as `Authorization: Bearer {apiKey}`.
   * @param deps - Optional dependencies for testing or customization.
   *   - `fetch`: Custom fetch implementation (e.g., for mocking in tests). Defaults to global fetch.
   *
   * @example
   * ```ts
   * // Production
   * const adapter = new OpenAiCompatibleAdapter(
   *   "https://api.openai.com/v1",
   *   process.env.OPENAI_API_KEY
   * );
   *
   * // Testing with mock fetch
   * const mockFetch = jest.fn();
   * const adapter = new OpenAiCompatibleAdapter(
   *   "https://api.example.com/v1",
   *   "test-key",
   *   { fetch: mockFetch }
   * );
   * ```
   */
  constructor(
    baseUrl: string,
    apiKey: string,
    deps: { fetch?: FetchLike } = {},
  ) {
    // Normalize the base URL by removing any trailing slash to avoid double slashes
    // when we construct the full endpoint path.
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    // Use the injected fetch implementation, or fall back to the global fetch.
    this.fetchImpl = deps.fetch ?? fetch;
  }

  /**
   * Constructs standard HTTP headers for OpenAI-compatible API requests.
   *
   * @remarks
   * OpenAI-compatible servers expect:
   * - `Content-Type: application/json` — all request bodies are JSON
   * - `Authorization: Bearer {apiKey}` — authentication via Bearer token
   *
   * @returns Headers object ready to pass to fetch.
   *
   * @example
   * ```ts
   * const headers = adapter.headers();
   * // { "Content-Type": "application/json", "Authorization": "Bearer sk-..." }
   * ```
   */
  private headers = (): Record<string, string> => ({
    "Content-Type": "application/json",
    Authorization: `${BEARER_PREFIX}${this.apiKey}`,
  });

  /**
   * Wraps network errors in a ModelProviderError with context about the operation.
   *
   * @remarks
   * Network calls can fail for many reasons (connection refused, DNS error, timeout, etc.).
   * This helper standardizes error handling by:
   * 1. Preserving AbortErrors as-is (caller already canceled the request)
   * 2. Wrapping other errors in ModelProviderError with context (operation, model, baseUrl)
   *
   * This makes error handling at the caller level simpler — they can check the error
   * type once instead of extracting context from various network library exceptions.
   *
   * @param operation - Description of what failed, e.g. "chat stream" or "chat with tools".
   * @param model - The model name being used, for context in the error message.
   * @param error - The caught network error.
   * @returns A ModelProviderError or AbortError, ready to throw.
   *
   * @example
   * ```ts
   * try {
   *   await fetch(url, options);
   * } catch (err) {
   *   throw wrapNetworkError("chat", "gpt-4", err);
   *   // Throws: ModelProviderError(0, "chat failed for model 'gpt-4' at https://...: ...")
   * }
   * ```
   */
  private wrapNetworkError = (
    operation: string,
    model: string,
    error: unknown,
  ): Error => {
    // If the error is already an AbortError, pass it through unchanged.
    if (error instanceof AbortError) {
      return error;
    }
    // Extract a message from the error (handle both Error instances and other values).
    const message = error instanceof Error ? error.message : String(error);
    // Wrap in a ModelProviderError with context about what was being attempted.
    return new ModelProviderError(
      0,
      `${operation} failed for model '${model}' at ${this.baseUrl}: ${message}`,
    );
  };

  /**
   * Opens an SSE stream to the OpenAI-compatible API and processes frames.
   *
   * @remarks
   * This is a helper that extracts common streaming logic used by both `chatStream`
   * and `chatWithTools`. It handles:
   * - HTTP request setup and error handling
   * - SSE frame parsing with carry buffers
   * - AbortSignal checking
   * - Reader cleanup
   *
   * The caller provides a processor function that handles each complete frame.
   *
   * @param operation - Description of the operation (e.g. "chat stream") for error messages.
   * @param model - Model name for error context.
   * @param requestBody - The body to send to the API (messages, tools, etc.).
   * @param options - Request options (temperature, signal, etc.).
   * @yields Parsed SSE chunks in arrival order, as soon as each is received.
   * @throws {@link ModelProviderError} if the API returns an error.
   * @throws {@link AbortError} if canceled via options.signal.
   */
  /**
   * Ingests one complete SSE chunk during tool-aware streaming.
   *
   * @remarks
   * Extracts content, thinking tokens, and tool call fragments from an SSE chunk
   * and accumulates them in the provided state objects. This is separated out from
   * the streaming loop for testability and clarity.
   *
   * @param chunk - One parsed SSE chunk from the OpenAI API.
   * @param state - Mutable state object containing:
   *   - content: accumulated text response
   *   - thinking: accumulated reasoning tokens
   *   - toolCallsByIndex: Map of in-progress tool calls by index
   * @param onToken - Optional callback fired for each content token.
   * @param onThinkToken - Optional callback fired for each reasoning token
   *   (`delta.reasoning_content`), independent of `includeThinking` — reasoning
   *   models on OpenAI-compatible backends emit this channel unprompted.
   */
  private ingestToolCallChunk(
    chunk: OpenAiStreamChunk,
    state: { content: string; thinking: string; toolCallsByIndex: Map<number, ToolCallAccumulator> },
    onToken?: (token: string) => void,
    onThinkToken?: (token: string) => void,
  ): void {
    const delta = chunk.choices?.[0]?.delta;
    // If there's no delta, skip (shouldn't happen but be defensive).
    if (!delta) {
      return;
    }

    // Extract content (regular text output).
    if (typeof delta.content === "string" && delta.content.length > 0) {
      state.content += delta.content;
      // Fire the token callback so callers can display streaming output in real-time.
      onToken?.(delta.content);
    }

    // Extract thinking content (reasoning tokens from reasoning models).
    if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content.length > 0
    ) {
      state.thinking += delta.reasoning_content;
      onThinkToken?.(delta.reasoning_content);
    }

    // Extract and accumulate tool call fragments.
    // OpenAI streams tool calls in pieces: first the name, then arguments char by char.
    for (const fragment of delta.tool_calls ?? []) {
      // Get or create the accumulator for this tool call index.
      const index = fragment.index ?? 0;
      const existing = state.toolCallsByIndex.get(index) ?? {
        name: "",
        argsText: "",
      };
      // Update the name if this fragment has one (typically arrives first).
      if (fragment.function?.name) {
        existing.name = fragment.function.name;
      }
      // Append argument fragments (they arrive incrementally as a JSON string).
      if (fragment.function?.arguments) {
        existing.argsText += fragment.function.arguments;
      }
      // Store the updated accumulator.
      state.toolCallsByIndex.set(index, existing);
    }
  }

  /**
   * Opens an SSE stream to the OpenAI-compatible API and yields each parsed chunk.
   *
   * @remarks
   * Extracted so `chatStream` and `chatWithTools` share one HTTP/SSE-parsing
   * implementation. This is a genuine generator — chunks are yielded to the
   * caller as soon as each SSE frame is parsed, not accumulated and replayed
   * after the response finishes. That incrementality is what lets `chatStream`
   * and `chatWithTools` observe content and reasoning tokens as they arrive.
   *
   * @param operation - Description of the operation (e.g. "chat stream") for error messages.
   * @param model - Model name for error context.
   * @param requestBody - The body to send to the API (messages, tools, etc.).
   * @param options - Request options (temperature, signal, etc.).
   */
  private openStream = async function* (
    this: OpenAiCompatibleAdapter,
    operation: string,
    model: string,
    requestBody: Record<string, unknown>,
    options: ChatOptions,
  ): AsyncGenerator<OpenAiStreamChunk> {
    // Construct the full endpoint URL for the chat completions API.
    const url = `${this.baseUrl}/${CHAT_COMPLETIONS_ENDPOINT}`;

    // Attempt to open the streaming connection. Wrap network errors in context.
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(requestBody),
        // Allow the caller to cancel the request via AbortSignal.
        signal: options.signal,
      });
    } catch (networkError) {
      throw this.wrapNetworkError(operation, model, networkError);
    }

    // Check for HTTP errors (4xx, 5xx). The server rejected the request.
    if (!response.ok) {
      throw new ModelProviderError(
        response.status,
        await readErrorBody(response),
      );
    }
    // Verify the response has a body. Shouldn't happen (should be ok: false first),
    // but we guard against malformed responses.
    if (!response.body) {
      throw new ModelProviderError(
        500,
        `No response body from provider ${operation}`,
      );
    }

    // Open a ReadableStream reader to consume the SSE stream.
    const reader = response.body.getReader();
    // Decoder for streaming text (handles multi-byte UTF-8 characters).
    const decoder = new TextDecoder();
    // Carry buffer: holds incomplete lines between chunks.
    let carry = "";

    try {
      // Main streaming loop: read chunks until done.
      while (true) {
        // Check if the caller has canceled the request.
        throwIfAborted(options.signal);
        // Read the next chunk from the stream. Wrap read errors in context.
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          const result = await reader.read();
          done = result.done;
          value = result.value;
        } catch (readError) {
          // If the request was aborted while awaiting `read()`, preserve cancellation semantics.
          throwIfAborted(options.signal);
          throw this.wrapNetworkError(operation, model, readError);
        }
        // If there's no more data, we're done streaming.
        if (done) {
          break;
        }
        // Decode the chunk (may be partial UTF-8 sequences; decoder handles continuation).
        carry += decoder.decode(value, { stream: true });
        // Parse complete SSE frames, keeping incomplete lines in carry buffer.
        const { frames, rest } = parseSseFrames(carry);
        carry = rest;

        // Yield each complete SSE frame received in this chunk, in order.
        for (const frame of frames) {
          // Parse outside the yield so a consumer's break/throw during yield
          // can never be caught by the malformed-JSON catch below.
          let chunk: OpenAiStreamChunk | null = null;
          try {
            chunk = JSON.parse(frame) as OpenAiStreamChunk;
          } catch {
            // If a frame is malformed JSON, skip it. This shouldn't happen in practice
            // because the backend sends valid JSON, but we're defensive.
            chunk = null;
          }
          if (chunk) {
            yield chunk;
          }
        }
      }
    } finally {
      // Always cancel the reader when we're done (whether due to completion, error, or abort).
      // The `.catch()` suppresses errors from already-canceled readers.
      await reader.cancel().catch(() => undefined);
    }
  };

  /**
   * Sends messages to the model and returns the complete response as a string.
   *
   * @remarks
   * This is a convenience wrapper around {@link chatStream} that collects all
   * streamed tokens and returns them as a single string. Use this for simple
   * text-generation tasks. For streaming responses (where you want to display
   * tokens as they arrive), use {@link chatStream} directly.
   *
   * **Performance note:** String concatenation in JavaScript is O(n) per append,
   * making this O(n²) overall for very large responses. For gigabyte-scale responses,
   * consider streaming. For typical LLM outputs (a few KB), this is fine.
   *
   * @param model - The model to use for completion, e.g. "mistral-7b" or "gpt-4".
   * @param messages - Conversation history in internal {@link Message} format.
   *   Will be translated to OpenAI format automatically.
   * @param options - Configuration for the request (temperature, signal for cancellation, etc.).
   * @returns The complete model response as a single string.
   * @throws {@link ModelProviderError} if the API returns an error or response is malformed.
   * @throws {@link AbortError} if the request is canceled via options.signal.
   *
   * @example
   * ```ts
   * const response = await adapter.chat("mistral-7b", messages, {
   *   temperature: 0.7
   * });
   * console.log(response); // "Hello! How can I help?"
   * ```
   */
  chat = async (
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): Promise<string> => {
    // Accumulate all tokens from the stream into a single string.
    let result = "";
    for await (const token of this.chatStream(model, messages, options)) {
      result += token;
    }
    return result;
  };

  /**
   * Streams the model's text response token-by-token, yielding as they arrive.
   *
   * @remarks
   * This method opens an SSE stream to the OpenAI-compatible backend and yields
   * each content token as it arrives. Use this when you want progressive output
   * (e.g., display to user as it's generated, show thinking tokens, etc.).
   *
   * **Algorithm:**
   * 1. POST the request with `stream: true`
   * 2. Read the response stream as an async iterable
   * 3. Parse SSE frames, handling incomplete lines (carry buffer)
   * 4. Yield content tokens (skip reasoning content unless requested)
   * 5. On abort, cancel the reader and propagate the error
   * 6. Ensure reader cleanup via finally block
   *
   * **Thinking tokens:** If `options.includeThinking` is true, reasoning content
   * (when present on reasoning models like o1) is yielded alongside regular content.
   *
   * **Error handling:**
   * - Network errors → wrapped in ModelProviderError with context
   * - HTTP errors (4xx, 5xx) → ModelProviderError with server body
   * - Malformed SSE frames → silently skipped (shouldn't happen)
   * - Cancellation (AbortSignal) → AbortError thrown
   *
   * @param model - The model to use, e.g. "mistral-7b" or "o1-preview".
   * @param messages - Conversation history in internal format.
   * @param options - Configuration including temperature, signal for cancellation,
   *   and includeThinking flag for reasoning models.
   * @yields Text tokens as they arrive from the model, one per yield.
   * @throws {@link ModelProviderError} if the API returns a non-2xx status.
   * @throws {@link AbortError} if canceled via options.signal.
   *
   * @example
   * ```ts
   * // Display streaming response to user
   * for await (const token of adapter.chatStream("mistral-7b", messages, {
   *   temperature: 0.7,
   *   signal: userCancelSignal
   * })) {
   *   process.stdout.write(token); // Real-time output
   * }
   *
   * // With thinking tokens
   * for await (const token of adapter.chatStream("o1-preview", messages, {
   *   includeThinking: true
   * })) {
   *   console.log(token);
   * }
   * ```
   */
  chatStream = async function* (
    this: OpenAiCompatibleAdapter,
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    // Open the stream and yield each token as its chunk arrives — no
    // accumulate-then-replay, so callers see content (and reasoning, when
    // requested) at true generation speed.
    for await (const chunk of this.openStream(
      "chat stream",
      model,
      {
        model,
        messages: toOpenAiMessages(messages),
        temperature: options.temperature,
        stream: true,
      },
      options,
    )) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) {
        continue;
      }

      // Yield text content as soon as this delta arrives.
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield delta.content;
      }

      // If the caller wants thinking tokens and they're present (reasoning models),
      // yield them alongside content tokens.
      if (
        options.includeThinking &&
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content.length > 0
      ) {
        yield delta.reasoning_content;
      }
    }
  };

  /**
   * Streams messages with tool availability, collecting content, tool calls, and thinking.
   *
   * @remarks
   * This method is the primary way to interact with tool-calling models. It:
   * 1. Opens an SSE stream to the backend with tools available
   * 2. Accumulates content tokens, thinking tokens, and tool call fragments
   * 3. Yields tokens via optional callback for real-time display
   * 4. Reconstructs complete tool calls from streamed fragments (OpenAI streams tool
   *    arguments character-by-character)
   * 5. Returns all accumulated data: the full response, any tool calls made, and thinking
   *
   * **Tool call accumulation:**
   * OpenAI streams tool calls in fragments, with arguments arriving as a JSON string
   * incrementally. We accumulate these by index and reconstruct complete tool calls at
   * the end. The `onToken` callback fires for each content token (not tool fragments).
   *
   * **Thinking tokens:**
   * Reasoning models (o1, etc.) may emit thinking content. This is collected separately
   * in the `thinking` field of the result. Regular models will have empty thinking.
   *
   * **Error handling:** Same as {@link chatStream} — network errors wrapped, HTTP errors
   * propagated, SSE parsing errors skipped, AbortSignal respected.
   *
   * @param model - The tool-capable model to use, e.g. "gpt-4", "mistral-large".
   * @param messages - Conversation history in internal format.
   * @param tools - Array of available tools the model can call, in internal {@link ToolSchema} format.
   *   Translated to OpenAI format automatically.
   * @param options - Configuration (temperature, signal, etc.). May include `includeThinking`.
   * @param onToken - Optional callback fired for each content token (not tool fragments).
   *   Use this to display streaming output to the user.
   * @returns {@link ChatWithToolsResult} with:
   *   - `content`: Full accumulated text response
   *   - `thinking`: Accumulated reasoning/thinking (empty for non-reasoning models)
   *   - `toolCalls`: Array of complete tool calls the model requested, in order
   * @throws {@link ModelProviderError} if the API returns an error.
   * @throws {@link AbortError} if canceled via options.signal.
   *
   * @example
   * ```ts
   * const result = await adapter.chatWithTools(
   *   "gpt-4",
   *   messages,
   *   [{ function: { name: "search", parameters: {...} } }],
   *   { temperature: 0.7 },
   *   (token) => process.stdout.write(token) // Display tokens as they arrive
   * );
   *
   * console.log("Response:", result.content);
   * for (const call of result.toolCalls) {
   *   console.log(`Called ${call.name}(${JSON.stringify(call.args)})`);
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
    // Accumulate state as we process SSE chunks.
    const state = {
      content: "",
      thinking: "",
      toolCallsByIndex: new Map<number, ToolCallAccumulator>(),
    };

    // Open the stream and ingest each chunk as it arrives.
    for await (const chunk of this.openStream(
      "chat with tools",
      model,
      {
        model,
        messages: toOpenAiMessages(messages),
        tools: toOpenAiTools(tools),
        temperature: options.temperature,
        stream: true,
      },
      options,
    )) {
      this.ingestToolCallChunk(chunk, state, onToken, options.onThinkToken);
    }

    // Reconstruct complete tool calls from the accumulated fragments.
    const toolCalls: ChatWithToolsResult["toolCalls"] = [];
    // Sort indices to ensure tool calls are returned in the order the model emitted them.
    const orderedIndices = [...state.toolCallsByIndex.keys()].sort((a, b) => a - b);
    for (const index of orderedIndices) {
      const accumulator = state.toolCallsByIndex.get(index);
      // Skip accumulators without a name (shouldn't happen, but be defensive).
      if (!accumulator || accumulator.name.length === 0) {
        continue;
      }
      // Parse the accumulated JSON string into an object. If parsing fails, use empty object.
      let args: Record<string, unknown> = {};
      try {
        args =
          accumulator.argsText.length > 0
            ? (JSON.parse(accumulator.argsText) as Record<string, unknown>)
            : {};
      } catch {
        // If arguments are malformed JSON, use empty object as fallback.
        // The caller can detect this (name but no args) and handle it.
        args = {};
      }
      // Add this complete tool call to the result.
      toolCalls.push({ name: accumulator.name, args });
    }

    // Return all accumulated data: text response, thinking, and tool calls.
    return { content: state.content, thinking: state.thinking, toolCalls };
  };
}
