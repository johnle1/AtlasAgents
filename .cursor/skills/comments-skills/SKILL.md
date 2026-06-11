# Commenting skill

## What this skill does

Write JSDoc comments and TypeScript interfaces for every method, class,
and interface in the loopycode codebase. Every comment must include a
structured `<Summary>` block so any developer can understand a piece of
code without reading its implementation.

---

## Comment structure — apply this to every method

```js
/**
 * <Summary>
 * What it does:
 *   One sentence describing the single job of this method.
 *
 * How it does it (step by step):
 *   1. First thing that happens.
 *   2. Second thing.
 *   3. And so on until the method returns.
 *
 * Parameters:
 *   @param {type} name — what this value represents and where it comes from.
 *
 * Returns:
 *   @returns {type} — what the return value contains and when it changes.
 *
 * Dependencies (classes/modules this method calls):
 *   - ClassName.methodName — why it needs it.
 *
 * Dependants (classes/modules that call this method):
 *   - ClassName.methodName — why they need it.
 * </Summary>
 */
```

---

## Rules

- Every `class`, `method`, `function`, and `interface` gets a comment block.
- Never skip a method because it looks obvious. Short methods still need a
  `<Summary>` — the dependants section alone justifies it.
- `What it does` is always one sentence. If you need two sentences the method
  is doing two things and should be split.
- `How it does it` lists actual steps in order. Do not copy the code — describe
  intent. "Reads config from disk" not "calls fs.readFileSync".
- `Parameters` — if a method has no parameters write `None`.
- `Returns` — if a method returns void write `void — called for side effects only`.
- `Dependencies` — list every class or module the method imports or calls by
  name. If it has none write `None`.
- `Dependants` — list every class or module that calls this method by name.
  If nothing calls it yet write `None (entry point)`.
- For async methods add `@async` on the line above `<Summary>`.
- For methods that throw add `@throws {ErrorType} — when this happens` inside
  the Summary block, after Returns.

---

## TypeScript interface rule

Every interface gets its own comment block above the interface declaration,
and every property inside the interface gets an inline comment.

```ts
/**
 * <Summary>
 * What it does:
 *   Describes the shape of data this interface enforces.
 *
 * Used by:
 *   - ClassName — why it uses this shape.
 *
 * Produced by:
 *   - ClassName.methodName — which method creates objects of this shape.
 * </Summary>
 */
interface ExampleInterface {
  /** Unique identifier assigned by UserStore on creation. */
  userId: string;

  /** Auth token sent with every RSocket request metadata. */
  token: string;

  /**
   * Role controls which server operations this user can perform.
   * "admin" can pull and delete models. "user" can only pull.
   */
  role: "admin" | "user";
}
```

---

## Class-level comment

Put this above every `class` declaration:

```js
/**
 * <Summary>
 * What it does:
 *   One sentence describing the single responsibility of this class.
 *
 * How it fits in the system:
 *   Where this class sits in the call chain and why it exists as its
 *   own class rather than being folded into another.
 *
 * Dependencies (classes this class imports):
 *   - ClassName — why.
 *
 * Dependants (classes that instantiate or import this class):
 *   - ClassName — why.
 * </Summary>
 */
```

---

## Full worked example — OllamaClient

```ts
/**
 * <Summary>
 * What it does:
 *   Handles all HTTP communication with the local Ollama server so no
 *   other class touches the Ollama API directly.
 *
 * How it fits in the system:
 *   Sits between the orchestration layer (Advisor, Agent) and Ollama.
 *   Centralised here so swapping model servers only requires changing
 *   this one file.
 *
 * Dependencies:
 *   - None (uses built-in fetch / node http).
 *
 * Dependants:
 *   - Advisor — calls chat and chatStream for planning and advising.
 *   - Agent   — calls chatStream for task execution.
 *   - Router  — calls listModels, pullModel, deleteModel, showModel.
 * </Summary>
 */
class OllamaClient {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Sends a single blocking chat request to Ollama and returns the
   *   complete response as a string.
   *
   * How it does it (step by step):
   *   1. Read the Ollama base URL from environment variable.
   *   2. Build request payload with model, messages, options, and stream=false.
   *   3. POST to /api/chat with retry loop (up to 3 attempts).
   *   4. On 503 or timeout: exponential backoff then retry.
   *   5. On success: parse JSON response and extract content string.
   *   6. Return complete response text to caller.
   *
   * Parameters:
   *   @param {string}   model    — Ollama model name e.g. "gemma3:27b".
   *   @param {Message[]} messages — Ordered conversation history including
   *                                 the system prompt and user turn.
   *   @param {ChatOptions} options — Temperature and other sampling settings.
   *
   * Returns:
   *   @returns {Promise<string>} — The model's full response text.
   *
   * Throws:
   *   @throws {OllamaError} — When Ollama is unreachable after all retries.
   *
   * Dependencies:
   *   - None (plain HTTP).
   *
   * Dependants:
   *   - Advisor.plan    — calls this for non-streaming planning requests.
   *   - Advisor.advise  — calls this when an agent escalates.
   * </Summary>
   */
  async chat(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): Promise<string> {
    // ===== STEP 1: Read Base URL =====
    // Step 1a: Retrieve Ollama server base URL from environment
    // Example: "http://localhost:11434"
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

    // ===== STEP 2: Build Request Payload =====
    // Step 2a: Construct request body with all required fields
    // stream: false means return complete response (not chunked)
    const requestBody = {
      model,
      messages,
      stream: false,
      options,
    };

    // ===== STEP 3: Retry Loop with Exponential Backoff =====
    // Step 3a: Initialize retry tracking (max 3 attempts)
    let lastError: Error | null = null;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Step 3b: Calculate backoff delay for this attempt
        // Attempt 0: 0ms delay, Attempt 1: 1000ms, Attempt 2: 2000ms
        const delayMs = attempt > 0 ? Math.pow(2, attempt - 1) * 1000 : 0;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        // Step 3c: POST request to /api/chat endpoint
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        // Step 3d: Check for 503 Service Unavailable (model loading)
        if (response.status === 503) {
          // Server busy; retry (don't throw yet)
          lastError = new Error(
            `Ollama returned 503 on attempt ${attempt + 1}`,
          );
          continue;
        }

        // Step 3e: Check for other HTTP errors
        if (!response.ok) {
          throw new Error(
            `Ollama returned ${response.status}: ${response.statusText}`,
          );
        }

        // Step 3f: Parse JSON response
        const data = await response.json();

        // Step 3g: Extract and return content string from response
        // Response shape: { model, created_at, message: { role, content }, done }
        return data.message.content;
      } catch (error) {
        // Step 3h: Catch timeout or connection errors
        lastError = error instanceof Error ? error : new Error(String(error));

        // Step 3i: On last attempt, throw instead of retry
        if (attempt === maxRetries - 1) {
          throw new Error(
            `Ollama unreachable after ${maxRetries} attempts: ${lastError.message}`,
          );
        }
      }
    }

    // Should never reach here, but TypeScript requires a return
    throw new Error("Unexpected state in chat() retry loop");
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Streams a chat response from Ollama token by token using an
   *   async generator so callers can print each token as it arrives.
   *
   * How it does it (step by step):
   *   1. Read base URL from environment variable.
   *   2. Build request payload with stream=true for chunked response.
   *   3. POST to /api/chat and get response stream.
   *   4. Read response body line by line (newline-delimited JSON).
   *   5. Parse each line as JSON chunk.
   *   6. Extract content string from chunk and yield immediately.
   *   7. Stop when chunk with done: true arrives (end of stream).
   *   8. Throw if stream drops before done flag.
   *
   * Parameters:
   *   @param {string}    model    — Ollama model name.
   *   @param {Message[]} messages — Conversation history.
   *   @param {ChatOptions} options — Sampling settings.
   *
   * Returns:
   *   @returns {AsyncGenerator<string>} — Yields one token string at a time.
   *
   * Throws:
   *   @throws {OllamaError} — When the stream drops mid-response.
   *
   * Dependencies:
   *   - None (plain HTTP streaming).
   *
   * Dependants:
   *   - Advisor.combine    — streams combined result tokens.
   *   - Agent.run          — streams task execution tokens.
   * </Summary>
   */
  async *chatStream(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    // ===== STEP 1: Read Base URL =====
    // Step 1a: Get Ollama server address from environment
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

    // ===== STEP 2: Build Request Payload =====
    // Step 2a: Create request body with stream=true for token-by-token response
    // (unlike chat() which has stream=false)
    const requestBody = {
      model,
      messages,
      stream: true,
      options,
    };

    // ===== STEP 3: POST and Get Response Stream =====
    // Step 3a: Send request to /api/chat endpoint
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    // Step 3b: Check for HTTP errors before reading stream
    if (!response.ok) {
      throw new Error(
        `Ollama returned ${response.status}: ${response.statusText}`,
      );
    }

    // Step 3c: Check response body exists (streaming response)
    if (!response.body) {
      throw new Error("Ollama response body is null (expected streaming body)");
    }

    // ===== STEP 4: Read Stream Line by Line =====
    // Step 4a: Convert response body stream to text reader
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Step 4b: Buffer to accumulate partial lines (in case chunks break mid-line)
    let buffer = "";
    let streamEnded = false;

    try {
      while (true) {
        // Step 4c: Read next chunk of bytes from stream
        const { done, value } = await reader.read();

        // Step 4d: If no more data, mark stream as ended
        if (done) {
          streamEnded = true;
          break;
        }

        // Step 4e: Decode bytes to UTF-8 string
        buffer += decoder.decode(value, { stream: true });

        // ===== STEP 5: Parse Lines as JSON Chunks =====
        // Step 5a: Split buffer by newlines
        const lines = buffer.split("\n");

        // Step 5b: Keep last incomplete line in buffer for next iteration
        // (in case a JSON object spans multiple read() calls)
        buffer = lines[lines.length - 1];

        // Step 5c: Process all complete lines (all but the last)
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();

          // Step 5d: Skip empty lines
          if (line.length === 0) {
            continue;
          }

          // Step 5e: Parse JSON chunk
          // Expected shape: { model, created_at, message: { role, content }, done }
          const chunk = JSON.parse(line);

          // ===== STEP 6: Extract and Yield Content =====
          // Step 6a: Get content string from parsed chunk
          const content = chunk.message?.content || "";

          // Step 6b: Yield token immediately to caller
          // (streaming behavior: caller gets tokens as they arrive)
          if (content.length > 0) {
            yield content;
          }

          // ===== STEP 7: Check for End-of-Stream Marker =====
          // Step 7a: If chunk has done: true, this is the final chunk
          if (chunk.done) {
            // Step 7b: Stream complete; we'll exit the outer while loop
            streamEnded = true;
            return;
          }
        }
      }
    } finally {
      // Step 4f: Always release the reader, even if an error occurred
      reader.releaseLock();
    }

    // ===== STEP 8: Verify Stream Ended Properly =====
    // Step 8a: If we exited the loop without seeing done: true, stream was incomplete
    if (!streamEnded) {
      throw new Error(
        "Ollama stream ended without done flag (unexpected stream termination)",
      );
    }
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns the names of all models currently installed on the Ollama
   *   server so users can pick one for advisor or agent roles.
   *
   * How it does it (step by step):
   *   1. Send GET request to /api/tags endpoint.
   *   2. Parse JSON response to extract models array.
   *   3. Extract just the name field from each model object.
   *   4. Return array of name strings to caller.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<string[]>} — Array of model name strings
   *                                  e.g. ["gemma3:4b", "gemma3:27b"].
   *
   * Throws:
   *   @throws {OllamaError} — When Ollama server is unreachable.
   *
   * Dependencies:
   *   - None.
   *
   * Dependants:
   *   - Router         — handles models.list requests from client.
   *   - CommandHandler — populates /set advisor and /set agent menus.
   * </Summary>
   */
  async listModels(): Promise<string[]> {
    // ===== STEP 1: Setup =====
    // Step 1a: Get base URL from environment
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

    // ===== STEP 2: Fetch Models List =====
    // Step 2a: Send GET request to /api/tags endpoint
    // This endpoint returns all installed models
    const response = await fetch(`${baseUrl}/api/tags`);

    // Step 2b: Check for HTTP errors
    if (!response.ok) {
      throw new Error(
        `Failed to list models: ${response.status} ${response.statusText}`,
      );
    }

    // ===== STEP 3: Parse Response =====
    // Step 3a: Parse JSON response body
    // Response shape: { models: [ { name: "gemma3:4b", digest: "...", ... }, ... ] }
    const data = await response.json();

    // Step 3b: Extract models array from response
    const models = data.models || [];

    // ===== STEP 4: Extract Names Only =====
    // Step 4a: Map models array to just the name strings
    // Filter out any falsy names (shouldn't happen, but defensive)
    const modelNames = models
      .map((model: { name: string }) => model.name)
      .filter((name: string) => name && name.length > 0);

    // ===== STEP 5: Return Result =====
    // Step 5a: Return array of model names to caller
    // Example: ["gemma3:4b", "gemma3:27b", "llama2"]
    return modelNames;
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Downloads a model from the Ollama registry and streams download
   *   progress back to the caller as it goes.
   *
   * How it does it (step by step):
   *   1. Get base URL from environment variable.
   *   2. Build request payload with model name and stream=true.
   *   3. POST to /api/pull and get streaming response.
   *   4. Read response body line by line (newline-delimited JSON).
   *   5. Parse each line as a progress update chunk.
   *   6. Yield PullProgress object from each chunk.
   *   7. Yield final chunk with status "success" when done.
   *   8. Throw if model name not found or download fails.
   *
   * Parameters:
   *   @param {string} name — Model name to download e.g. "gemma3:27b".
   *
   * Returns:
   *   @returns {AsyncGenerator<PullProgress>} — Yields progress objects
   *                                             until download completes.
   *
   * Throws:
   *   @throws {OllamaError} — When the model name is not found in the
   *                            registry or the download fails.
   *
   * Dependencies:
   *   - None.
   *
   * Dependants:
   *   - Router — handles models.pull requests, streams progress to client.
   * </Summary>
   */
  async *pullModel(name: string): AsyncGenerator<PullProgress> {
    // ===== STEP 1: Setup =====
    // Step 1a: Get Ollama base URL from environment
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

    // ===== STEP 2: Build Request Payload =====
    // Step 2a: Create request body with model name and stream=true
    // (stream=true gives us progress updates as download happens)
    const requestBody = {
      name,
      stream: true,
    };

    // ===== STEP 3: POST and Get Response Stream =====
    // Step 3a: Send POST request to /api/pull endpoint
    const response = await fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    // Step 3b: Check for HTTP errors (including 404 if model not found)
    if (!response.ok) {
      throw new Error(
        `Failed to pull model: ${response.status} ${response.statusText}`,
      );
    }

    // Step 3c: Verify response body exists for streaming
    if (!response.body) {
      throw new Error("Response body is null");
    }

    // ===== STEP 4: Read and Parse Stream =====
    // Step 4a: Create text decoder for converting bytes to UTF-8
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Step 4b: Buffer for accumulating partial lines
    let buffer = "";

    try {
      while (true) {
        // Step 4c: Read next chunk of data from stream
        const { done, value } = await reader.read();

        // Step 4d: Exit loop when stream ends
        if (done) {
          break;
        }

        // Step 4e: Decode bytes to UTF-8 string and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Step 4f: Split buffer by newlines to extract complete lines
        const lines = buffer.split("\n");

        // Step 4g: Keep last incomplete line in buffer for next iteration
        buffer = lines[lines.length - 1];

        // ===== STEP 5: Parse Progress Chunks =====
        // Step 5a: Process all complete JSON lines (skip the incomplete last line)
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();

          // Step 5b: Skip empty lines
          if (line.length === 0) {
            continue;
          }

          // Step 5c: Parse JSON chunk
          // Expected shape: { status: "...", completed?: number, total?: number }
          const chunk = JSON.parse(line);

          // ===== STEP 6: Yield Progress Update =====
          // Step 6a: Yield the progress chunk object to caller
          // Caller can use this to update download progress UI
          const progress: PullProgress = {
            status: chunk.status,
            completed: chunk.completed,
            total: chunk.total,
          };

          yield progress;

          // Step 6b: If status is "success", download complete
          // (continue reading remaining stream chunks in case there are more)
        }
      }
    } finally {
      // Step 4h: Always release the reader lock
      reader.releaseLock();
    }

    // ===== STEP 7: End of Stream =====
    // Step 7a: If we get here, stream ended (should see "success" status)
    // Generator automatically completes after all yields
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Permanently removes a model from the Ollama server's disk storage.
   *
   * How it does it (step by step):
   *   1. Get base URL from environment variable.
   *   2. Verify model exists by checking installed models first.
   *   3. Build DELETE request with model name.
   *   4. Send DELETE to /api/delete endpoint.
   *   5. Throw if Ollama returns non-200 HTTP status.
   *   6. Return void after successful deletion.
   *
   * Parameters:
   *   @param {string} name — Exact model name to delete e.g. "gemma3:4b".
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Throws:
   *   @throws {OllamaError} — When the model does not exist or deletion
   *                            fails on the server.
   *
   * Dependencies:
   *   - OllamaClient.listModels — used to verify model exists before deleting.
   *
   * Dependants:
   *   - Router — handles models.delete requests (admin role only).
   * </Summary>
   */
  async deleteModel(name: string): Promise<void> {
    // ===== STEP 1: Setup =====
    // Step 1a: Get Ollama base URL from environment
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

    // ===== STEP 2: Verify Model Exists =====
    // Step 2a: Call listModels to check if this model is installed
    // This prevents sending a delete request for a non-existent model
    const installedModels = await this.listModels();

    // Step 2b: Check if requested model exists in installed list
    const modelExists = installedModels.includes(name);

    // Step 2c: Throw error if model not found
    if (!modelExists) {
      throw new Error(`Model not found: ${name}`);
    }

    // ===== STEP 3: Build DELETE Request =====
    // Step 3a: Create request body with model name
    const requestBody = {
      name,
    };

    // ===== STEP 4: Send DELETE Request =====
    // Step 4a: Send DELETE request to /api/delete endpoint
    const response = await fetch(`${baseUrl}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    // ===== STEP 5: Check Response =====
    // Step 5a: Check for HTTP errors (non-2xx status)
    if (!response.ok) {
      throw new Error(
        `Failed to delete model: ${response.status} ${response.statusText}`,
      );
    }

    // ===== STEP 6: Return =====
    // Step 6a: Return void (no value needed, deletion side-effect complete)
    // If we got here without throwing, deletion succeeded
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns detailed metadata about one installed model including its
   *   size on disk, parameter count, and model family.
   *
   * How it does it (step by step):
   *   1. Get base URL from environment variable.
   *   2. Build request body with model name.
   *   3. POST to /api/show endpoint.
   *   4. Parse JSON response to extract ModelInfo object.
   *   5. Return ModelInfo with size, parameters, family, quantization.
   *
   * Parameters:
   *   @param {string} name — Model name to inspect.
   *
   * Returns:
   *   @returns {Promise<ModelInfo>} — Object containing size, parameters,
   *                                   family, and quantization level.
   *
   * Throws:
   *   @throws {OllamaError} — When the model is not installed.
   *
   * Dependencies:
   *   - None.
   *
   * Dependants:
   *   - Router — handles models.show requests from /models info command.
   * </Summary>
   */
  async showModel(name: string): Promise<ModelInfo> {
    // ===== STEP 1: Setup =====
    // Step 1a: Get Ollama base URL from environment
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

    // ===== STEP 2: Build Request Payload =====
    // Step 2a: Create request body with model name
    const requestBody = {
      name,
    };

    // ===== STEP 3: POST Request =====
    // Step 3a: Send POST request to /api/show endpoint
    // Returns detailed metadata about the model
    const response = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    // Step 3b: Check for HTTP errors (including 404 if model not found)
    if (!response.ok) {
      throw new Error(
        `Model not found or server error: ${response.status} ${response.statusText}`,
      );
    }

    // ===== STEP 4: Parse Response =====
    // Step 4a: Parse JSON response body
    // Response includes: name, size, parameters, family, quantization, etc.
    const data = await response.json();

    // ===== STEP 5: Extract and Return ModelInfo =====
    // Step 5a: Build ModelInfo object from response fields
    // Only include the fields we care about
    const modelInfo: ModelInfo = {
      name: data.name,
      size: data.details?.parameter_size || data.size || 0,
      parameters: data.details?.parameter_count || 0,
      family: data.details?.family || "unknown",
      quantization: data.details?.quantization_level || "unknown",
    };

    // Step 5b: Return model metadata to caller
    return modelInfo;
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns all models currently loaded into RAM or VRAM on the Ollama
   *   server so users can see what is consuming memory right now.
   *
   * How it does it (step by step):
   *   1. Get base URL from environment variable.
   *   2. Send GET request to /api/ps endpoint.
   *   3. Parse JSON response to extract models array.
   *   4. Map each model to RunningModel object.
   *   5. Return array of currently loaded models.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<RunningModel[]>} — Array of models currently in
   *                                        memory with their size and
   *                                        expiry time.
   *
   * Throws:
   *   @throws {OllamaError} — When Ollama server is unreachable.
   *
   * Dependencies:
   *   - None.
   *
   * Dependants:
   *   - Router — handles models.running requests from /models running command.
   * </Summary>
   */
  async listRunning(): Promise<RunningModel[]> {
    // ===== STEP 1: Setup =====
    // Step 1a: Get Ollama base URL from environment
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

    // ===== STEP 2: Fetch Running Models =====
    // Step 2a: Send GET request to /api/ps endpoint
    // /ps = "processes" - returns models currently in memory
    const response = await fetch(`${baseUrl}/api/ps`);

    // Step 2b: Check for HTTP errors
    if (!response.ok) {
      throw new Error(
        `Failed to list running models: ${response.status} ${response.statusText}`,
      );
    }

    // ===== STEP 3: Parse Response =====
    // Step 3a: Parse JSON response body
    // Response shape: { models: [ { name: "...", size: ..., expires_at: ... }, ... ] }
    const data = await response.json();

    // Step 3b: Extract models array from response
    const models = data.models || [];

    // ===== STEP 4: Map to RunningModel Objects =====
    // Step 4a: Transform each model object to RunningModel shape
    const runningModels: RunningModel[] = models.map(
      (model: { name: string; size: number; expires_at: string }) => ({
        name: model.name,
        size: model.size,
        // Step 4b: Convert ISO timestamp string to Unix timestamp (milliseconds)
        expiresAt: new Date(model.expires_at).getTime(),
      }),
    );

    // ===== STEP 5: Return Result =====
    // Step 5a: Return array of running models to caller
    // Caller can use this to show memory usage and expiry times
    return runningModels;
  }
}
```

---

## Interfaces to always define alongside their class

```ts
/**
 * <Summary>
 * What it does:
 *   Represents a single message in a conversation sent to Ollama.
 *
 * Used by:
 *   - OllamaClient.chat       — in the messages array parameter.
 *   - OllamaClient.chatStream — in the messages array parameter.
 *   - Agent.run               — builds message arrays of this shape.
 *   - Advisor.plan            — builds message arrays of this shape.
 * </Summary>
 */
interface Message {
  /** Either "system", "user", or "assistant". */
  role: "system" | "user" | "assistant";

  /** The text content of this message turn. */
  content: string;
}

/**
 * <Summary>
 * What it does:
 *   Sampling settings passed to Ollama to control how the model generates.
 *
 * Used by:
 *   - OllamaClient.chat       — passed as the options field.
 *   - OllamaClient.chatStream — passed as the options field.
 *
 * Produced by:
 *   - ConfigManager.getTemperature — reads user setting and returns this shape.
 * </Summary>
 */
interface ChatOptions {
  /**
   * Controls randomness. 0.0 = deterministic, 1.0 = very creative.
   * Advisor uses 0.1, agents use 0.7 by default.
   */
  temperature: number;
}

/**
 * <Summary>
 * What it does:
 *   One progress update yielded during a model download.
 *
 * Used by:
 *   - OllamaClient.pullModel — yielded from the async generator.
 *   - Router                 — forwarded over RSocket to the client.
 *   - Renderer               — reads this to draw the progress bar.
 * </Summary>
 */
interface PullProgress {
  /**
   * Human readable status string from Ollama.
   * Examples: "pulling manifest", "downloading", "success".
   */
  status: string;

  /** Bytes downloaded so far. Only present when status is "downloading". */
  completed?: number;

  /** Total bytes to download. Only present when status is "downloading". */
  total?: number;
}

/**
 * <Summary>
 * What it does:
 *   Metadata about one installed Ollama model returned by showModel.
 *
 * Used by:
 *   - OllamaClient.showModel — returned as the Promise type.
 *   - Router                 — forwarded to client for /models info display.
 * </Summary>
 */
interface ModelInfo {
  /** Model name including tag e.g. "gemma3:27b". */
  name: string;

  /** Disk size in bytes. */
  size: number;

  /** Number of parameters e.g. 27000000000. */
  parameters: number;

  /** Model architecture family e.g. "gemma". */
  family: string;

  /** Quantization level e.g. "Q4_K_M". */
  quantization: string;
}

/**
 * <Summary>
 * What it does:
 *   Represents a model currently loaded in memory on the Ollama server.
 *
 * Used by:
 *   - OllamaClient.listRunning — returned in the array.
 *   - Router                   — forwarded to client for /models running display.
 * </Summary>
 */
interface RunningModel {
  /** Model name currently loaded. */
  name: string;

  /** Memory consumed in bytes. */
  size: number;

  /**
   * Unix timestamp when Ollama will unload this model from memory
   * if no requests arrive.
   */
  expiresAt: number;
}
```

---

## Quick reference — what goes where

| Block              | Required sections                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| Class              | What it does · How it fits · Dependencies · Dependants                                                    |
| Method             | What it does · How it does it · Parameters · Returns · Throws (if applicable) · Dependencies · Dependants |
| Interface          | What it does · Used by · Produced by                                                                      |
| Interface property | Inline `/** */` describing what the value represents                                                      |

Apply this pattern to every file in the loopycode codebase without exception.
