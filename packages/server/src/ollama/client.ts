/**
 * <Summary>
 * What it does:
 *   Single HTTP gateway to a local Ollama server: blocking chat, streaming chat,
 *   model listing, pull progress, delete, show, and running process list.
 *
 * How it fits in the system:
 *   Implements IOllamaClient and IOllamaAdminClient; Advisor and Agent depend on
 *   the chat surface only.
 *
 * Dependencies:
 *   - global fetch, TextDecoder — Node 18+ HTTP and byte decoding.
 *   - ../orchestration/interfaces.js — IOllamaClient, IOllamaAdminClient contracts.
 *   - ./types.js — OllamaError and admin DTOs.
 *
 * Dependants:
 *   - Advisor, Agent, future Router command handlers.
 * </Summary>
 */

import type {
  IOllamaAdminClient,
  IOllamaClient,
} from "../orchestration/interfaces.js";
import type { ChatOptions, Message } from "../orchestration/types.js";
import type { ModelInfo, PullProgress, RunningModel } from "./types.js";
import { OllamaError } from "./types.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * <Summary>
 * What it does:
 *   Decides whether a thrown error should trigger a transport-level retry.
 *
 * Parameters:
 *   @param {unknown} err — Caught rejection from fetch or stream read.
 *
 * Returns:
 *   @returns {boolean} — True for likely network failures, false for OllamaError.
 *
 * Dependencies:
 *   - OllamaError — excluded from retry.
 *
 * Dependants:
 *   - OllamaClient.chat retry loop.
 * </Summary>
 */
const isRetryableNetworkError = (err: unknown): boolean => {
  // OllamaError is an application-level error; retrying won't help
  if (err instanceof OllamaError) {
    return false;
  }

  // TypeError is typically a low-level protocol or parsing issue worth retrying
  if (err instanceof TypeError) {
    return true;
  }

  // Check for specific system-level network error codes
  if (err instanceof Error) {
    const nodeErr = err as NodeJS.ErrnoException;
    const code = nodeErr.code;

    // Retry on transient network failures:
    // ECONNRESET - connection forcibly closed by peer
    // ECONNREFUSED - server actively refused connection
    // ETIMEDOUT - request exceeded time limit
    // ENOTFOUND - DNS lookup failed (temporary)
    // EAI_AGAIN - DNS server temporarily unavailable
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN"
    ) {
      return true;
    }
  }

  // Unknown error or unrecognized error type: don't retry
  return false;
};

/**
 * <Summary>
 * What it does:
 *   Reads a Response body as UTF-8 text (non-streaming helpers).
 *
 * Parameters:
 *   @param {Response} res — Fetch response with a body.
 *
 * Returns:
 *   @returns {Promise<string>} — Full decoded text (may be empty).
 *
 * Dependants:
 *   - OllamaClient JSON helpers.
 * </Summary>
 */
const readResponseText = async (res: Response): Promise<string> => {
  return res.text();
};

/**
 * <Summary>
 * What it does:
 *   Throws OllamaError when HTTP status is not ok, attaching a short body snippet.
 *
 * Parameters:
 *   @param {Response} res — Fetch response to inspect.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves only when res.ok.
 *
 * @throws {OllamaError} — Always when !res.ok.
 *
 * Dependants:
 *   - OllamaClient admin methods.
 * </Summary>
 */
const assertOk = async (res: Response): Promise<void> => {
  // If the HTTP response status is 2xx, the request succeeded — exit early
  if (res.ok) {
    return;
  }

  // Request failed; extract the response body as text for error context
  const text = await readResponseText(res);

  // Throw an OllamaError with the HTTP status code and response body
  // This terminates the operation and signals the error to the caller
  throw new OllamaError(res.status, text);
};

export class OllamaClient implements IOllamaClient, IOllamaAdminClient {
  private readonly baseUrl: string;

  /**
   * Constructor initializes the Ollama client pointing to the local server instance.
   * Ollama always runs on localhost:11434 for this application.
   */
  constructor() {
    this.baseUrl = "http://localhost:11434";
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   POST /api/chat with stream false, retrying transient network failures up to
   *   three times with exponential backoff, then returns assistant message content.
   *
   * How it does it (step by step):
   *   1. Builds JSON body with model, messages, nested options, stream false.
   *   2. POSTs to /api/chat in a loop with up to three retries on network errors.
   *   3. Parses JSON and returns message.content string.
   *
   * Parameters:
   *   @param {string} model — Ollama model id.
   *   @param {Message[]} messages — Chat turns.
   *   @param {ChatOptions} options — Sampling options (temperature).
   *
   * Returns:
   *   @returns {Promise<string>} — Assistant text only.
   *
   * @throws {OllamaError} — On non-200 after retries or malformed JSON.
   *
   * Dependencies:
   *   - fetch, JSON.parse — HTTP and parsing.
   *
   * Dependants:
   *   - Advisor.plan, Advisor.advise.
   * </Summary>
   */
  chat = async (
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): Promise<string> => {
    // Build the URL to Ollama's chat API endpoint
    const url = `${this.baseUrl}/api/chat`;

    // Construct the request body with model, messages, and settings
    const body = JSON.stringify({
      model, // Which AI model to use (e.g., "llama2")
      messages, // Chat history (user/assistant turns)
      stream: false, // Get full response at once, not streamed
      options: { temperature: options.temperature }, // Creativity level (0-1)
    });

    // Exponential backoff delays: wait longer on each retry (200ms → 400ms → 800ms)
    const delaysMs = [200, 400, 800];
    let attempt = 0; // Track which attempt we're on

    // Infinite loop with retry logic
    while (true) {
      try {
        // Send the POST request to Ollama
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        // If HTTP status is not 2xx (success), extract error message and throw
        if (!res.ok) {
          const text = await readResponseText(res);
          throw new OllamaError(res.status, text);
        }

        // Parse the JSON response
        const data = (await res.json()) as {
          message?: { content?: string };
        };

        // Extract the assistant's text from the nested structure
        const content = data.message?.content;

        // Validate that content is actually a string (not undefined/null)
        if (typeof content !== "string") {
          throw new OllamaError(
            res.status,
            "missing message.content in chat response",
          );
        }

        // Success! Return the assistant's response
        return content;
      } catch (err) {
        // If error is NOT retryable OR we've exhausted all retry attempts, fail immediately
        if (!isRetryableNetworkError(err) || attempt >= delaysMs.length) {
          throw err;
        }

        // Wait before retrying (delays get longer each time: 200ms, 400ms, 800ms)
        await sleep(delaysMs[attempt] ?? 800);

        // Increment attempt counter and retry the loop
        attempt += 1;
      }
    }
  };

  /**
   * <Summary>
   * What it does:
   *   POST /api/chat with stream true and yields incremental assistant deltas from
   *   NDJSON lines until a terminal done chunk.
   *
   * How it does it (step by step):
   *   1. Opens a streaming POST and reads bytes from the response body.
   *   2. Decodes UTF-8, splits on newlines, JSON.parses each complete line.
   *   3. Yields message.content while done is false; stops when done is true.
   *
   * Parameters:
   *   @param {string} model — Ollama model id.
   *   @param {Message[]} messages — Chat turns.
   *   @param {ChatOptions} options — Sampling options.
   *
   * Returns:
   *   @returns {AsyncGenerator<string>} — Token-ish content fragments from Ollama.
   *
   * @throws {OllamaError} — When HTTP not ok or stream missing.
   *
   * Dependants:
   *   - Advisor.combine, Agent.run.
   * </Summary>
   */
  async *chatStream(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    // Build the URL to Ollama's streaming chat API endpoint
    const url = `${this.baseUrl}/api/chat`;

    // POST request with stream: true to enable NDJSON response
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, // Which AI model to use
        messages, // Chat history
        stream: true, // Enable streaming response (NDJSON format)
        options: { temperature: options.temperature }, // Sampling parameters
      }),
    });

    // Validate HTTP response status is successful
    if (!res.ok) {
      const text = await readResponseText(res);
      throw new OllamaError(res.status, text);
    }

    // Verify response has a readable body stream
    if (!res.body) {
      throw new OllamaError(
        res.status,
        "missing response body for chat stream",
      );
    }

    // Create a reader to incrementally consume the response stream
    const reader = res.body.getReader();

    // TextDecoder converts byte chunks into UTF-8 strings
    const decoder = new TextDecoder();

    // Buffer to hold incomplete lines that span multiple read() calls
    let carry = "";

    // Main loop: read bytes until stream ends (done === true)
    while (true) {
      const { done, value } = await reader.read();

      // Stream exhausted; process any remaining buffered data below
      if (done) {
        break;
      }

      // Decode the byte chunk as UTF-8 text and append to buffer
      carry += decoder.decode(value, { stream: true });

      // Split on newlines to extract complete NDJSON lines
      const parts = carry.split("\n");

      // Keep the last (incomplete) part in carry for the next read
      carry = parts.pop() ?? "";

      // Process all complete lines
      for (const line of parts) {
        // Remove leading/trailing whitespace from the line
        const ndjsonLine = line.trim();

        // Skip empty lines (often between NDJSON objects)
        if (ndjsonLine.length === 0) {
          continue;
        }

        // Parse the NDJSON line into a chunk object
        let chunk: { done?: boolean; message?: { content?: string } };
        try {
          chunk = JSON.parse(ndjsonLine) as typeof chunk;
        } catch {
          // Invalid JSON in stream; fail with error context
          throw new OllamaError(
            500,
            `invalid NDJSON line in chat stream: ${ndjsonLine.slice(0, 200)}`,
          );
        }

        // If this chunk signals completion, stop yielding and exit
        if (chunk.done === true) {
          return;
        }

        // Extract the message content from the nested structure
        const piece = chunk.message?.content;

        // Yield the content only if it's a non-empty string
        if (typeof piece === "string" && piece.length > 0) {
          yield piece;
        }
      }
    }

    // After stream ends, process any remaining buffered data
    const tail = carry.trim();

    // If there's leftover data, it should be one final NDJSON object
    if (tail.length > 0) {
      let chunk: { done?: boolean; message?: { content?: string } };
      try {
        chunk = JSON.parse(tail) as typeof chunk;
      } catch {
        // Malformed trailing NDJSON; fail with error context
        throw new OllamaError(
          500,
          `invalid trailing NDJSON in chat stream: ${tail.slice(0, 200)}`,
        );
      }

      // Only yield if this final chunk has content and is not marked done
      if (chunk.done !== true) {
        const piece = chunk.message?.content;
        if (typeof piece === "string" && piece.length > 0) {
          yield piece;
        }
      }
    }
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   GET /api/tags endpoint and extracts just the model names (strings only).
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<string[]>} — Array of installed model names (e.g., ["llama2", "mistral"]).
   *
   * @throws {OllamaError} — When HTTP request fails or response not ok.
   *
   * Dependants:
   *   - Router.models.list, deleteModel (pre-existence check).
   * </Summary>
   */
  listModels = async (): Promise<string[]> => {
    // Step 1: Fetch the list of installed models from Ollama's /api/tags endpoint
    const res = await fetch(`${this.baseUrl}/api/tags`, { method: "GET" });

    // Step 2: Validate HTTP response is successful (2xx status)
    await assertOk(res);

    // Step 3: Parse response JSON into typed structure
    const data = (await res.json()) as { models?: { name?: string }[] };

    // Step 4: Safely extract models array (default to empty if undefined)
    const modelObjects = Array.isArray(data.models) ? data.models : [];

    // Step 5: Extract and filter names in a single pass (optimal performance)
    // Loop through each model object and build the final list directly
    const validNames: string[] = [];
    for (const model of modelObjects) {
      // Check if name is a valid string
      if (typeof model.name === "string") {
        // Check if name is non-empty
        if (model.name.length > 0) {
          // Add to final list immediately (no intermediate arrays)
          validNames.push(model.name);
        }
      }
    }

    // Step 6: Return the cleaned list of model names
    return validNames;
  };

  /**
   * <Summary>
   * What it does:
   *   POST /api/pull with stream true and yields PullProgress objects per NDJSON line
   *   until a success status chunk.
   *
   * How it does it (step by step):
   *   1. Builds POST request to /api/pull with stream enabled.
   *   2. Validates HTTP response is successful.
   *   3. Creates a reader to incrementally consume NDJSON response bytes.
   *   4. Decodes UTF-8, splits on newlines, JSON.parses each complete line.
   *   5. Yields progress objects (status, completed, total) per chunk.
   *   6. Stops when status is "success" or stream ends.
   *
   * Parameters:
   *   @param {string} name — Model name to pull from Ollama registry.
   *
   * Returns:
   *   @returns {AsyncGenerator<PullProgress>} — Progress updates ending at success.
   *
   * @throws {OllamaError} — When HTTP not ok or malformed NDJSON.
   *
   * Dependants:
   *   - Future pull UI, model download handlers.
   * </Summary>
   */
  async *pullModel(name: string): AsyncGenerator<PullProgress> {
    // Step 1: Build the URL to Ollama's pull API endpoint
    const url = `${this.baseUrl}/api/pull`;

    // Step 2: Send POST request with stream enabled to get progress updates
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name, stream: true }),
    });

    // Step 3: Validate HTTP response is successful (2xx status)
    if (!res.ok) {
      const text = await readResponseText(res);
      throw new OllamaError(res.status, text);
    }

    // Step 4: Verify response has a readable body stream
    if (!res.body) {
      throw new OllamaError(
        res.status,
        "missing response body for pull stream",
      );
    }

    // Step 5: Create a reader to incrementally consume the response stream
    const reader = res.body.getReader();

    // Step 6: TextDecoder converts byte chunks into UTF-8 strings
    const decoder = new TextDecoder();

    // Step 7: Buffer to hold incomplete lines that span multiple read() calls
    // Example: if a 50-byte NDJSON object is split across two reads (30 bytes + 20 bytes),
    // we keep the incomplete first 30 bytes in carry for the next iteration
    let carry = "";

    // Step 8: Main loop: read bytes until stream ends
    while (true) {
      // Read the next chunk of bytes from the response stream
      const { done, value } = await reader.read();

      // Stream exhausted; process any remaining buffered data below
      if (done) {
        break;
      }

      // Decode the byte chunk as UTF-8 text and append to buffer
      // stream: true allows partial UTF-8 sequences to be carried over
      carry += decoder.decode(value, { stream: true });

      // Split on newlines to extract complete NDJSON lines
      // Example: carry = '{"status":"downloading"}\n{"status":"v'
      // parts = ['{"status":"downloading"}', '{"status":"v']
      const parts = carry.split("\n");

      // Keep the last (incomplete) part in carry for the next read
      // We pop from parts, so carry gets the last element (still incomplete)
      carry = parts.pop() ?? "";

      // Step 9: Process all complete lines (all except the last incomplete one)
      for (const line of parts) {
        // Remove leading/trailing whitespace from the line
        const ndjsonLine = line.trim();

        // Skip empty lines (often between NDJSON objects or at boundaries)
        if (ndjsonLine.length === 0) {
          continue;
        }

        // Parse the NDJSON line into a progress chunk object
        let chunk: {
          status?: string;
          completed?: number;
          total?: number;
        };
        try {
          chunk = JSON.parse(ndjsonLine) as typeof chunk;
        } catch {
          // Invalid JSON in stream; fail with error context showing first 200 chars
          throw new OllamaError(
            500,
            `invalid NDJSON line in pull stream: ${ndjsonLine.slice(0, 200)}`,
          );
        }

        // Step 10: Extract the status field, defaulting to "unknown" if missing
        // Example statuses: "pulling manifest", "downloading", "verifying", "success"
        const status =
          typeof chunk.status === "string" ? chunk.status : "unknown";

        // Step 11: Build the progress object with download metrics
        const progress: PullProgress = {
          status, // Current operation (e.g., "downloading", "verifying")
          completed: chunk.completed, // Bytes downloaded so far
          total: chunk.total, // Total bytes to download
        };

        // Step 12: Yield progress to caller (allows streaming progress updates)
        yield progress;

        // Step 13: Terminal status — model download complete, stop generator
        if (status === "success") {
          return;
        }
      }
    }

    // Step 14: After stream ends, process any remaining buffered data
    // This handles the last partial line that may not end with a newline
    const tail = carry.trim();

    // Step 15: If there's leftover data, it should be one final NDJSON object
    if (tail.length > 0) {
      let chunk: { status?: string; completed?: number; total?: number };
      try {
        chunk = JSON.parse(tail) as typeof chunk;
      } catch {
        // Malformed trailing NDJSON; fail with error context
        throw new OllamaError(
          500,
          `invalid trailing NDJSON in pull stream: ${tail.slice(0, 200)}`,
        );
      }

      // Extract the status field from the trailing chunk
      const status =
        typeof chunk.status === "string" ? chunk.status : "unknown";

      // Step 16: Yield the final progress object before exiting
      yield {
        status,
        completed: chunk.completed,
        total: chunk.total,
      };
    }
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Verifies a model exists via listModels, then DELETE /api/delete with JSON body.
   *
   * How it does it (step by step):
   *   1. Fetch the list of all installed models from Ollama.
   *   2. Check if the target model exists in the list.
   *   3. If not found, throw a 404 error immediately.
   *   4. If found, build a DELETE request to /api/delete endpoint.
   *   5. Send the DELETE request with the model name in the body.
   *   6. Validate HTTP response is successful (2xx status).
   *   7. Return (Promise resolves to void on success).
   *
   * Parameters:
   *   @param {string} name — Model name to delete from Ollama.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes on success.
   *
   * @throws {OllamaError} — 404 when model missing; HTTP error code on delete failure.
   *
   * Dependants:
   *   - Future admin routes, model cleanup handlers.
   * </Summary>
   */
  deleteModel = async (name: string): Promise<void> => {
    // Step 1: Fetch the list of all installed models from Ollama
    // This ensures the model exists before attempting deletion
    const names = await this.listModels();

    // Step 2: Check if the target model exists in the list
    // Step 3: If model is not found, throw 404 error immediately
    // This prevents attempting to delete non-existent models
    if (!names.includes(name)) {
      throw new OllamaError(404, `model not found: ${name}`);
    }

    // Step 4: Build DELETE request to /api/delete endpoint
    // Step 5: Send the DELETE request with model name in JSON body
    const res = await fetch(`${this.baseUrl}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }), // Model identifier for deletion
    });

    // Step 6: Validate HTTP response is successful (2xx status)
    // Throws OllamaError with status code and response body on failure
    await assertOk(res);

    // Step 7: Return (Promise resolves to void on success)
    // Implicit return; no additional processing needed
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   POST /api/show and returns the parsed JSON as ModelInfo.
   *
   * How it does it (step by step):
   *   1. Build POST request to /api/show with model name in body.
   *   2. Send the request to fetch detailed model metadata.
   *   3. Validate HTTP response is successful (2xx status).
   *   4. Parse the response JSON into ModelInfo typed object.
   *   5. Return the model information to caller.
   *
   * Parameters:
   *   @param {string} name — Model name to show (e.g., "llama2", "mistral").
   *
   * Returns:
   *   @returns {Promise<ModelInfo>} — Parsed model metadata (name, size, format, etc.).
   *
   * @throws {OllamaError} — When HTTP not ok or JSON parse fails.
   *
   * Dependants:
   *   - Future tooling routes, model inspection handlers.
   * </Summary>
   */
  showModel = async (name: string): Promise<ModelInfo> => {
    // Step 1: Build POST request to /api/show with model name in body
    // Step 2: Send the request to fetch detailed model metadata from Ollama
    const res = await fetch(`${this.baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }), // Model identifier to query
    });

    // Step 3: Validate HTTP response is successful (2xx status)
    // Throws OllamaError with status code and response body on failure
    await assertOk(res);

    // Step 4: Parse the response JSON into ModelInfo typed object
    // ModelInfo contains model details: name, size, format, parameters, etc.
    // Step 5: Return the model information to caller
    return (await res.json()) as ModelInfo;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   GET /api/ps and returns the list of currently running models from Ollama.
   *
   * How it does it (step by step):
   *   1. Send GET request to /api/ps to fetch running models status.
   *   2. Validate HTTP response is successful (2xx status).
   *   3. Parse the response JSON into typed structure.
   *   4. Safely extract models array (default to empty if undefined).
   *   5. Return the array of running models to caller.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<RunningModel[]>} — Array of running models (empty when none active).
   *
   * @throws {OllamaError} — When HTTP not ok or response malformed.
   *
   * Dependants:
   *   - Future diagnostics routes, model status monitoring.
   * </Summary>
   */
  listRunning = async (): Promise<RunningModel[]> => {
    // Step 1: Send GET request to /api/ps to fetch running models status
    // /api/ps returns JSON with currently active models and their memory usage
    const res = await fetch(`${this.baseUrl}/api/ps`, { method: "GET" });

    // Step 2: Validate HTTP response is successful (2xx status)
    // Throws OllamaError with status code and response body on failure
    await assertOk(res);

    // Step 3: Parse the response JSON into typed structure
    const data = (await res.json()) as { models?: RunningModel[] };

    // Step 4: Safely extract models array (default to empty if undefined)
    // This handles the case where no models are currently running
    // Returns empty array if data.models is undefined or not an array
    // Step 5: Return the array of running models to caller
    return Array.isArray(data.models) ? data.models : [];
  };
}
