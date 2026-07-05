---
name: commenting-oss
description: "Write doc comments for open-source TypeScript and JavaScript projects — the kind that let a stranger who just cloned the repo understand how to use, extend, and contribute to the code without reading the entire implementation. Use this when adding or reviewing comments on any public API (exported class, function, method, interface, type), when asked to 'document this for open source,' 'make this contributor-friendly,' 'add JSDoc/TSDoc,' 'write API docs,' or before tagging a release. Follows TSDoc for .ts/.tsx files and JSDoc for .js/.jsx files. Prioritizes the reader who has never seen this codebase before — lead with why, not just what; show runnable examples for non-obvious usage; document every thrown error and edge case; never assume internal knowledge."
---

# Commenting for Open-Source Projects (TSDoc / JSDoc)

## The core difference from internal comments

Internal comments can say "Advisor calls this for planning." That means nothing to someone who found your repo on GitHub. Open-source comments must be **self-contained**: they explain the _what_, the _why_, the _gotchas_, and how to actually use the thing — without assuming the reader knows your architecture, your team's vocabulary, or even what the project does.

Write every comment as if the reader:

- Just ran `npm install your-package` ten minutes ago
- Has never heard of your internal class names
- Will not read your source code unless something breaks
- Is trying to decide in 30 seconds whether your API does what they need

---

## Which standard applies

| File type      | Standard  | Key rule                                                                                                                          |
| -------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `.ts` / `.tsx` | **TSDoc** | No `{type}` in `@param` — the compiler owns types. Write `@param model - description`, not `@param {string} model - description`. |
| `.js` / `.jsx` | **JSDoc** | Include `{type}` in `@param` and `@returns` — they're the only type information that exists.                                      |

When in doubt, check the file extension. Default to TSDoc for TypeScript projects.

---

## What to document

**Always document:**

- Every exported / public class, function, method, type, and interface — anything a consumer can import.
- Any non-obvious behavior: retries, caching, side effects, async generators, rate limits, pagination.
- Anything that throws — every reachable error path a caller can encounter.
- Edge cases that surprised you while writing the code (they'll surprise callers too).
- Design decisions and tradeoffs that aren't obvious from the signature.

**Skip the ceremony for:**

- Private implementation details that no consumer ever touches.
- Trivial one-liners where the name + types already say everything (`getId(): string`).
- Internal helper functions that aren't exported.

The test: _would a first-time contributor understand this method's contract from its comment alone, without reading the body?_ If yes, the comment is earning its place.

---

## Method / function template

```ts
/**
 * One-sentence summary: what this does for the caller, imperative mood,
 * ends with a period. Focus on the outcome, not the mechanism.
 *
 * @remarks
 * Use this block for:
 * - WHY this exists (what problem it solves and why it was designed this way)
 * - Non-obvious behavior (retries, rate limits, caching, ordering requirements)
 * - Tradeoffs and known limitations a caller should know about
 * - Links to relevant issues, specs, or external docs
 *
 * Omit @remarks if the summary line already covers everything.
 *
 * @param paramName - What this value represents, valid range/format, and
 *   what happens at the boundary (null, empty string, negative number, etc.).
 *   For .ts files: no {type} in brackets — TypeScript declares it.
 *   For .js files: include {type} in brackets — it's the only type info that exists.
 * @returns What the resolved value contains, including shape for objects and
 *   what changes between calls (e.g. "sorted by insertion order").
 * @throws {@link ErrorClassName} When and why this throws, and what the
 *   caller should do about it.
 *
 * @example
 * // Show a real, copy-pasteable usage that a newcomer can run immediately.
 * // Include enough context that it makes sense without reading the source.
 * const result = await client.fetchUser("user_123");
 * console.log(result.displayName); // "Ada Lovelace"
 *
 * @example <caption>Error case</caption>
 * // Show common error cases too if they're non-obvious.
 * try {
 *   await client.fetchUser("nonexistent");
 * } catch (err) {
 *   if (err instanceof NotFoundError) {
 *     // handle gracefully
 *   }
 * }
 *
 * @see {@link RelatedClass} for the broader context this belongs to.
 * @see {@link https://example.com/docs relevant external doc}
 */
```

**`@example` is not optional for open source.** If your method takes an async generator, a callback, a non-obvious options shape, or has a tricky error pattern — show it. Code examples are the single highest-leverage thing in a public API comment. Use `<caption>` to label multiple examples.

---

## Class template

```ts
/**
 * One-sentence summary of what this class does for a consumer who has
 * never seen your codebase.
 *
 * @remarks
 * Explain:
 * - The problem this class solves and when to reach for it
 * - How it fits into a typical usage flow (instantiation → usage → cleanup)
 * - Any stateful behavior, thread-safety notes, or lifecycle requirements
 * - Links to getting-started guides, related classes, or relevant issues
 *
 * @example
 * // Minimal working example — enough to go from zero to running.
 * const client = new OllamaClient({ baseUrl: "http://localhost:11434" });
 * const response = await client.chat("gemma3:27b", messages, { temperature: 0.7 });
 * console.log(response);
 *
 * @see {@link https://github.com/your-org/your-repo/blob/main/README.md Getting started}
 */
```

---

## Interface / type template

```ts
/**
 * One-sentence description of what this shape represents.
 *
 * @remarks
 * Include this block when: the interface has a non-obvious purpose,
 * represents a protocol/wire format, or has interdependencies between
 * fields (e.g. "field B is only present when field A is 'active'").
 *
 * @example
 * const message: Message = { role: "user", content: "Hello" };
 */
interface Message {
  /**
   * The role this message represents in the conversation.
   *
   * @remarks
   * Ollama requires exactly one "system" role message at index 0.
   * Subsequent messages must alternate "user" / "assistant".
   */
  role: "system" | "user" | "assistant";

  /** The text content of this message turn. */
  content: string;
}
```

Document every property with an inline `/** */`. For simple properties where
the name says everything, one sentence is enough. For properties with
constraints, valid ranges, or interdependencies — say so.

---

## Inline implementation comments

Inside method bodies, `//` comments are for things the code can't express:

- **Why** something non-obvious was done (not what — the code shows what)
- A workaround with a link to the upstream issue
- A hardcoded value that looks wrong but isn't
- An ordering constraint that breaks silently if violated

```ts
// Ollama sends 503 while the model is loading into VRAM — retry rather
// than surfacing this as an error to the caller. See: github.com/ollama/ollama/issues/1234
if (response.status === 503) { ... }

// Backoff starts at 1 s on the second attempt, not the first, so the
// common single-retry case stays fast.
const delayMs = attempt > 0 ? Math.pow(2, attempt - 1) * 1000 : 0;
```

Delete comments that just restate the code in English:

```ts
// BAD — the code already says this
// Loop through models
for (const model of models) { ... }

// GOOD — explains something the code can't
// Process in insertion order so the UI renders models in the
// sequence the user pulled them, not alphabetically.
for (const model of models) { ... }
```

---

## Worked example — OllamaClient

````ts
/**
 * Lightweight HTTP client for the Ollama REST API.
 *
 * @remarks
 * This class handles all communication with a locally-running Ollama
 * server. It provides both blocking (`chat`) and streaming (`chatStream`)
 * variants for inference, plus model management operations (list, pull,
 * delete, inspect).
 *
 * **Retry behavior:** `chat` retries up to 3 times with exponential
 * backoff on 503 responses (returned by Ollama while a model loads
 * into memory). Streaming methods do not retry — a dropped stream
 * throws immediately so callers can decide how to recover.
 *
 * @example
 * ```ts
 * const client = new OllamaClient();
 *
 * // Blocking inference
 * const reply = await client.chat(
 *   "gemma3:27b",
 *   [{ role: "user", content: "Hello!" }],
 *   { temperature: 0.7 }
 * );
 * console.log(reply); // "Hi! How can I help you today?"
 *
 * // Streaming inference
 * for await (const token of client.chatStream("gemma3:27b", messages, opts)) {
 *   process.stdout.write(token);
 * }
 * ```
 *
 * @see {@link https://github.com/ollama/ollama/blob/main/docs/api.md Ollama API reference}
 */
class OllamaClient {

  /**
   * Sends a blocking chat request to Ollama and returns the complete
   * response as a string.
   *
   * @remarks
   * Retries up to 3 times with exponential backoff (1 s, 2 s) when
   * Ollama returns 503, which it does while a model is loading into
   * VRAM. Any other non-2xx status throws immediately.
   *
   * Use `chatStream` instead when you want to display tokens as they
   * arrive rather than waiting for the full response.
   *
   * @param model - Ollama model name, e.g. `"gemma3:27b"`. Must match
   *   an installed model exactly — use `listModels` to enumerate them.
   * @param messages - Ordered conversation history. The first entry
   *   should be a system prompt (`role: "system"`), followed by
   *   alternating user and assistant turns.
   * @param options - Sampling configuration. Pass `{ temperature: 0 }`
   *   for deterministic output, `{ temperature: 1 }` for maximum
   *   creativity.
   * @returns The model's complete response text.
   * @throws {@link OllamaError} if Ollama is unreachable after 3 retries,
   *   or if the server returns a non-503 HTTP error.
   *
   * @example
   * ```ts
   * const client = new OllamaClient();
   * const messages = [
   *   { role: "system", content: "You are a helpful assistant." },
   *   { role: "user", content: "What is 2 + 2?" }
   * ];
   * const answer = await client.chat("gemma3:4b", messages, { temperature: 0 });
   * console.log(answer); // "4"
   * ```
   */
  async chat(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): Promise<string> { ... }

  /**
   * Streams a chat response from Ollama, yielding one token at a time.
   *
   * @remarks
   * Yields each token as it arrives so you can render progressive output
   * without waiting for the full response. If the HTTP stream drops
   * before Ollama sends `done: true`, this throws — a truncated response
   * is surfaced as an error rather than silently returned as partial text.
   *
   * @param model - Ollama model name.
   * @param messages - Ordered conversation history.
   * @param options - Sampling configuration.
   * @returns An async generator — each yielded value is a raw token string.
   *   Tokens may be single characters, subwords, or whole words depending
   *   on the model's tokenizer.
   * @throws {@link OllamaError} if the response stream drops mid-generation.
   *
   * @example
   * ```ts
   * const client = new OllamaClient();
   * const messages = [{ role: "user", content: "Tell me a joke." }];
   *
   * process.stdout.write("Assistant: ");
   * for await (const token of client.chatStream("gemma3:4b", messages, { temperature: 0.8 })) {
   *   process.stdout.write(token); // prints each token as it arrives
   * }
   * console.log(); // newline after stream ends
   * ```
   */
  async *chatStream(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<string> { ... }

  /**
   * Returns the names of all models installed on the Ollama server.
   *
   * @returns Array of installed model name strings,
   *   e.g. `["gemma3:4b", "gemma3:27b", "llama3:8b"]`.
   *   Returns an empty array if no models are installed.
   * @throws {@link OllamaError} if the Ollama server is unreachable.
   *
   * @example
   * ```ts
   * const models = await client.listModels();
   * if (!models.includes("gemma3:27b")) {
   *   console.log("Model not installed — run: ollama pull gemma3:27b");
   * }
   * ```
   */
  async listModels(): Promise<string[]> { ... }

  /**
   * Downloads a model from the Ollama registry, yielding progress
   * updates as the download proceeds.
   *
   * @remarks
   * Large models can be several gigabytes. Each yielded `PullProgress`
   * object carries `completed` and `total` byte counts while downloading,
   * and a final `{ status: "success" }` when the download finishes.
   *
   * @param name - Model name to download, e.g. `"gemma3:27b"`. Uses
   *   Ollama's registry naming — see the
   *   [Ollama model library](https://ollama.com/library) for available names.
   * @returns An async generator yielding progress updates until complete.
   * @throws {@link OllamaError} if the model name isn't found in the
   *   registry or the download fails part-way through.
   *
   * @example
   * ```ts
   * for await (const progress of client.pullModel("gemma3:27b")) {
   *   if (progress.completed && progress.total) {
   *     const pct = Math.round((progress.completed / progress.total) * 100);
   *     process.stdout.write(`\rDownloading... ${pct}%`);
   *   } else {
   *     console.log(progress.status); // "pulling manifest", "verifying sha256", etc.
   *   }
   * }
   * console.log("Done!");
   * ```
   */
  async *pullModel(name: string): AsyncGenerator<PullProgress> { ... }

  /**
   * Permanently removes a model from the Ollama server's disk storage.
   *
   * @remarks
   * This is irreversible. The model must be re-downloaded via `pullModel`
   * to use it again. Pass the exact name returned by `listModels` —
   * including the tag (e.g. `"gemma3:4b"`, not `"gemma3"`).
   *
   * @param name - Exact model name to delete, including tag.
   * @throws {@link OllamaError} if the model doesn't exist or if the
   *   server returns an error during deletion.
   *
   * @example
   * ```ts
   * const models = await client.listModels();
   * if (models.includes("gemma3:4b")) {
   *   await client.deleteModel("gemma3:4b");
   *   console.log("Deleted.");
   * }
   * ```
   */
  async deleteModel(name: string): Promise<void> { ... }

  /**
   * Returns metadata for one installed model: disk size, parameter
   * count, architecture family, and quantization level.
   *
   * @param name - Model name to inspect. Must be installed locally —
   *   use `listModels` to confirm before calling.
   * @returns A `ModelInfo` object with size, parameters, family, and
   *   quantization fields populated.
   * @throws {@link OllamaError} if the model isn't installed.
   *
   * @example
   * ```ts
   * const info = await client.showModel("gemma3:27b");
   * console.log(`${info.name}: ${info.quantization}, ${info.parameters / 1e9}B params`);
   * // "gemma3:27b: Q4_K_M, 27B params"
   * ```
   */
  async showModel(name: string): Promise<ModelInfo> { ... }

  /**
   * Returns all models currently loaded in RAM or VRAM on the Ollama
   * server, along with their memory usage and idle-unload time.
   *
   * @remarks
   * Ollama keeps models in memory for a configurable TTL after the last
   * request (default 5 minutes). `expiresAt` tells you when Ollama will
   * unload the model if no requests arrive — useful for surfacing current
   * memory pressure to users.
   *
   * @returns Array of loaded models. Empty if no models are in memory.
   * @throws {@link OllamaError} if the server is unreachable.
   *
   * @example
   * ```ts
   * const running = await client.listRunning();
   * for (const model of running) {
   *   const mb = (model.size / 1024 / 1024).toFixed(0);
   *   const expiresIn = Math.round((model.expiresAt - Date.now()) / 1000);
   *   console.log(`${model.name}: ${mb} MB, unloads in ${expiresIn}s`);
   * }
   * ```
   */
  async listRunning(): Promise<RunningModel[]> { ... }
}
````

### Supporting interfaces

````ts
/**
 * A single message turn in a conversation sent to the Ollama API.
 *
 * @remarks
 * Conversations must start with a `"system"` role message, followed by
 * alternating `"user"` and `"assistant"` turns. Ollama will return an
 * error if this ordering is violated.
 *
 * @example
 * ```ts
 * const messages: Message[] = [
 *   { role: "system", content: "You are a helpful assistant." },
 *   { role: "user",   content: "Explain async generators in one sentence." },
 * ];
 * ```
 */
interface Message {
  /** Who authored this turn. */
  role: "system" | "user" | "assistant";

  /** The text content of this message turn. */
  content: string;
}

/**
 * Sampling settings passed to Ollama to control how the model generates text.
 *
 * @see {@link https://github.com/ollama/ollama/blob/main/docs/modelfile.md#valid-parameters-and-values Ollama parameter reference}
 */
interface ChatOptions {
  /**
   * Controls output randomness. `0.0` is fully deterministic (same prompt
   * always produces the same output); `1.0` is highly creative but less
   * consistent. Values above `1.0` are valid but rarely useful.
   *
   * @defaultValue `0.7`
   */
  temperature: number;
}

/**
 * One progress update yielded during a model download via `pullModel`.
 *
 * @remarks
 * `completed` and `total` are only populated while `status` is
 * `"downloading"`. During other phases (manifest pull, digest
 * verification) they will be `undefined`.
 */
interface PullProgress {
  /** Human-readable status from Ollama, e.g. `"pulling manifest"`, `"downloading"`, `"success"`. */
  status: string;

  /** Bytes downloaded so far. Only present when `status` is `"downloading"`. */
  completed?: number;

  /** Total bytes to download. Only present when `status` is `"downloading"`. */
  total?: number;
}

/**
 * Metadata about one installed Ollama model, as returned by `showModel`.
 */
interface ModelInfo {
  /** Full model name including tag, e.g. `"gemma3:27b"`. */
  name: string;

  /** Disk size in bytes. */
  size: number;

  /** Total parameter count, e.g. `27_000_000_000` for a 27B model. */
  parameters: number;

  /** Model architecture family, e.g. `"gemma"` or `"llama"`. */
  family: string;

  /** Quantization level, e.g. `"Q4_K_M"`. Lower = smaller but less accurate. */
  quantization: string;
}

/**
 * A model currently loaded in memory on the Ollama server.
 *
 * @remarks
 * Ollama unloads models after an idle TTL (default 5 minutes).
 * `expiresAt` is the Unix timestamp (ms) at which that unload will
 * happen if no requests arrive — you can use `Date.now() < expiresAt`
 * to check whether a model is still warm.
 */
interface RunningModel {
  /** Model name currently loaded, e.g. `"gemma3:27b"`. */
  name: string;

  /** Memory consumed, in bytes. */
  size: number;

  /**
   * Unix timestamp (ms) when Ollama will unload this model if no
   * requests arrive.
   *
   * @example
   * ```ts
   * const isWarm = model.expiresAt > Date.now();
   * ```
   */
  expiresAt: number;
}
````

---

## Anti-patterns to avoid

**Don't omit `@example` on complex methods.** In internal code an example is optional. In open-source it's often the only thing a new contributor reads. Async generators, streaming, pagination, and error recovery patterns all need working examples.

**Don't reference internal architecture.** Comments like "called by Advisor for planning" mean nothing to someone who doesn't know what Advisor is. If a relationship matters, link to the relevant class with `@see {@link Advisor}`, and let the reader follow the link.

**Don't assume the reader knows your error types.** Name every thrown error concretely: `@throws {@link OllamaError}` — not just `@throws if something goes wrong`.

**Don't describe what the code does, describe what the caller gets.** The difference: "Iterates the models array and maps each entry to its name field" vs. "Returns the names of all installed models." The second is what belongs in a doc comment.

**Don't leave `@defaultValue` undocumented for optional parameters.** If a caller can omit something, they need to know what they're getting when they do.

---

## Quick reference

| Symbol               | Must include                                                      | Include when non-obvious                                                                |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Exported class       | One-sentence summary, `@example` showing construction + basic use | `@remarks` for lifecycle, stateful behavior, or design rationale                        |
| Exported method/fn   | Summary, `@param` (all), `@returns`, `@throws` (all)              | `@remarks` for retry/caching/ordering, `@example` for non-obvious usage (nearly always) |
| Interface / type     | Summary, inline `/** */` per property                             | `@remarks` for field constraints or interdependencies, `@example` for complex shapes    |
| Private / unexported | Nothing unless behavior is genuinely surprising                   | —                                                                                       |
