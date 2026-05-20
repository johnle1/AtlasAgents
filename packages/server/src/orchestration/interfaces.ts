/**
 * <Summary>
 * What it does:
 *   Dependency contracts for the orchestration layer so Advisor, Agent, and
 *   AdvisorOrchestrator compile before concrete Ollama, config, memory, and
 *   skills implementations exist.
 *
 * How it fits in the system:
 *   Server bootstrap will eventually construct real classes implementing these
 *   interfaces and inject them into AdvisorOrchestrator.
 *
 * Dependencies:
 *   - types.ts — Message, ChatOptions, OrchestrationOutcome.
 *
 * Dependants:
 *   - Advisor, Agent, AdvisorOrchestrator — constructor deps only.
 * </Summary>
 */

import type { ModelInfo, PullProgress, RunningModel } from "../ollama/types.js";
import type { ChatOptions, Message, OrchestrationOutcome } from "./types.js";

/**
 * <Summary>
 * What it does:
 *   One substring match that adds a topic tag when found in the task text.
 *
 * Used by:
 *   - extractKeywords in contextBuilder.ts.
 *
 * Produced by:
 *   - user-data/language-hints.json or packaged default-data copy.
 * </Summary>
 */
export interface LanguageHint {
  /** Lowercase-friendly substring to search for in the task text. */
  needle: string;

  /** Topic tag stored on preference rules and used for overlap filtering. */
  tag: string;
}

/**
 * <Summary>
 * What it does:
 *   One persisted user preference rule used by ContextBuilder and memory routes.
 *
 * Used by:
 *   - IPreferenceStore.getAll — returns rule rows.
 *
 * Produced by:
 *   - PreferenceStore.add — creates new ids and timestamps.
 * </Summary>
 */
export interface PreferenceRule {
  /** Stable unique id for this rule. */
  id: string;

  /** Human-readable rule text. */
  text: string;

  /** Topic tags for overlap filtering against task keywords. */
  topics: string[];

  /** How often this rule was applied (higher sorts first). */
  timesApplied: number;

  /** ISO-8601 creation time. */
  createdAt: string;
}

/**
 * <Summary>
 * What it does:
 *   File-backed preference storage for long-lived user rules.
 *
 * Used by:
 *   - ContextBuilder — reads all rules at task start.
 *   - Future memory command handlers — mutate rules.
 *
 * Produced by:
 *   - packages/server/src/memory/preferenceStore.ts.
 * </Summary>
 */
export interface IPreferenceStore {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns every stored preference rule (empty array when file missing).
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<PreferenceRule[]>} — All rules in stable storage order.
   *
   * Dependencies:
   *   None at interface level.
   *
   * Dependants:
   *   - ContextBuilder.build.
   * </Summary>
   */
  getAll(): Promise<PreferenceRule[]>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Appends a new rule with fresh id and createdAt.
   *
   * Parameters:
   *   @param {string} text — Rule body text.
   *   @param {string[]} topics — Topic tags (may be empty for universal rules).
   *
   * Returns:
   *   @returns {Promise<PreferenceRule>} — Persisted row.
   *
   * Dependants:
   *   - Future memory routes.
   * </Summary>
   */
  add(text: string, topics: string[]): Promise<PreferenceRule>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Removes one rule by id when present.
   *
   * Parameters:
   *   @param {string} id — Rule id to delete.
   *
   * Returns:
   *   @returns {Promise<boolean>} — True when a row was removed.
   *
   * Dependants:
   *   - Future memory routes.
   * </Summary>
   */
  remove(id: string): Promise<boolean>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deletes all rules from storage.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes after atomic write.
   *
   * Dependants:
   *   - Future memory routes.
   * </Summary>
   */
  clear(): Promise<void>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Increments timesApplied for one rule (no-op when id missing).
   *
   * Parameters:
   *   @param {string} id — Rule id to bump.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes after persistence.
   *
   * Dependants:
   *   - Future learning hooks.
   * </Summary>
   */
  markApplied(id: string): Promise<void>;
}

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

/**
 * <Summary>
 * What it does:
 *   Read-only access to persisted or session server configuration for models,
 *   temperatures, and agent retry limits.
 *
 * Used by:
 *   - Advisor, Agent — model names and sampling settings per call site.
 *
 * Produced by:
 *   - Future packages/server/src/config/configManager.ts implementation.
 * </Summary>
 */
export interface IConfigManager {
  /**
   * <Summary>
   * What it does:
   *   Returns the Ollama model name used for planning, advising, and combine.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<string>} — Advisor model id string.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - Advisor.plan, Advisor.advise, Advisor.combine.
   * </Summary>
   */
  getAdvisorModel(): Promise<string>;

  /**
   * <Summary>
   * What it does:
   *   Returns the Ollama model name used for subtask execution.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<string>} — Agent model id string.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - Agent.run.
   * </Summary>
   */
  getAgentModel(): Promise<string>;

  /**
   * <Summary>
   * What it does:
   *   Returns advisor sampling temperature (planning and advise use this).
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<number>} — Temperature, typically low (e.g. 0.1).
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - Advisor.plan, Advisor.advise.
   * </Summary>
   */
  getAdvisorTemperature(): Promise<number>;

  /**
   * <Summary>
   * What it does:
   *   Returns agent sampling temperature for subtask runs.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<number>} — Temperature for execution.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - Agent.run.
   * </Summary>
   */
  getAgentTemperature(): Promise<number>;

  /**
   * <Summary>
   * What it does:
   *   Returns maximum advisor-assisted retries after an ESCALATE response.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<number>} — Max retry attempts (>= 1).
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - Agent.run.
   * </Summary>
   */
  getMaxRetries(): Promise<number>;
}

/**
 * <Summary>
 * What it does:
 *   Builds a memory-derived context header string for the advisor system prompt.
 *
 * Used by:
 *   - AdvisorOrchestrator.runTask — before Advisor.plan.
 *
 * Produced by:
 *   - packages/server/src/memory/contextBuilder.ts — uses Ollama show + advisor model for budget.
 * </Summary>
 */
export interface IContextBuilder {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Retrieves relevant long-term memory snippets and formats them as one header block.
   *
   * Parameters:
   *   @param {string} taskText — Original user task string.
   *
   * Returns:
   *   @returns {Promise<string>} — Context header text (may be empty).
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - AdvisorOrchestrator.runTask.
   * </Summary>
   */
  build(taskText: string): Promise<string>;
}

/**
 * <Summary>
 * What it does:
 *   Selects the single best-matching skill document for a natural-language task.
 *
 * Used by:
 *   - AdvisorOrchestrator.runTask — supplies skill body to plan and agents.
 *
 * Produced by:
 *   - Future packages/server/src/skills/skillManager.ts implementation.
 * </Summary>
 */
export interface ISkillManager {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Chooses one skill file by relevance to the task text, or returns null.
   *
   * Parameters:
   *   @param {string} taskText — User task for matching.
   *
   * Returns:
   *   @returns {Promise<{ name: string; content: string } | null>} — Skill metadata and body.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - AdvisorOrchestrator.runTask.
   * </Summary>
   */
  selectForTask(
    taskText: string,
  ): Promise<{ name: string; content: string } | null>;
}

/**
 * <Summary>
 * What it does:
 *   Records the lifecycle of one orchestrated task for experience replay and pattern extraction.
 *
 * Used by:
 *   - AdvisorOrchestrator.runTask — bracketing one user task.
 *
 * Produced by:
 *   - Future packages/server/src/memory/experienceRecorder.ts implementation.
 * </Summary>
 */
export interface IExperienceRecorder {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Opens a new experience record when a task begins.
   *
   * Parameters:
   *   @param {string} taskId — Unique id for this orchestration run.
   *   @param {string} taskText — Original user task.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes when storage is ready.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - AdvisorOrchestrator.runTask.
   * </Summary>
   */
  start(taskId: string, taskText: string): Promise<void>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Finalises the record with outcomes and triggers downstream extractors.
   *
   * Parameters:
   *   @param {string} taskId — Same id passed to start.
   *   @param {OrchestrationOutcome} outcome — Plan, results, ok flag, optional error.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes after persistence side effects.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - AdvisorOrchestrator.runTask.
   * </Summary>
   */
  finish(taskId: string, outcome: OrchestrationOutcome): Promise<void>;
}

export type { ModelInfo, PullProgress, RunningModel } from "../ollama/types.js";
export { OllamaError } from "../ollama/types.js";
