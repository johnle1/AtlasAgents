/**
 * <Summary>
 * What it does:
 *   Interface for context building in the orchestration layer.
 *
 * How it fits in the system:
 *   Defines the contract for building a memory-derived context header string that is
 *   inserted into the advisor system prompt. This context provides the advisor with
 *   relevant long-term memory snippets to improve task planning and understanding.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Builds a memory-derived context header string for the advisor system prompt.
 *
 * How it fits in the system:
 *   The advisor needs context about the codebase to plan effectively. This interface
 *   defines how to retrieve relevant memory snippets and format them as a cohesive header
 * block that can be inserted into the advisor's system prompt.
 *
 * Used by:
 *   - AdvisorOrchestrator.runTask — before Advisor.plan to provide context.
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
   * How it does it (step by step):
   *   1. Extract keywords from the task text for memory retrieval.
   *   2. Query long-term memory storage for relevant experience records.
   *   3. Rank results by relevance and recency.
   *   4. Format selected snippets as a coherent header block.
   *   5. Return the formatted context string (may be empty if no relevant memory).
   *
   * Parameters:
   *   @param taskText - Original user task string for keyword extraction and relevance matching.
   *   @param advisorModelOverride - Optional advisor model name for context budget calculation (overrides config).
   *
   * Returns:
   *   @returns Context header text (may be empty if no relevant memory found).
   * </Summary>
   */
  build(taskText: string, advisorModelOverride?: string): Promise<string>;
}
