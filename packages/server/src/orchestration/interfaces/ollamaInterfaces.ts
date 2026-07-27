/**
 * HTTP client abstractions for the Ollama inference API.
 *
 * @remarks
 * Defines the contract for chat completions (with and without tool calling) and
 * administrative operations (model management, pull, delete, listing). Implemented
 * by OllamaClient which wraps the Ollama REST API.
 */

import type {
  ModelInfo,
  OllamaModelSummary,
  PullProgress,
  RunningModel,
} from "../../ollama/types.js";
import type { ToolSchema } from "../tools/types.js";
import type { ChatOptions, Message } from "../types.js";

/**
 * A single tool invocation requested by the model during a chat completion.
 *
 * @remarks
 * Represents one function call the model wants to execute. The arguments are parsed
 * from JSON and structured as a plain object, ready for validation or execution.
 *
 * @example
 * ```ts
 * {
 *   name: "run_command",
 *   args: { command: "ls -la", timeout: 5000 }
 * }
 * ```
 */
export type OllamaToolCall = {
  /** Name of the tool/function to invoke (must match a schema passed to chatWithTools). */
  name: string;

  /** Arguments for the tool, parsed from the model's JSON output. */
  args: Record<string, unknown>;
};

/**
 * Complete result from a chat completion with native tool calling enabled.
 *
 * @remarks
 * Combines the model's conversational response, optional internal reasoning, and any
 * tool calls the model requested. All tool calls have been validated against the provided
 * tool schemas. Any of these fields may be empty depending on the model's response.
 *
 * @example
 * ```ts
 * {
 *   content: "I'll help you list the files.",
 *   thinking: "The user wants to see files in the current directory.",
 *   toolCalls: [{ name: "run_command", args: { command: "ls -la" } }]
 * }
 * ```
 */
export type ChatWithToolsResult = {
  /** The model's text response to the user (may be empty if only tool calls). */
  content: string;

  /** Internal reasoning or thinking from the model (if the model supports it, otherwise empty). */
  thinking: string;

  /** Array of tool invocations the model requested (may be empty). */
  toolCalls: OllamaToolCall[];
};

/**
 * HTTP client for the Ollama chat and inference API.
 *
 * @remarks
 * Provides blocking and streaming chat completions, with optional native tool calling support.
 * Used by Agent for planning, reasoning, and streaming task execution.
 * Handles retries on transient failures (503 while models load) and respects sampling parameters.
 *
 * @example
 * ```ts
 * const client: IOllamaClient = createOllamaClient();
 * const response = await client.chat(
 *   "llama3.1",
 *   [{ role: "user", content: "What is 2+2?" }],
 *   { temperature: 0.7 }
 * );
 * console.log(response); // "4"
 * ```
 */
export interface IOllamaClient {
  /**
   * Sends a blocking chat completion request and returns the complete response.
   *
   * @remarks
   * Waits for the full model response. Use `chatStream` instead if you want to display
   * tokens as they arrive. Retries internally on 503 (model loading in VRAM).
   *
   * @param model - Ollama model identifier (e.g., `"llama3.1"`, `"gemma3:27b"`).
   *   Must be installed locally (use OllamaAdminClient.listModels to verify).
   * @param messages - Conversation history with system prompt first, then alternating user/assistant.
   * @param options - Sampling configuration (temperature, etc.).
   * @returns The complete assistant response text.
   * @throws When Ollama is unreachable after retries or returns a non-retryable error.
   *
   * @example
   * ```ts
   * const reply = await client.chat("llama3.1",
   *   [{ role: "user", content: "Explain async/await" }],
   *   { temperature: 0.5 }
   * );
   * ```
   */
  chat(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): Promise<string>;

  /**
   * Streams assistant tokens from a chat completion request.
   *
   * @remarks
   * Yields tokens as they arrive from the model, enabling progressive rendering.
   * Does not retry on failures — a dropped stream throws immediately so the caller
   * can decide whether to retry the full request.
   *
   * @param model - Ollama model identifier.
   * @param messages - Conversation history.
   * @param options - Sampling configuration.
   * @returns Async generator yielding text tokens (each yielded value is one token or substring).
   * @throws If the response stream drops before completion.
   *
   * @example
   * ```ts
   * for await (const token of client.chatStream("llama3.1", messages, opts)) {
   *   process.stdout.write(token);
   * }
   * ```
   */
  chatStream(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<string>;

  /**
   * Sends a chat completion request with native tool calling support.
   *
   * @remarks
   * Returns both the model's text response and any tool invocations it requested.
   * Tool calls are validated against the provided schemas before returning.
   * Supports an optional token callback for real-time streaming of content tokens.
   *
   * @param model - Ollama model identifier (must support native tool calling).
   * @param messages - Conversation history (may include tool role messages from prior results).
   * @param tools - Array of tool/function schemas the model may invoke.
   * @param options - Sampling configuration.
   * @param onToken - Optional callback invoked for each streamed content token (not tool calls).
   * @returns Response with content text, reasoning, and validated tool calls.
   * @throws When tool calls fail validation or Ollama is unreachable.
   *
   * @example
   * ```ts
   * const result = await client.chatWithTools(
   *   "llama3.1",
   *   [{ role: "user", content: "Get the current directory" }],
   *   [{ name: "run_command", description: "...", parameters: {...} }],
   *   { temperature: 0 },
   *   (token) => process.stdout.write(token)
   * );
   * if (result.toolCalls.length > 0) {
   *   Execute tools and continue conversation
   * }
   * ```
   */
  chatWithTools(
    model: string,
    messages: Message[],
    tools: ToolSchema[],
    options: ChatOptions,
    onToken?: (token: string) => void,
  ): Promise<ChatWithToolsResult>;
}

/**
 * Administrator client for Ollama model management and server operations.
 *
 * @remarks
 * Separate from the chat/inference operations. Provides model discovery, pulling,
 * deletion, metadata inspection, and monitoring of loaded models.
 * Used by Router endpoints for `/models/*` operations and model management UI.
 *
 * @example
 * ```ts
 * const adminClient: IOllamaAdminClient = createOllamaAdminClient();
 * const models = await adminClient.listModels();
 * if (!models.includes("llama3.1")) {
 *   for await (const progress of adminClient.pullModel("llama3.1")) {
 *     console.log(progress.status, progress.completed, progress.total);
 *   }
 * }
 * ```
 */
export interface IOllamaAdminClient {
  /**
   * Returns the names of all installed models.
   *
   * @remarks
   * Fast enumeration returning only model names/tags. Use `listModelsDetailed` if
   * you need size, modified time, or other metadata.
   *
   * @returns Array of model identifiers (e.g., `["llama3.1", "gemma3:27b"]`).
   *   Returns empty array if no models are installed.
   *
   * @example
   * ```ts
   * const models = await client.listModels();
   * console.log(models); // ["llama3.1", "gemma3:27b", ...]
   * ```
   */
  listModels(): Promise<string[]>;

  /**
   * Returns all installed models with full metadata.
   *
   * @remarks
   * More expensive than `listModels` but includes size, modified time, quantization,
   * and other details. Useful for UI displays showing model sizes and updated times.
   *
   * @returns Array of model summaries with metadata.
   *
   * @example
   * ```ts
   * const models = await client.listModelsDetailed();
   * models.forEach(m => {
   *   console.log(`${m.name}: ${(m.size / 1024 / 1024 / 1024).toFixed(1)}GB`);
   * });
   * ```
   */
  listModelsDetailed(): Promise<OllamaModelSummary[]>;

  /**
   * Downloads a model from the Ollama registry, streaming progress updates.
   *
   * @remarks
   * Large models can be several gigabytes. Each yielded progress update carries
   * status messages (e.g., `"pulling manifest"`, `"downloading"`) and download
   * byte counts. The stream ends when the model is fully downloaded.
   *
   * @param name - Model name from the Ollama library (e.g., `"llama3.1"`, `"gemma3:27b"`).
   * @returns Async generator yielding progress updates until success.
   * @throws When the model name is not found in the registry or network error occurs.
   *
   * @example
   * ```ts
   * for await (const update of client.pullModel("llama3.1")) {
   *   if (update.completed && update.total) {
   *     const pct = Math.round((update.completed / update.total) * 100);
   *     console.log(`Downloading: ${pct}%`);
   *   } else {
   *     console.log(update.status); // "pulling manifest", "verifying", etc.
   *   }
   * }
   * ```
   */
  pullModel(name: string): AsyncGenerator<PullProgress>;

  /**
   * Permanently removes a model from local storage.
   *
   * @remarks
   * This is irreversible — the model must be re-downloaded to use it again.
   * Verify the model exists (via `listModels`) before deleting to provide good error messages.
   *
   * @param name - Model name to delete (must match exactly, including tag; e.g., `"llama3.1"`).
   * @throws When the model doesn't exist or the server returns an error.
   *
   * @example
   * ```ts
   * const models = await client.listModels();
   * if (models.includes("llama3.1")) {
   *   await client.deleteModel("llama3.1");
   *   console.log("Deleted.");
   * }
   * ```
   */
  deleteModel(name: string): Promise<void>;

  /**
   * Returns detailed metadata about one installed model.
   *
   * @remarks
   * Includes model size, parameter count, architecture family, quantization level,
   * and other Ollama model metadata.
   *
   * @param name - Model name to inspect (must be installed; verify with `listModels`).
   * @returns Parsed model metadata.
   * @throws When the model isn't installed or the server returns an error.
   *
   * @example
   * ```ts
   * const info = await client.showModel("llama3.1");
   * console.log(`${info.name}: ${info.parameters / 1e9}B params, ${info.quantization}`);
   * "llama3.1: 8B params, Q4_K_M"
   * ```
   */
  showModel(name: string): Promise<ModelInfo>;

  /**
   * Returns all models currently loaded in memory on the Ollama server.
   *
   * @remarks
   * Shows which models are actively consuming VRAM. Ollama keeps loaded models
   * in memory for a TTL (default 5 minutes) after the last request. The `expiresAt`
   * timestamp indicates when the model will be unloaded if no requests arrive.
   *
   * @returns Array of currently loaded models (empty if no models in memory).
   *
   * @example
   * ```ts
   * const running = await client.listRunning();
   * running.forEach(m => {
   *   const mb = (m.size / 1024 / 1024).toFixed(1);
   *   const expiresIn = Math.round((m.expiresAt - Date.now()) / 1000);
   *   console.log(`${m.name}: ${mb}MB, expires in ${expiresIn}s`);
   * });
   * ```
   */
  listRunning(): Promise<RunningModel[]>;
}
