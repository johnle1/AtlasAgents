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
   * How it does it:
   *   1. Reads the Ollama base URL from the environment variable.
   *   2. Posts the model name, message array, and options to /api/chat
   *      with stream set to false.
   *   3. Retries up to three times with exponential backoff if Ollama
   *      returns a 503 or times out.
   *   4. Parses the JSON response and returns the content string.
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
  ): Promise<string> {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Streams a chat response from Ollama token by token using an
   *   async generator so callers can print each token as it arrives.
   *
   * How it does it:
   *   1. Posts to /api/chat with stream set to true.
   *   2. Reads the response body as a stream line by line.
   *   3. Parses each line as a JSON chunk.
   *   4. Yields the content string from each chunk immediately.
   *   5. Stops when a chunk with done: true arrives.
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
  ): AsyncGenerator<string> {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns the names of all models currently installed on the Ollama
   *   server so users can pick one for advisor or agent roles.
   *
   * How it does it:
   *   1. Sends GET request to /api/tags.
   *   2. Parses the models array from the response.
   *   3. Returns just the name strings, discarding size and digest.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<string[]>} — Array of model name strings
   *                                  e.g. ["gemma3:4b", "gemma3:27b"].
   *
   * Dependencies:
   *   - None.
   *
   * Dependants:
   *   - Router         — handles models.list requests from client.
   *   - CommandHandler — populates /set advisor and /set agent menus.
   * </Summary>
   */
  async listModels(): Promise<string[]> {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Downloads a model from the Ollama registry and streams download
   *   progress back to the caller as it goes.
   *
   * How it does it:
   *   1. Posts the model name to /api/pull with stream true.
   *   2. Reads each progress chunk from the stream.
   *   3. Yields a PullProgress object containing status, completed
   *      bytes, and total bytes on each chunk.
   *   4. Yields a final chunk with status "success" when complete.
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
  async *pullModel(name: string): AsyncGenerator<PullProgress> {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Permanently removes a model from the Ollama server's disk storage.
   *
   * How it does it:
   *   1. Verifies the model exists by calling listModels first.
   *   2. Posts a DELETE request to /api/delete with the model name.
   *   3. Throws if Ollama returns a non-200 status.
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
  async deleteModel(name: string): Promise<void> {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns detailed metadata about one installed model including its
   *   size on disk, parameter count, and model family.
   *
   * How it does it:
   *   1. Posts the model name to /api/show.
   *   2. Parses and returns the ModelInfo object from the response.
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
  async showModel(name: string): Promise<ModelInfo> {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns all models currently loaded into RAM or VRAM on the Ollama
   *   server so users can see what is consuming memory right now.
   *
   * How it does it:
   *   1. Sends GET to /api/ps.
   *   2. Returns the parsed array of running model objects.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<RunningModel[]>} — Array of models currently in
   *                                        memory with their size and
   *                                        expiry time.
   *
   * Dependencies:
   *   - None.
   *
   * Dependants:
   *   - Router — handles models.running requests from /models running command.
   * </Summary>
   */
  async listRunning(): Promise<RunningModel[]> {}
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
