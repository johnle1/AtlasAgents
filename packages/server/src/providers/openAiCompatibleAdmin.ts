/**
 * Admin client for single-model OpenAI-compatible backends (e.g. LM Studio, llama.cpp's server).
 *
 * @remarks
 * Single-model providers differ fundamentally from Ollama:
 * - **Model is fixed at launch:** the server loads one model and can't change it at runtime
 * - **No pull/delete:** Can't swap models at runtime like Ollama
 * - **List is static:** The available models don't change until the server restarts
 *
 * This class implements {@link IOllamaAdminClient} (same interface as Ollama's admin client)
 * so ProviderRegistry can treat all providers uniformly. However:
 * - `listModels()` and `listModelsDetailed()` work (query `/models` endpoint)
 * - `showModel()` returns basic info (name + assumed capabilities)
 * - `pullModel()` and `deleteModel()` throw {@link AdminUnsupportedError} with helpful messages
 * - `listRunning()` returns the currently loaded model (always the same one)
 *
 * **Design philosophy:** Fail fast and explicitly rather than silently ignoring operations.
 * If a user tries to pull a model on a single-model backend, they get a clear error message
 * telling them to relaunch the server with the desired model, not silent failure or
 * undefined behavior.
 *
 * **Use case:** ProviderRegistry can call the same admin methods on any provider and get
 * sensible behavior: Ollama allows full model management, single-model providers work read-only
 * with explicit errors for unsupported operations.
 *
 * @example
 * ```ts
 * const admin = new SingleModelAdmin("http://localhost:1234", "sk-xxx");
 *
 * // These work (read-only operations)
 * const models = await admin.listModels();           // ["mistral-7b"]
 * const info = await admin.showModel("mistral-7b");  // { name: "mistral-7b", ... }
 *
 * // These throw AdminUnsupportedError
 * await admin.pullModel("gpt-4");  // Error: Pull not supported; relaunch with --model
 * await admin.deleteModel("mistral-7b");  // Error: Delete not supported; relaunch
 * ```
 *
 * @see {@link IOllamaAdminClient} for the interface contract
 * @see {@link ProviderRegistry} for how this fits into multi-provider routing
 */

import type {
  IOllamaAdminClient,
} from "../orchestration/interfaces/ollamaInterfaces.js";
import type {
  ModelInfo,
  OllamaModelSummary,
  PullProgress,
  RunningModel,
} from "../ollama/types.js";
import { AdminUnsupportedError, ModelProviderError } from "./errors.js";
import type { FetchLike } from "./openAiCompatibleAdapter.js";

/**
 * Shape of the GET `/models` endpoint response from OpenAI-compatible servers.
 *
 * @remarks
 * OpenAI-compatible servers list available models in a `data` array where each
 * entry has an `id` field (the model name). We extract just the IDs and convert
 * them to {@link OllamaModelSummary} for compatibility with the admin client interface.
 *
 * @example
 * ```json
 * {
 *   "data": [
 *     { "id": "mistral-7b", "object": "model", ... },
 *     { "id": "gpt-4", "object": "model", ... }
 *   ]
 * }
 * ```
 */
type OpenAiModelsResponse = { data?: Array<{ id?: string }> };

/**
 * Admin client for single-model OpenAI-compatible providers.
 *
 * @remarks
 * Implements {@link IOllamaAdminClient} for providers that have a fixed model
 * loaded at startup (LM Studio, llama.cpp's server, etc.). These providers:
 *
 * - Can list models (via GET `/models`)
 * - Cannot pull models (model is fixed at launch)
 * - Cannot delete models (model is fixed at launch)
 * - Have only one model running (the one they started with)
 *
 * All configuration is done at server launch time (e.g., loading a model in LM Studio),
 * not through the admin API. This class provides read-only introspection.
 *
 * @example
 * ```ts
 * const admin = new SingleModelAdmin("http://localhost:1234", "sk-xxx");
 * const models = await admin.listModels(); // ["mistral-7b"]
 * ```
 */
export class SingleModelAdmin implements IOllamaAdminClient {
  /** Base URL of the OpenAI-compatible server (trailing slash removed). */
  private readonly baseUrl: string;
  /** API key for authentication via Bearer token. */
  private readonly apiKey: string;
  /** Fetch implementation, injected for testing or custom HTTP. */
  private readonly fetchImpl: FetchLike;

  /**
   * Creates an admin client for a single-model OpenAI-compatible provider.
   *
   * @param baseUrl - Base URL of the OpenAI-compatible server, e.g. "http://localhost:1234".
   *   Trailing slashes are removed to normalize paths.
   * @param apiKey - API key for authentication. Sent as `Authorization: Bearer {apiKey}`.
   * @param deps - Optional dependencies for testing or customization.
   *   - `fetch`: Custom fetch implementation (e.g., for mocking in tests). Defaults to global fetch.
   *
   * @remarks
   * The constructor is intentionally minimal — it just stores configuration. No validation
   * or connection testing happens until methods are called. This keeps initialization fast.
   *
   * @example
   * ```ts
   * // Production
   * const admin = new SingleModelAdmin("http://localhost:1234", "sk-xxx");
   *
   * // Testing with mock fetch
   * const mockFetch = jest.fn();
   * const admin = new SingleModelAdmin("https://api.example.com", "test-key", { fetch: mockFetch });
   * ```
   */
  constructor(
    baseUrl: string,
    apiKey: string,
    deps: { fetch?: FetchLike } = {},
  ) {
    // Normalize the base URL by removing any trailing slash.
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    // Use the injected fetch implementation, or fall back to the global fetch.
    this.fetchImpl = deps.fetch ?? fetch;
  }

  /**
   * Constructs HTTP headers for OpenAI-compatible API requests.
   *
   * @remarks
   * Single-model providers typically use Bearer token authentication. This method
   * returns the minimal headers needed: only the Authorization header (no Content-Type
   * since we're making GET requests for model listing).
   *
   * @returns Headers object ready to pass to fetch.
   *
   * @example
   * ```ts
   * const headers = admin.headers();
   * // { "Authorization": "Bearer sk-xxx" }
   * ```
   */
  private headers = (): Record<string, string> => ({
    Authorization: `Bearer ${this.apiKey}`,
  });

  /**
   * Lists the names of all available models on the server.
   *
   * @remarks
   * This is a convenience wrapper around {@link listModelsDetailed} that extracts
   * just the model names. For single-model providers, this typically returns an array
   * with one entry: the fixed model that was loaded at launch.
   *
   * @returns Array of model name strings, e.g. `["mistral-7b"]`.
   * @throws {@link ModelProviderError} if the server returns an error.
   *
   * @example
   * ```ts
   * const models = await admin.listModels();
   * console.log(models); // ["mistral-7b"]
   * ```
   */
  listModels = async (): Promise<string[]> => {
    // Get detailed model info and extract just the names.
    const detailed = await this.listModelsDetailed();
    return detailed.map((model) => model.name);
  };

  /**
   * Lists all available models with summary information.
   *
   * @remarks
   * Fetches the model list from the server's GET `/models` endpoint and converts
   * the OpenAI-compatible format to {@link OllamaModelSummary} objects for consistency
   * with the Ollama admin interface.
   *
   * **Format translation:**
   * - OpenAI format: `{ data: [{ id: "mistral-7b" }, ...] }`
   * - Ollama format: `[{ name: "mistral-7b" }, ...]`
   *
   * Entries without valid IDs are filtered out (defensive against malformed responses).
   *
   * @returns Array of model summaries with at least the `name` field populated.
   * @throws {@link ModelProviderError} if the server returns an HTTP error.
   *
   * @example
   * ```ts
   * const detailed = await admin.listModelsDetailed();
   * // [{ name: "mistral-7b" }]
   * ```
   */
  listModelsDetailed = async (): Promise<OllamaModelSummary[]> => {
    // Fetch the model list from the OpenAI-compatible server.
    const response = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: this.headers(),
    });
    // If the server returned an error, throw it.
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ModelProviderError(response.status, body);
    }
    // Parse the response as OpenAI format.
    const parsed = (await response.json()) as OpenAiModelsResponse;
    // Convert to Ollama format: extract IDs, filter valid entries, map to OllamaModelSummary.
    return (parsed.data ?? [])
      .filter(
        (entry): entry is { id: string } =>
          typeof entry.id === "string" && entry.id.length > 0,
      )
      .map((entry) => ({ name: entry.id }));
  };

  /**
   * Pulls (downloads) a model from a registry.
   *
   * @remarks
   * Single-model providers don't support pulling models at runtime. The model is
   * fixed at launch time (e.g., which model is loaded in LM Studio). Attempting to pull a
   * different model will always fail.
   *
   * This method throws immediately with a clear error message directing the user
   * to restart the server with the desired model. This is better than silently
   * failing or returning stale cached data.
   *
   * @param _name - The model name to pull (ignored; always fails).
   * @yields Never — always throws immediately.
   * @throws {@link AdminUnsupportedError} with a message explaining how to load a different model.
   *
   * @example
   * ```ts
   * try {
   *   for await (const progress of admin.pullModel("gpt-4")) {
   *     console.log(progress);
   *   }
   * } catch (err) {
   *   if (err instanceof AdminUnsupportedError) {
   *     console.error(err.message);
   *     // "Pull not supported for this provider. Relaunch the server with a different --model."
   *   }
   * }
   * ```
   */
  pullModel = async function* (
    _name: string,
  ): AsyncGenerator<PullProgress> {
    // This provider doesn't support pulling models at runtime.
    // Throw an error directing the user to restart the server.
    throw new AdminUnsupportedError(
      "Pull not supported for this provider. Relaunch the server with a different --model.",
    );
  };

  /**
   * Deletes a model from the server.
   *
   * @remarks
   * Single-model providers don't support deleting models at runtime. The model is
   * fixed at launch and can only be changed by restarting the server.
   *
   * This method throws immediately with a clear error message, preventing silent
   * failures or undefined behavior.
   *
   * @param _name - The model name to delete (ignored; always fails).
   * @throws {@link AdminUnsupportedError} with a message explaining how to unload a model.
   *
   * @example
   * ```ts
   * try {
   *   await admin.deleteModel("mistral-7b");
   * } catch (err) {
   *   if (err instanceof AdminUnsupportedError) {
   *     console.error(err.message);
   *     // "Delete not supported for this provider. Relaunch the server with a different --model."
   *   }
   * }
   * ```
   */
  deleteModel = async (_name: string): Promise<void> => {
    // This provider doesn't support deleting models at runtime.
    throw new AdminUnsupportedError(
      "Delete not supported for this provider. Relaunch the server with a different --model.",
    );
  };

  /**
   * Returns metadata for one installed model.
   *
   * @remarks
   * Single-model providers always have exactly one model loaded (the one they started with).
   * This method returns basic metadata assuming the model supports tools (reasonable for
   * modern LLMs). Since we don't have detailed metadata from the `/models` endpoint,
   * we return minimal info: just the name and assumed capabilities.
   *
   * The capabilities are hardcoded to `["tools"]` because most single-model providers
   * are used for modern LLMs that support tool calling. If this
   * assumption is wrong for a specific provider, the backend operator should use Ollama
   * instead (which supports full model management).
   *
   * @param name - Model name to look up. Typically the one fixed model, but any name is accepted.
   * @returns Basic model metadata (name + assumed capabilities).
   *
   * @example
   * ```ts
   * const info = await admin.showModel("mistral-7b");
   * // { name: "mistral-7b", capabilities: ["tools"] }
   * ```
   */
  showModel = async (name: string): Promise<ModelInfo> => {
    // Return basic metadata for the model.
    // We assume it supports tools (reasonable for modern LLMs used on these providers).
    return { name, capabilities: ["tools"] };
  };

  /**
   * Lists all models currently loaded and running on the server.
   *
   * @remarks
   * Single-model providers load exactly one model at startup and keep it loaded.
   * This method returns that one model (by querying the list and wrapping each
   * in a {@link RunningModel} structure).
   *
   * The `size` field is set to 0 since these providers don't expose memory usage
   * through the OpenAI-compatible API. Ollama provides this; single-model providers
   * don't, so we return a placeholder.
   *
   * @returns Array with one element: the fixed model that's running.
   *
   * @example
   * ```ts
   * const running = await admin.listRunning();
   * // [{ name: "mistral-7b", size: 0 }]
   * ```
   */
  listRunning = async (): Promise<RunningModel[]> => {
    // Get the list of available models (typically one).
    const names = await this.listModels();
    // Wrap each in a RunningModel structure. Size is 0 since we don't have that info.
    return names.map((name) => ({ name, size: 0 }));
  };
}
