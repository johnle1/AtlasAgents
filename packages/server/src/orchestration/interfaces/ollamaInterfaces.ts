/**
 * <Summary>
 * What it does:
 *   Interfaces for Ollama HTTP client and admin operations.
 *
 * How it fits in the system:
 *   Defines the contract for interacting with the Ollama API for chat completions,
 *   model management, and administrative operations.
 * </Summary>
 */

import type {
  ModelInfo,
  OllamaModelSummary,
  PullProgress,
  RunningModel,
} from "../../ollama/types.js";
import type { ChatOptions, Message } from "../types.js";

/**
 * <Summary>
 * What it does:
 *   HTTP abstraction over the local Ollama chat API (blocking and streaming).
 *
 * Used by:
 *   - Advisor — plan, advise, combine.
 *   - Agent — run (streaming execution).
 *
 * Produced by:
 *   - Future packages/server/src/ollama/client.ts implementation.
 * </Summary>
 */
export interface IOllamaClient {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Sends one non-streaming chat completion and returns the full assistant text.
   *
   * Parameters:
   *   @param model - Ollama model name.
   *   @param messages - System/user/assistant turns.
   *   @param options - Temperature and related sampling knobs.
   *
   * Returns:
   *   @returns Concatenated assistant message content.
   * </Summary>
   */
  chat(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): Promise<string>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Streams assistant tokens from Ollama for one chat request.
   *
   * Parameters:
   *   @param model - Ollama model name.
   *   @param messages - System/user/assistant turns.
   *   @param options - Sampling options.
   *
   * Returns:
   *   @returns Yields incremental text chunks.
   * </Summary>
   */
  chatStream(
    model: string,
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<string>;
}

/**
 * <Summary>
 * What it does:
 *   Ollama HTTP admin surface (models, pull stream, delete, show, running ps)
 *   separate from chat streaming used by Advisor and Agent.
 *
 * Used by:
 *   - Future Router command handlers — list/pull/delete models.
 *
 * Produced by:
 *   - packages/server/src/ollama/client.ts — OllamaClient implements this.
 * </Summary>
 */
export interface IOllamaAdminClient {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Lists installed model tag names from GET /api/tags.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns Model names only.
   * </Summary>
   */
  listModels(): Promise<string[]>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Lists installed models with size, modified time, and details from GET /api/tags.
   *
   * Returns:
   *   @returns Full tag rows.
   * </Summary>
   */
  listModelsDetailed(): Promise<OllamaModelSummary[]>;

  /**
   * <Summary>
   * What it does:
   *   Streams pull progress lines from POST /api/pull with stream true.
   *
   * Parameters:
   *   @param name - Model name to pull.
   *
   * Returns:
   *   @returns Progress chunks until success.
   * </Summary>
   */
  pullModel(name: string): AsyncGenerator<PullProgress>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deletes a model after verifying it exists in listModels.
   *
   * Parameters:
   *   @param name - Model name to delete.
   *
   * Returns:
   *   @returns Completes when Ollama accepts delete.
   *
   * @throws {OllamaError} — When model missing or HTTP not ok.
   * </Summary>
   */
  deleteModel(name: string): Promise<void>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns parsed model info from POST /api/show.
   *
   * Parameters:
   *   @param name - Model name to inspect.
   *
   * Returns:
   *   @returns Parsed JSON body.
   * </Summary>
   */
  showModel(name: string): Promise<ModelInfo>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Lists in-memory loaded models from GET /api/ps.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns Running rows (may be empty).
   * </Summary>
   */
  listRunning(): Promise<RunningModel[]>;
}
