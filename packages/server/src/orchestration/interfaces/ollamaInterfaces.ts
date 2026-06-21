/**
 * <Summary>
 * What it does:
 *   Interfaces for Ollama HTTP client and admin operations.
 *
 * How it fits in the system:
 *   Defines the contract for interacting with the Ollama API for chat completions,
 *   model management, and administrative operations.
 *
 * Dependencies:
 *   - types.ts — Message, ChatOptions.
 *   - ollama/types.js — ModelInfo, OllamaModelSummary, PullProgress, RunningModel.
 *
 * Dependants:
 *   - Advisor, Agent, Router command handlers.
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
   *   @param {string} model — Ollama model name.
   *   @param {Message[]} messages — System/user/assistant turns.
   *   @param {ChatOptions} options — Temperature and related sampling knobs.
   *
   * Returns:
   *   @returns {Promise<string>} — Concatenated assistant message content.
   *
   * Dependencies:
   *   - None at interface level.
   *
   * Dependants:
   *   - Advisor.plan, Advisor.advise.
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
   *   @param {string} model — Ollama model name.
   *   @param {Message[]} messages — System/user/assistant turns.
   *   @param {ChatOptions} options — Sampling options.
   *
   * Returns:
   *   @returns {AsyncGenerator<string>} — Yields incremental text chunks.
   *
   * Dependencies:
   *   - None at interface level.
   *
   * Dependants:
   *   - Advisor.combine, Agent.run.
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
   *   @returns {Promise<string[]>} — Model names only.
   *
   * Dependants:
   *   - Router models.list handler.
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
   *   @returns {Promise<OllamaModelSummary[]>} — Full tag rows.
   *
   * Dependants:
   *   - Router models.list handler.
   * </Summary>
   */
  listModelsDetailed(): Promise<OllamaModelSummary[]>;

  /**
   * <Summary>
   * What it does:
   *   Streams pull progress lines from POST /api/pull with stream true.
   *
   * Parameters:
   *   @param {string} name — Model name to pull.
   *
   * Returns:
   *   @returns {AsyncGenerator<PullProgress>} — Progress chunks until success.
   *
   * Dependants:
   *   - Future model management UI.
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
   *   @param {string} name — Model name to delete.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes when Ollama accepts delete.
   *
   * @throws {OllamaError} — When model missing or HTTP not ok.
   *
   * Dependants:
   *   - Future admin routes.
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
   *   @param {string} name — Model name to inspect.
   *
   * Returns:
   *   @returns {Promise<ModelInfo>} — Parsed JSON body.
   *
   * Dependants:
   *   - Future tooling routes.
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
   *   @returns {Promise<RunningModel[]>} — Running rows (may be empty).
   *
   * Dependants:
   *   - Future diagnostics routes.
   * </Summary>
   */
  listRunning(): Promise<RunningModel[]>;
}
