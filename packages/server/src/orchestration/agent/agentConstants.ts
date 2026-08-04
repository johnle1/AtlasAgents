/**
 * Constants and types for agent planning configuration and lifecycle hooks.
 *
 * @remarks
 * Defines safe limits on planning iterations and provides extension points for
 * observing and controlling the planning process (hooks). The constants prevent
 * runaway AI model loops; the hooks allow external code to monitor reasoning,
 * review plans, and provide search/exploration capabilities.
 */

import type { ToolSchema } from "../tools/types.js";
import type { SubagentPlan, PlanReviewResponse } from "../types.js";

/**
 * Maximum number of plan validation/revision loops.
 *
 * @remarks
 * After this many iterations, if the plan still has gaps or invalid JSON,
 * planning fails with an error rather than continuing indefinitely.
 * This is a safety mechanism against model failures and prevents context exhaustion.
 *
 * @default 3
 */
export const MAX_AGENT_LOOPS = 3;

/**
 * Maximum TokenSave search tool calls allowed per planning iteration.
 *
 * @remarks
 * Prevents the model from making excessive search calls and consuming tokens.
 * Once exhausted, search tools are no longer offered to the model.
 *
 * @default 4
 */
export const MAX_AGENT_SEARCH_CALLS = 4;

/**
 * Maximum `explore_codebase` calls allowed per planning iteration.
 *
 * @remarks
 * Limits workspace structure exploration to avoid redundant calls and context waste.
 * After exhausting this budget, explore_codebase is no longer offered.
 *
 * @default 1
 */
export const MAX_AGENT_EXPLORE_CALLS = 1;

/**
 * Hard cap on total planning loop iterations (explore + search + verification combined).
 *
 * @remarks
 * Sum of individual budgets: `MAX_AGENT_EXPLORE_CALLS + MAX_AGENT_SEARCH_CALLS + MAX_AGENT_LOOPS`.
 * Provides an absolute upper bound on planning attempts across all categories.
 *
 * Calculated as: 1 + 4 + 3 = 8
 */
export const MAX_AGENT_TOTAL_ITERATIONS =
  MAX_AGENT_EXPLORE_CALLS + MAX_AGENT_SEARCH_CALLS + MAX_AGENT_LOOPS;

/**
 * Lifecycle hooks for observing and controlling the planning process.
 *
 * @remarks
 * Allows callers to inject custom logic at key points:
 * - **onThink** — Observe the model's reasoning (called per iteration).
 * - **reviewPlan** — Gate plan execution on external approval/edits.
 * - **exploreCodebase** — Provide workspace structure when requested.
 * - **callSearchTool** — Execute TokenSave searches on behalf of the model.
 * - **searchTools** — Register available search tool schemas.
 *
 * @example
 * ```ts
 * const hooks: SubagentPlanHooks = {
 *   onThink: (text) => console.log("Agent reasoning:", text.slice(0, 100)),
 *   reviewPlan: async (plan) => ({
 *     decision: "implement" // Auto-approve, or require user confirmation
 *   }),
 *   exploreCodebase: async () => ({ snapshot: "..." })
 * };
 * ```
 */
export type SubagentPlanHooks = {
  /**
   * Called each time the agent produces a think block during planning.
   *
   * @remarks
   * Invoked for each iteration, enabling logging, analysis, or user feedback display.
   * Does not influence plan output (pure observation).
   *
   * @param thinkText - The agent's `<agent-think>` block content.
   */
  onThink?: (thinkText: string) => void;

  /**
   * Called with each newly-available slice of `<agent-think>` inner text as
   * the model streams its response, letting callers render reasoning
   * incrementally instead of waiting for the whole block.
   *
   * @remarks
   * Purely additive to `onThink` — fires many times per iteration (as text
   * becomes available), while `onThink` still fires once with the complete
   * block. A caller that only wants today's behavior can ignore this hook.
   *
   * @param text - The next slice of think text (may be any length, including
   *   a single character).
   */
  onThinkDelta?: (text: string) => void;

  /**
   * Called once per planning iteration when the model turn ends, closing out
   * whatever `onThinkDelta` started.
   *
   * @remarks
   * Fires even when the turn produced no complete think block (`null`) —
   * e.g. the model opened `<agent-think>` but was truncated before closing
   * it — so a caller streaming deltas always gets a matching close signal
   * and never renders a permanently-open block.
   *
   * @param finalText - The complete think text for this iteration, or `null`
   *   if none was found.
   */
  onThinkEnd?: (finalText: string | null) => void;

  /**
   * Called after plan validation to allow external review and approval.
   *
   * @remarks
   * Return `{ decision: "implement" }` to proceed, `"skip"` to cancel,
   * or `"edit"` with feedback to request plan revision (caller re-invokes
   * `Agent.plan()` with updated task incorporating the feedback).
   *
   * @param plan - The validated plan ready for execution (unless edited).
   * @returns Review decision: proceed, skip, or edit with feedback.
   */
  reviewPlan?: (plan: SubagentPlan) => Promise<PlanReviewResponse>;

  /**
   * Array of available TokenSave search tool schemas the agent may call.
   *
   * @remarks
   * Read-only; passed to the model if native tool calling is enabled
   * and search tools are available. The model may call these to verify
   * file paths and symbols.
   */
  searchTools?: ToolSchema[];

  /**
   * Executes a search tool call on behalf of the model.
   *
   * @remarks
   * Called when the model invokes a search tool (e.g., `tokensave_search`).
   * Mirrors the return shape of WorkspaceManager.callMcpTool.
   *
   * @param name - Tool name (e.g., `"tokensave_search"`).
   * @param args - Tool arguments from the model's invocation.
   * @returns Result with `isError` flag and optional `data` or `errorMessage`.
   */
  callSearchTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ isError: boolean; data?: unknown; errorMessage?: string }>;

  /**
   * Provides the workspace directory structure when the agent calls `explore_codebase`.
   *
   * @remarks
   * Called when the model's EXPLORATION section says "yes" and it invokes the tool.
   * Should return a text snapshot of the directory tree (typically depth 2–3).
   *
   * @returns Workspace structure snapshot as markdown or plain text.
   */
  exploreCodebase?: () => Promise<{ snapshot: string }>;
};
