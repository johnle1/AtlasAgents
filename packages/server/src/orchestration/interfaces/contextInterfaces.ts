/**
 * Builds a memory-derived context header for injection into the agent's system prompt.
 *
 * @remarks
 * The agent benefits from being aware of relevant prior work, preferences, and codebase patterns
 * when planning a new task. This interface retrieves and formats memory snippets as a markdown
 * header that is prepended to the system prompt. The context is scoped by task keywords and
 * respects a configurable context budget to avoid crowding out the task description.
 *
 * **Primary consumer:**
 * - **AgentOrchestrator.runTask** — calls `build()` before agent planning to inject context.
 *
 * @example
 * ```ts
 * const context = await contextBuilder.build("Implement user authentication");
 * Returns markdown with relevant preference rules and prior patterns
 * Injected into agent system prompt for improved planning
 * ```
 */
export interface IContextBuilder {
  /**
   * Retrieves relevant memory snippets and formats them as a markdown header for the agent's system prompt.
   *
   * @remarks
   * Extracts keywords from the task text using language hints, queries the preference store
   * for rules matching those keywords, queries experience records for similar prior tasks,
   * ranks results by relevance score + confidence + recency, and selects top matches within
   * the configured context budget. The budget is calculated as:
   * `(modelContextWindow * maxContextBudget) tokens`
   *
   * This ensures memory injection doesn't crowd out the task description or response space.
   * Returns an empty string if no relevant memory is found or the budget is exhausted.
   *
   * @param taskText - Original user task request for keyword extraction and matching.
   * @param agentModelOverride - Optional model name to use for context budget calculation.
   *   When provided, overrides the default agent model from config (budget math only).
   * @param agentProviderOverride - Optional provider serving the agent role, overriding
   *   `agentProvider` from config. Decides how the budget's context window is
   *   sized: `"ollama"` resolves the model's real `num_ctx`, anything else
   *   assumes the default window, since `num_ctx` is Ollama-only and no other
   *   provider reports a trained context length.
   * @returns Markdown-formatted context header (may be empty if no relevant memory found).
   *
   * @example
   * ```ts
   * const context = await contextBuilder.build("Add dark mode to React app");
   * Returns something like:
   * "# Relevant Context\n\n## Preferences\n- Use CSS custom properties for themes\n\n## Prior Work\n..."
   * Empty string if no preferences or prior work match
   * ```
   */
  build(
    taskText: string,
    agentModelOverride?: string,
    agentProviderOverride?: string,
  ): Promise<string>;

  /**
   * Detects a single dominant language/framework stack mentioned in task text.
   *
   * @remarks
   * Intended for passing to `ISkillManager.selectForTask`'s `detectedStack`
   * hint, so stack-specific skill selection (and priority-based conflict
   * resolution between skills claiming the same stack) has a signal to act
   * on — without this, `detectedStack` is never populated and that whole
   * mechanism goes unused. Implementations should reuse whatever
   * language-detection data `build()` already loads (e.g. `language-hints.json`)
   * rather than introducing a second detection path.
   *
   * @param taskText - Original user task description.
   * @returns The detected stack tag (e.g. `"python"`, `"typescript"`), or
   *   `undefined` if no known stack is mentioned.
   *
   * @example
   * ```ts
   * const stack = await contextBuilder.detectStack("Write a Python unit test");
   * // "python"
   * ```
   */
  detectStack(taskText: string): Promise<string | undefined>;

  /**
   * Resolves a model's effective runtime context window (`num_ctx`).
   *
   * @remarks
   * The same value `build()` budgets a fraction of internally, exposed so
   * callers constructing an Ollama request for this model (e.g. the
   * orchestrator, before running the agent or subagent) can send the
   * identical `num_ctx` — the two must never be computed separately, or
   * the memory header ends up sized against a window Ollama doesn't
   * actually honor. See {@link ContextWindowResolver} in
   * `ollama/contextWindow.ts` for the full rationale.
   *
   * @param modelTag - Ollama model tag (e.g. `"llama2"`, `"gemma3:27b"`).
   * @returns The `num_ctx` to use for this model.
   *
   * @example
   * ```ts
   * const numCtx = await contextBuilder.resolveNumCtx(agentModel);
   * await ollama.chatWithTools(agentModel, messages, tools, { temperature, numCtx });
   * ```
   */
  resolveNumCtx(modelTag: string): Promise<number>;
}
