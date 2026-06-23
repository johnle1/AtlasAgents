---
name: commenting
description: Write doc comments for the loopycode codebase following TSDoc (TypeScript files) and JSDoc (plain JavaScript files), the real industry-standard formats read by TypeDoc, API Extractor, and editor IntelliSense. Use this whenever writing or reviewing comments on a class, method, function, or interface, when asked to "document this," "add comments," "write JSDoc," or before committing new public API surface. Comments are added selectively — non-trivial public methods, complex logic, and non-obvious behavior get documented; trivial getters, setters, and self-explanatory one-liners do not. Never hand-maintain a list of callers in a comment; that's what "Find References" is for.
---

# Commenting (TSDoc / JSDoc)

## Which standard applies

- **`.ts` / `.tsx` files → TSDoc.** This is Microsoft's spec, and it's what TypeDoc, API Extractor, and VS Code's hover tooltips actually parse. TSDoc's rule that trips people up: **don't repeat the type in `@param`.** The compiler already owns that information — write `@param model - Ollama model name` not `@param {string} model - ...`. Repeating the type just gives you two places that can disagree.
- **`.js` / `.jsx` files → JSDoc.** No compiler is enforcing types here, so `@param {string} model - ...` is correct and necessary — it's the only type information that exists.

If you're not sure which applies, check the file extension. Most of loopycode is TypeScript, so TSDoc is the default.

## Decide whether to comment at all

Document:

- Every exported class, function, method, and interface — anything another file imports.
- Anything with non-obvious behavior: retries, timeouts, race conditions, side effects, or a deliberate tradeoff that isn't visible from the signature.
- Anything that throws, has surprising edge cases, or behaves differently than its name suggests.

Skip the ceremony:

- Trivial getters/setters, one-line private helpers, and anything where the name + signature already say everything a comment would.
- Don't force a full block onto a two-line passthrough just to satisfy a template. A comment that restates `return this.x` in prose isn't documentation, it's noise — and it's one more thing to keep in sync every time the code changes.

## Method template

````ts
/**
 * One-sentence summary, imperative mood, ends with a period.
 *
 * @remarks
 * Only include this if there's something non-obvious worth explaining —
 * a retry/backoff strategy, why this exists instead of an obvious
 * alternative, a side effect the caller needs to know about. If the
 * summary line already covers it, omit @remarks entirely.
 *
 * @param paramName - what it represents and where it comes from. No type
 *   in brackets for .ts files; TypeScript already declares it.
 * @returns what the return value contains and when it changes.
 * @throws {@link ErrorType} when this happens.
 *
 * @example
 * Only add this when usage isn't obvious from the signature alone —
 * e.g. consuming an async generator, or a non-default options shape.
 * ```ts
 * const text = await client.chat("gemma3:27b", messages, { temperature: 0.7 });
 * ```
 */
````

`@example` is optional and should be rare. Most methods don't need one.

## Class template

```ts
/**
 * One-sentence summary of this class's single responsibility.
 *
 * @remarks
 * Where it sits in the system, and why it's its own class rather than
 * folded into another — only if that context isn't obvious. Skip this
 * block if the one-line summary already says enough.
 */
```

## Interface / type template

```ts
/**
 * What this shape represents and where it's used.
 */
interface Message {
  /** Who sent this turn. */
  role: "system" | "user" | "assistant";

  /** The text content of this turn. */
  content: string;
}
```

Document the interface itself and every property inline. Properties whose
name already says everything (`id: string`) can get a one-liner; don't
stretch for three sentences on something self-evident.

## What not to do

- **Don't hand-maintain a "used by" / "called by" list.** It's stale the moment someone adds a new call site, and every editor already gives you this for free, correctly, via Find References / Find Usages. If a relationship is genuinely important context — not just "who happens to call this" — point to it once with `@see {@link ClassName}` rather than enumerating every caller.
- **Don't narrate the implementation.** "Reads config from disk" beats a line-by-line walkthrough of the `fs.readFileSync` call. If you're writing "Step 1: ... Step 2: ..." for routine control flow, that's the code's job, not the comment's — and it doubles your maintenance surface, since now the prose and the code both need updating every time the logic changes.
- **Don't comment every method regardless of triviality.** A blanket "every function gets a block" rule is exactly what style guides like Google's and Robert Martin's _Clean Code_ argue against: comments should explain things the code can't say for itself, not restate what's already obvious from the signature.
- **Don't repeat types in TSDoc `@param` tags.** That's a JSDoc-for-plain-JS habit; in a typed file it's redundant with the signature.

## Inline implementation comments

Reserve `//` comments inside a method body for things the code genuinely
can't express on its own: why a workaround exists, why a value is
hardcoded, a non-obvious ordering requirement, a link to the ticket or
spec behind an edge case. Don't put a comment above every line restating
what that line does — if `// loop through models` sits above
`for (const model of models)`, delete the comment.

---

## Worked example — OllamaClient

```ts
/**
 * Handles all HTTP communication with the local Ollama server so no
 * other class talks to the Ollama API directly.
 *
 * @remarks
 * Sits between the orchestration layer (Advisor, Agent) and Ollama.
 * Centralizing this here means swapping model servers only requires
 * changing this one file.
 */
class OllamaClient {
  /**
   * Sends a single blocking chat request to Ollama and returns the
   * complete response text.
   *
   * @remarks
   * Retries up to 3 times with exponential backoff on a 503 (model
   * still loading) before giving up.
   *
   * @param model - Ollama model name, e.g. "gemma3:27b".
   * @param messages - Ordered conversation history, including the
   *   system prompt and the latest user turn.
   * @param options - Sampling settings such as temperature.
   * @returns The model's full response text.
   * @throws {@link OllamaError} if Ollama is unreachable after all retries.
   */
  async chat(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): Promise<string> {
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    const requestBody = { model, messages, stream: false, options };

    let lastError: Error | null = null;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Skip the delay on the first attempt; back off exponentially after that.
        const delayMs = attempt > 0 ? Math.pow(2, attempt - 1) * 1000 : 0;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        // 503 means the model is still loading into memory — retry rather than fail.
        if (response.status === 503) {
          lastError = new Error(
            `Ollama returned 503 on attempt ${attempt + 1}`,
          );
          continue;
        }

        if (!response.ok) {
          throw new Error(
            `Ollama returned ${response.status}: ${response.statusText}`,
          );
        }

        const data = await response.json();
        return data.message.content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxRetries - 1) {
          throw new Error(
            `Ollama unreachable after ${maxRetries} attempts: ${lastError.message}`,
          );
        }
      }
    }

    throw new Error("Unexpected state in chat() retry loop");
  }

  /**
   * Streams a chat response from Ollama token by token.
   *
   * @remarks
   * Throws if the underlying HTTP stream drops before Ollama sends its
   * `done: true` marker — a dropped connection mid-response should be
   * loud, not silently truncated.
   *
   * @param model - Ollama model name.
   * @param messages - Conversation history.
   * @param options - Sampling settings.
   * @returns An async generator yielding one token string at a time.
   * @throws {@link OllamaError} if the stream drops mid-response.
   */
  async *chatStream(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    // ... implementation
  }

  /**
   * Returns the names of all models currently installed on the Ollama
   * server.
   *
   * @returns Array of installed model names, e.g. `["gemma3:4b", "gemma3:27b"]`.
   * @throws {@link OllamaError} if the Ollama server is unreachable.
   */
  async listModels(): Promise<string[]> {
    // ... implementation
  }

  /**
   * Downloads a model from the Ollama registry, yielding progress
   * updates as the download proceeds.
   *
   * @param name - Model name to download, e.g. "gemma3:27b".
   * @returns An async generator yielding progress objects until the
   *   download completes.
   * @throws {@link OllamaError} if the model name isn't found in the registry.
   */
  async *pullModel(name: string): AsyncGenerator<PullProgress> {
    // ... implementation
  }

  /**
   * Permanently removes a model from the Ollama server's disk storage.
   *
   * @param name - Exact model name to delete, e.g. "gemma3:4b".
   * @returns Nothing — called for its side effect.
   * @throws {@link OllamaError} if the model doesn't exist or deletion fails.
   */
  async deleteModel(name: string): Promise<void> {
    // ... implementation
  }

  /**
   * Returns metadata about one installed model: size on disk, parameter
   * count, family, and quantization level.
   *
   * @param name - Model name to inspect.
   * @throws {@link OllamaError} if the model isn't installed.
   */
  async showModel(name: string): Promise<ModelInfo> {
    // ... implementation
  }

  /**
   * Returns all models currently loaded into memory on the Ollama
   * server, so callers can see what's consuming RAM/VRAM right now.
   *
   * @throws {@link OllamaError} if the Ollama server is unreachable.
   */
  async listRunning(): Promise<RunningModel[]> {
    // ... implementation
  }
}
```

### Supporting interfaces

```ts
/** A single message turn in a conversation sent to Ollama. */
interface Message {
  /** Either "system", "user", or "assistant". */
  role: "system" | "user" | "assistant";

  /** The text content of this message turn. */
  content: string;
}

/** Sampling settings passed to Ollama to control generation. */
interface ChatOptions {
  /**
   * Controls randomness. 0.0 is deterministic, 1.0 is very creative.
   * Advisor uses 0.1; agents default to 0.7.
   */
  temperature: number;
}

/** One progress update yielded during a model download. */
interface PullProgress {
  /** Status string from Ollama, e.g. "pulling manifest", "downloading", "success". */
  status: string;

  /** Bytes downloaded so far. Only set while status is "downloading". */
  completed?: number;

  /** Total bytes to download. Only set while status is "downloading". */
  total?: number;
}

/** Metadata about one installed Ollama model. */
interface ModelInfo {
  /** Model name including tag, e.g. "gemma3:27b". */
  name: string;

  /** Disk size in bytes. */
  size: number;

  /** Parameter count, e.g. 27000000000. */
  parameters: number;

  /** Model architecture family, e.g. "gemma". */
  family: string;

  /** Quantization level, e.g. "Q4_K_M". */
  quantization: string;
}

/** A model currently loaded in memory on the Ollama server. */
interface RunningModel {
  /** Model name currently loaded. */
  name: string;

  /** Memory consumed, in bytes. */
  size: number;

  /** Unix timestamp (ms) when Ollama will unload this model if idle. */
  expiresAt: number;
}
```

---

## Quick reference

| Symbol                 | Required                                           | Optional, use only when non-obvious |
| ---------------------- | -------------------------------------------------- | ----------------------------------- |
| Exported class         | One-sentence summary                               | `@remarks` for context/rationale    |
| Exported method/fn     | One-sentence summary, `@param`, `@returns`         | `@remarks`, `@throws`, `@example`   |
| Interface              | One-sentence summary, inline `/** */` per property | `@remarks`                          |
| Private/trivial helper | Nothing, unless behavior is genuinely surprising   | —                                   |

If you're tempted to add a "Dependencies" / "Dependants" section: don't — use your editor's Find References instead, and reach for a single `@see {@link X}` only when the relationship is something a reader truly needs flagged, not a full accounting of every caller.
