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
   * @param subagentModelOverride - Optional model name to use for context budget calculation.
   *   When provided, overrides the default subagent model from config (budget math only).
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
  build(taskText: string, subagentModelOverride?: string): Promise<string>;
}
