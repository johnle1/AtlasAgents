/**
 * <Summary>
 * What it does:
 *   HTTP client for Ollama chat and model admin APIs.
 *
 * How it fits in the system:
 *   Provides a unified interface for communicating with the local Ollama server.
 *   Handles both chat operations (for AI agents and advisors) and model management
 *   (pulling, deleting, listing models). Uses undici for HTTP with configurable timeouts.
 *
 * Dependencies:
 *   - undici — HTTP fetch with configurable timeouts.
 *   - enrichOllamaFetchError — enriches fetch errors with context.
 *   - OllamaError — custom error type for Ollama-specific errors.
 *
 * Dependants:
 *   - container.ts — creates OllamaClient instances for dependency injection.
 *   - Advisor — uses chat for planning and advising agents.
 *   - Agent — uses chatStream for task execution.
 *   - PatternExtractor — uses chat for extracting preference rules.
 *   - Router handlers — use model admin APIs for model management.
 * </Summary>
 */

import type {
  IOllamaAdminClient,
  IOllamaClient,
} from "../orchestration/interfaces.js";
import type { ChatOptions, Message } from "../orchestration/types.js";
import type {
  ModelInfo,
  OllamaModelSummary,
  PullProgress,
  RunningModel,
} from "./types.js";
import { Agent, fetch as undiciFetch } from "undici";
import { enrichOllamaFetchError } from "../orchestration/taskErrors.js";
import { OllamaError } from "./types.js";

/** Default Ollama server URL when not specified in configuration. */
const DEFAULT_BASE_URL = "http://localhost:11434";

/** Default timeout for HTTP requests in milliseconds (10 minutes). */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * <Summary>
 * What it does:
 *   Builds an undici Agent with configured timeouts for HTTP requests.
 *
 * How it does it (step by step):
 *   1. Create a new Agent with the specified timeout settings.
 *   2. Set headersTimeout and bodyTimeout to the provided value.
 *   3. Set connectTimeout to 60 seconds (reasonable default for establishing connections).
 *
 * Parameters:
 *   @param {number} timeoutMs — Timeout in milliseconds for headers and body.
 *
 * Returns:
 *   {Agent} — Configured undici Agent for HTTP requests.
 *
 * Dependencies:
 *   - undici.Agent — HTTP connection agent with timeout support.
 *
 * Dependants:
 *   - OllamaClient constructor — creates dispatcher with configured timeout.
 *   - setTimeoutMs — rebuilds dispatcher when timeout changes.
 * </Summary>
 */
const buildDispatcher = (timeoutMs: number): Agent =>
  new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connectTimeout: 60_000,
  });

/**
 * <Summary>
 * What it does:
 *   Safely reads the error body from an HTTP response.
 *
 * How it does it (step by step):
 *   1. Attempt to read the response body as text.
 *   2. If reading fails (e.g., connection already closed), return empty string.
 *
 * Parameters:
 *   @param {Object} response — HTTP response object with text method.
 *   @param {() => Promise<string>} response.text — Method to read response body as text.
 *
 * Returns:
 *   {string} — Response body text, or empty string if reading fails.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - ollamaFetch error handling — extracts error details from failed responses.
 * </Summary>
 */
const readErrorBody = async (response: {
  text: () => Promise<string>;
}): Promise<string> => {
  try {
    // Step 1: Attempt to read the response body as text
    return await response.text();
  } catch {
    // Step 2: If reading fails (e.g., connection already closed), return empty string
    return "";
  }
};

/**
 * <Summary>
 * What it does:
 *   Parses a buffer containing newline-delimited JSON (NDJSON) into complete lines and leftover partial data.
 *
 * How it does it (step by step):
 *   1. Split the buffer by newlines.
 *   2. Remove and return the last element as the partial (might be incomplete).
 *   3. Filter out empty lines from the remaining parts.
 *   4. Return complete lines and the partial buffer.
 *
 * Parameters:
 *   @param {string} buffer — String buffer containing NDJSON data.
 *
 * Returns:
 *   @returns {{ lines: string[]; rest: string }} — Object with complete lines and remaining partial data.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - chatStream — parses streaming NDJSON responses from Ollama.
 *   - pullModel — parses streaming NDJSON responses during model pull.
 * </Summary>
 */
const parseNdjsonLines = (
  buffer: string,
): { lines: string[]; rest: string } => {
  // Step 1: Split the buffer by newlines
  const bufferParts = buffer.split("\n");

  // Step 2: Remove and return the last element as the partial (might be incomplete)
  // The last element might be an incomplete line that continues in the next chunk
  const partialBuffer = bufferParts.pop() ?? "";

  // Step 3: Filter out empty lines from the remaining parts
  // Empty lines don't contain valid JSON and should be ignored
  const completeLines = bufferParts.filter((line) => line.trim().length > 0);

  // Step 4: Return complete lines and the partial buffer
  return { lines: completeLines, rest: partialBuffer };
};

/**
 * <Summary>
 * What it does:
 *   HTTP client for Ollama chat and model admin APIs.
 *
 * How it fits in the system:
 *   Implements both IOllamaClient (chat operations) and IOllamaAdminClient (model management).
 *   Provides a unified interface for communicating with the local Ollama server with
 *   configurable timeouts and error handling. Handles streaming responses for chat and
 *   model pull operations.
 *
 * Dependencies:
 *   - undici — HTTP fetch with configurable timeouts.
 *   - buildDispatcher — creates HTTP agent with timeout configuration.
 *   - parseNdjsonLines — parses streaming NDJSON responses.
 *   - readErrorBody — extracts error details from failed responses.
 *   - enrichOllamaFetchError — enriches fetch errors with context.
 *   - OllamaError — custom error type for Ollama-specific errors.
 *
 * Dependants:
 *   - container.ts — creates OllamaClient instances for dependency injection.
 *   - Advisor — uses chat for planning and advising agents.
 *   - Agent — uses chatStream for task execution.
 *   - PatternExtractor — uses chat for extracting preference rules.
 *   - Router handlers — use model admin APIs for model management.
 * </Summary>
 */
export class OllamaClient implements IOllamaClient, IOllamaAdminClient {
  /** Base URL for the Ollama server API. */
  private readonly baseUrl: string;

  /** Timeout in milliseconds for HTTP requests. */
  private timeoutMs: number;

  /** Undici Agent for HTTP connection management with timeouts. */
  private dispatcher: Agent;

  /**
   * Constructor
   *
   * How it does it (step by step):
   *   1. Extract baseUrl from deps or use DEFAULT_BASE_URL.
   *   2. Remove trailing slash from baseUrl to ensure consistent URL construction.
   *   3. Extract timeoutMs from deps or use DEFAULT_TIMEOUT_MS.
   *   4. Build dispatcher with the configured timeout.
   *
   * Parameters:
   *   @param {Object} deps — Dependency object with optional configuration.
   *     @param {string} [deps.baseUrl] — Ollama server URL. Defaults to http://localhost:11434.
   *     @param {number} [deps.timeoutMs] — Request timeout in milliseconds. Defaults to 600000 (10 min).
   *
   * Returns:
   *   void — Constructor does not return a value.
   *
   * Dependencies:
   *   - buildDispatcher — creates HTTP agent with timeout configuration.
   *
   * Dependants:
   *   - container.ts — instantiates OllamaClient with configuration.
   */
  constructor(readonly deps: { baseUrl?: string; timeoutMs?: number } = {}) {
    // Step 1: Extract baseUrl from deps or use DEFAULT_BASE_URL
    const configuredBaseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

    // Step 2: Remove trailing slash from baseUrl to ensure consistent URL construction
    // This prevents double slashes when constructing API endpoints
    this.baseUrl = configuredBaseUrl.replace(/\/$/, "");

    // Step 3: Extract timeoutMs from deps or use DEFAULT_TIMEOUT_MS
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Step 4: Build dispatcher with the configured timeout
    // The dispatcher manages HTTP connections with the specified timeouts
    this.dispatcher = buildDispatcher(this.timeoutMs);
  }

  /**
   * <Summary>
   * What it does:
   *   Updates the timeout for HTTP requests and rebuilds the dispatcher.
   *
   * How it does it (step by step):
   *   1. Validate the timeout value (must be finite and positive).
   *   2. If valid, update the timeoutMs property.
   *   3. Rebuild the dispatcher with the new timeout.
   *
   * Parameters:
   *   @param {number} timeoutMs — New timeout in milliseconds.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - buildDispatcher — creates new HTTP agent with updated timeout.
   *
   * Dependants:
   *   - Router — may adjust timeout based on user configuration.
   * </Summary>
   */
  setTimeoutMs = (timeoutMs: number): void => {
    // Step 1: Validate the timeout value (must be finite and positive)
    // Invalid timeouts could cause unexpected behavior or errors
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return; // Silently ignore invalid values
    }

    // Step 2: If valid, update the timeoutMs property
    this.timeoutMs = timeoutMs;

    // Step 3: Rebuild the dispatcher with the new timeout
    // The dispatcher must be rebuilt because timeout is set during Agent construction
    this.dispatcher = buildDispatcher(timeoutMs);
  };

  /**
   * <Summary>
   * What it does:
   *   Private method to perform HTTP requests to Ollama with the configured dispatcher.
   *
   * How it does it (step by step):
   *   1. Merge the provided init options with the dispatcher.
   *   2. Call undiciFetch with the URL and merged options.
   *
   * Parameters:
   *   @param {string} url — The full URL to fetch.
   *   @param {Object} init — Optional fetch init options (method, headers, body, etc.).
   *
   * Returns:
   *   {Promise<Response>} — The fetch Response object.
   *
   * Dependencies:
   *   - undici.fetch — performs the HTTP request.
   *   - this.dispatcher — provides timeout configuration.
   *
   * Dependants:
   *   - chat — sends chat requests to Ollama.
   *   - chatStream — sends streaming chat requests.
   *   - listModelsDetailed — lists available models.
   *   - pullModel — pulls a model from registry.
   *   - deleteModel — deletes a local model.
   *   - showModel — shows model details.
   *   - listRunning — lists currently running models.
   * </Summary>
   */
  private ollamaFetch = (
    url: string,
    init: Parameters<typeof undiciFetch>[1] = {},
  ): ReturnType<typeof undiciFetch> =>
    // Step 1: Merge the provided init options with the dispatcher
    // The dispatcher provides timeout configuration for the request
    // Step 2: Call undiciFetch with the URL and merged options
    undiciFetch(url, { ...init, dispatcher: this.dispatcher });

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
   *   @param {string} model — The Ollama model name to use.
   *   @param {Message[]} messages — Array of conversation messages.
   *   @param {ChatOptions} options — Chat options including temperature.
   *
   * Returns:
   *   @returns {Promise<string>} — The complete AI response text.
   *
   * Dependencies:
   *   - chatStream — performs the actual streaming request.
   *
   * Dependants:
   *   - Advisor — uses for non-streaming planning and advising.
   *   - PatternExtractor — uses for extracting preference rules.
   *
   * Implementation Note:
   *   We use the streaming endpoint internally even for non-streaming requests.
   *   With stream:false, Ollama only sends headers after the FULL generation completes,
   *   which can exceed undici's default headersTimeout (~300s) for large/slow models
   *   and surface as UND_ERR_HEADERS_TIMEOUT. Using stream=true ensures headers arrive
   *   immediately, avoiding this timeout issue.
   * </Summary>
   */
  chat = async (
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): Promise<string> => {
    // Step 1: Consume the streaming endpoint to avoid timeout issues
    // We use streaming internally to avoid header timeout problems with slow models
    let accumulatedResponse = "";

    // Step 2: Accumulate all streaming response chunks
    // Iterate through the async generator and collect all response pieces
    for await (const responseChunk of this.chatStream(
      model,
      messages,
      options,
    )) {
      accumulatedResponse += responseChunk;
    }

    // Step 3: Return the complete accumulated response
    return accumulatedResponse;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Sends a streaming chat request to Ollama and yields response chunks as they arrive.
   *
   * How it does it (step by step):
   *   1. Construct the chat API URL.
   *   2. Send POST request with model, messages, and stream=true.
   *   3. Handle network errors with enrichment.
   *   4. Validate response status and body existence.
   *   5. Set up stream reader and text decoder.
   *   6. Read stream chunks until completion.
   *   7. Parse each chunk as NDJSON and yield content pieces.
   *   8. Handle any trailing partial data after stream ends.
   *
   * Parameters:
   *   @param {string} model — The Ollama model name to use.
   *   @param {Message[]} messages — Array of conversation messages.
   *   @param {ChatOptions} options — Chat options including temperature.
   *
   * Returns:
   *   @returns {AsyncGenerator<string>} — Async generator yielding response text chunks.
   *
   * Throws:
   *   @throws {OllamaError} — When HTTP request fails or returns error status.
   *   @throws {Error} — When network error occurs (enriched with context).
   *
   * Dependencies:
   *   - this.ollamaFetch — performs HTTP request with timeout handling.
   *   - enrichOllamaFetchError — adds context to network errors.
   *   - readErrorBody — extracts error details from failed responses.
   *   - parseNdjsonLines — parses streaming NDJSON responses.
   *
   * Dependants:
   *   - chat — consumes this generator for non-streaming responses.
   *   - Agent — uses directly for real-time task execution.
   * </Summary>
   */
  chatStream = async function* (
    this: OllamaClient,
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    // Step 1: Construct the chat API URL
    const chatApiUrl = `${this.baseUrl}/api/chat`;

    let fetchResponse: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      // Step 2: Send POST request with model, messages, and stream=true
      // We set stream=true to get incremental responses and avoid header timeouts
      fetchResponse = await this.ollamaFetch(chatApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          options: { temperature: options.temperature },
        }),
      });
    } catch (networkError) {
      // Step 3: Handle network errors with enrichment
      // enrichOllamaFetchError adds context about what operation failed
      throw enrichOllamaFetchError(
        this.baseUrl,
        "chat stream",
        model,
        networkError,
      );
    }

    // Validate response status and body existence
    if (!fetchResponse.ok) {
      // If the request returned an error status, extract and throw the error details
      throw new OllamaError(
        fetchResponse.status,
        await readErrorBody(fetchResponse),
      );
    }

    if (!fetchResponse.body) {
      // If there's no response body, the stream is invalid
      throw new OllamaError(500, "No response body from Ollama chat stream");
    }

    // Step 5: Set up stream reader and text decoder
    // The reader allows us to consume the stream chunk by chunk
    const streamReader = fetchResponse.body.getReader();
    // The decoder converts binary chunks to text strings
    const textDecoder = new TextDecoder();
    // Carry buffer holds partial data between chunks (incomplete lines)
    let carryBuffer = "";

    // Step 6: Read stream chunks until completion
    while (true) {
      // Read the next chunk from the stream
      const { done, value } = await streamReader.read();

      // If the stream is complete, exit the loop
      if (done) {
        break;
      }

      // Decode the binary chunk to text and append to carry buffer
      // { stream: true } handles incomplete multibyte characters correctly
      carryBuffer += textDecoder.decode(value, { stream: true });

      // Parse the carry buffer into complete lines and partial remainder
      const { lines: completeLines, rest: partialData } =
        parseNdjsonLines(carryBuffer);

      // Update carry buffer with the partial remainder for next iteration
      carryBuffer = partialData;

      // Step 7: Parse each complete line as NDJSON and yield content pieces
      for (const jsonLine of completeLines) {
        try {
          // Parse the JSON line to get the response chunk
          const responseChunk = JSON.parse(jsonLine) as {
            message?: { content?: string };
          };

          // Extract the content piece from the response
          const contentPiece = responseChunk.message?.content;

          // Only yield non-empty strings to avoid empty yields
          if (typeof contentPiece === "string" && contentPiece.length > 0) {
            yield contentPiece;
          }
        } catch {
          // Skip malformed NDJSON lines (shouldn't happen normally)
          // This is defensive programming to handle unexpected Ollama behavior
        }
      }
    }

    // Step 8: Handle any trailing partial data after stream ends
    // There might be one final incomplete line in the carry buffer
    if (carryBuffer.trim().length > 0) {
      try {
        // Try to parse the trailing partial data
        const finalChunk = JSON.parse(carryBuffer) as {
          message?: { content?: string };
        };
        const finalContentPiece = finalChunk.message?.content;

        // Yield if it's valid content
        if (
          typeof finalContentPiece === "string" &&
          finalContentPiece.length > 0
        ) {
          yield finalContentPiece;
        }
      } catch {
        // Ignore trailing partial line that couldn't be parsed
        // This is normal if the stream ended mid-line
      }
    }
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Lists all available Ollama models with detailed information.
   *
   * How it does it (step by step):
   *   1. Send GET request to /api/tags endpoint.
   *   2. Validate response status.
   *   3. Parse JSON response and extract models array.
   *   4. Filter out invalid model entries.
   *   5. Map to standardized OllamaModelSummary format.
   *
   * Returns:
   *   @returns {Promise<OllamaModelSummary[]>} — Array of detailed model information.
   *
   * Throws:
   *   @throws {OllamaError} — When HTTP request fails or returns error status.
   *
   * Dependencies:
   *   - this.ollamaFetch — performs HTTP request.
   *   - readErrorBody — extracts error details from failed responses.
   *
   * Dependants:
   *   - listModels — extracts just model names from detailed list.
   *   - Router — displays detailed model information.
   * </Summary>
   */
  listModelsDetailed = async (): Promise<OllamaModelSummary[]> => {
    // Step 1: Send GET request to /api/tags endpoint
    // This endpoint returns all available models with their metadata
    const fetchResponse = await this.ollamaFetch(`${this.baseUrl}/api/tags`, {
      method: "GET",
    });

    // Step 2: Validate response status
    if (!fetchResponse.ok) {
      throw new OllamaError(
        fetchResponse.status,
        await readErrorBody(fetchResponse),
      );
    }

    // Step 3: Parse JSON response and extract models array
    const responseData = (await fetchResponse.json()) as {
      models?: Array<{
        name?: string;
        size?: number;
        digest?: string;
        modified_at?: string;
        details?: OllamaModelSummary["details"];
      }>;
    };

    // Extract models array, defaulting to empty array if missing
    const modelEntries = responseData.models ?? [];

    // Step 4: Filter out invalid model entries
    // Only include models with valid, non-empty names
    const validModels = modelEntries.filter(
      (modelEntry) =>
        typeof modelEntry.name === "string" && modelEntry.name.length > 0,
    );

    // Step 5: Map to standardized OllamaModelSummary format
    // This ensures consistent type safety across the application
    return validModels.map((modelEntry) => ({
      name: modelEntry.name as string,
      size: modelEntry.size,
      digest: modelEntry.digest,
      modified_at: modelEntry.modified_at,
      details: modelEntry.details,
    }));
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Lists all available Ollama model names (simplified version).
   *
   * How it does it (step by step):
   *   1. Call listModelsDetailed to get full model information.
   *   2. Extract just the model names from the detailed list.
   *
   * Returns:
   *   @returns {Promise<string[]>} — Array of model names.
   *
   * Dependencies:
   *   - listModelsDetailed — gets detailed model information.
   *
   * Dependants:
   *   - Router — lists available models for user selection.
   *   - deleteModel — validates model existence before deletion.
   * </Summary>
   */
  listModels = async (): Promise<string[]> => {
    // Step 1: Call listModelsDetailed to get full model information
    const detailedModels = await this.listModelsDetailed();

    // Step 2: Extract just the model names from the detailed list
    // This provides a simpler interface when only names are needed
    return detailedModels.map((model) => model.name);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Pulls a model from the Ollama registry and yields progress updates.
   *
   * How it does it (step by step):
   *   1. Send POST request to /api/pull with model name and stream=true.
   *   2. Validate response status and body existence.
   *   3. Set up stream reader and text decoder.
   *   4. Read stream chunks until completion.
   *   5. Parse each chunk as NDJSON and yield progress updates.
   *   6. Handle any trailing partial data after stream ends.
   *
   * Parameters:
   *   @param {string} name — The model name to pull (e.g., "llama2:13b").
   *
   * Returns:
   *   @returns {AsyncGenerator<PullProgress>} — Async generator yielding pull progress updates.
   *
   * Throws:
   *   @throws {OllamaError} — When HTTP request fails or returns error status.
   *
   * Dependencies:
   *   - this.ollamaFetch — performs HTTP request.
   *   - readErrorBody — extracts error details from failed responses.
   *   - parseNdjsonLines — parses streaming NDJSON responses.
   *
   * Dependants:
   *   - Router — pulls models on user request.
   * </Summary>
   */
  pullModel = async function* (
    this: OllamaClient,
    name: string,
  ): AsyncGenerator<PullProgress> {
    // Step 1: Send POST request to /api/pull with model name and stream=true
    // Stream=true allows us to show real-time progress during the download
    const fetchResponse = await this.ollamaFetch(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, stream: true }),
    });

    // Step 2: Validate response status and body existence
    if (!fetchResponse.ok) {
      throw new OllamaError(
        fetchResponse.status,
        await readErrorBody(fetchResponse),
      );
    }

    if (!fetchResponse.body) {
      throw new OllamaError(500, "No response body from Ollama pull stream");
    }

    // Step 3: Set up stream reader and text decoder
    const streamReader = fetchResponse.body.getReader();
    const textDecoder = new TextDecoder();
    let carryBuffer = "";

    // Step 4: Read stream chunks until completion
    while (true) {
      const { done, value } = await streamReader.read();
      if (done) {
        break;
      }

      // Decode the binary chunk to text and append to carry buffer
      carryBuffer += textDecoder.decode(value, { stream: true });

      // Parse the carry buffer into complete lines and partial remainder
      const { lines: completeLines, rest: partialData } =
        parseNdjsonLines(carryBuffer);
      carryBuffer = partialData;

      // Step 5: Parse each complete line as NDJSON and yield progress updates
      for (const jsonLine of completeLines) {
        try {
          yield JSON.parse(jsonLine) as PullProgress;
        } catch {
          // Skip malformed NDJSON lines (defensive programming)
        }
      }
    }

    // Step 6: Handle any trailing partial data after stream ends
    if (carryBuffer.trim().length > 0) {
      try {
        yield JSON.parse(carryBuffer) as PullProgress;
      } catch {
        // Ignore trailing partial line that couldn't be parsed
      }
    }
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deletes a local model from the Ollama server.
   *
   * How it does it (step by step):
   *   1. List available models to check if the model exists.
   *   2. If model not found, throw 404 error.
   *   3. Send DELETE request to /api/delete with model name.
   *   4. Validate response status.
   *
   * Parameters:
   *   @param {string} name — The model name to delete.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when deletion completes.
   *
   * Throws:
   *   @throws {OllamaError} — When model not found or deletion fails.
   *
   * Dependencies:
   *   - listModels — checks if model exists before deletion.
   *   - this.ollamaFetch — performs HTTP DELETE request.
   *   - readErrorBody — extracts error details from failed responses.
   *
   * Dependants:
   *   - Router — deletes models on user request.
   * </Summary>
   */
  deleteModel = async (name: string): Promise<void> => {
    // Step 1: List available models to check if the model exists
    const availableModels = await this.listModels();

    // Step 2: If model not found, throw 404 error
    // This provides a clear error message before attempting deletion
    if (!availableModels.includes(name)) {
      throw new OllamaError(404, `Model not found: ${name}`);
    }

    // Step 3: Send DELETE request to /api/delete with model name
    const fetchResponse = await this.ollamaFetch(`${this.baseUrl}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    // Step 4: Validate response status
    if (!fetchResponse.ok) {
      throw new OllamaError(
        fetchResponse.status,
        await readErrorBody(fetchResponse),
      );
    }
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Retrieves detailed information about a specific model.
   *
   * How it does it (step by step):
   *   1. Construct the show API URL.
   *   2. Send POST request with model name.
   *   3. Handle network errors with enrichment.
   *   4. Validate response status.
   *   5. Parse and return model information.
   *
   * Parameters:
   *   @param {string} name — The model name to show details for.
   *
   * Returns:
   *   @returns {Promise<ModelInfo>} — Detailed model information.
   *
   * Throws:
   *   @throws {OllamaError} — When HTTP request fails or returns error status.
   *   @throws {Error} — When network error occurs (enriched with context).
   *
   * Dependencies:
   *   - this.ollamaFetch — performs HTTP request.
   *   - enrichOllamaFetchError — adds context to network errors.
   *   - readErrorBody — extracts error details from failed responses.
   *
   * Dependants:
   *   - Router — displays detailed model information.
   * </Summary>
   */
  showModel = async (name: string): Promise<ModelInfo> => {
    // Step 1: Construct the show API URL
    const showApiUrl = `${this.baseUrl}/api/show`;

    let fetchResponse: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      // Step 2: Send POST request with model name
      fetchResponse = await this.ollamaFetch(showApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch (networkError) {
      // Step 3: Handle network errors with enrichment
      throw enrichOllamaFetchError(
        this.baseUrl,
        "show model",
        name,
        networkError,
      );
    }

    // Step 4: Validate response status
    if (!fetchResponse.ok) {
      const errorBody = await readErrorBody(fetchResponse);
      throw new OllamaError(fetchResponse.status, errorBody);
    }

    // Step 5: Parse and return model information
    return (await fetchResponse.json()) as ModelInfo;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Lists currently running models on the Ollama server.
   *
   * How it does it (step by step):
   *   1. Send GET request to /api/ps endpoint.
   *   2. Validate response status.
   *   3. Parse JSON response and extract models array.
   *
   * Returns:
   *   @returns {Promise<RunningModel[]>} — Array of currently running models.
   *
   * Throws:
   *   @throws {OllamaError} — When HTTP request fails or returns error status.
   *
   * Dependencies:
   *   - this.ollamaFetch — performs HTTP request.
   *   - readErrorBody — extracts error details from failed responses.
   *
   * Dependants:
   *   - Router — displays currently running models.
   * </Summary>
   */
  listRunning = async (): Promise<RunningModel[]> => {
    // Step 1: Send GET request to /api/ps endpoint
    // This endpoint returns information about currently loaded/running models
    const fetchResponse = await this.ollamaFetch(`${this.baseUrl}/api/ps`, {
      method: "GET",
    });

    // Step 2: Validate response status
    if (!fetchResponse.ok) {
      throw new OllamaError(
        fetchResponse.status,
        await readErrorBody(fetchResponse),
      );
    }

    // Step 3: Parse JSON response and extract models array
    const responseData = (await fetchResponse.json()) as {
      models?: RunningModel[];
    };

    // Return models array, defaulting to empty array if missing
    return responseData.models ?? [];
  };
}
