/**
 * Configuration constants for pattern extraction and rule learning.
 *
 * @remarks
 * Defines token/character budgets for truncating experience data when
 * sending to the agent model for rule extraction. Used by {@link PatternExtractor}
 * to manage token usage while preserving meaningful context.
 *
 * **Budgeting Strategy:**
 * - Escalation reasons (what went wrong) ≤ 200 chars
 * - Escalation guidance (how to fix) ≤ 600 chars
 * - Agent write diffs ≤ 400 chars
 * - User edit diffs ≤ 600 chars
 * - Style rule hints ≤ 200 chars
 * - Max user edits to include: 5 (sampled)
 */

/** Maximum characters for escalation reason in agent prompt. */
export const ESCALATION_REASON_BUDGET = 200;

/** Maximum characters for escalation guidance in agent prompt. */
export const ESCALATION_GUIDANCE_BUDGET = 600;

/** Maximum characters for user edit diff in agent prompt. */
export const USER_EDIT_DIFF_BUDGET = 600;

/** Maximum characters for subagent write diff in agent prompt. */
export const AGENT_WRITE_DIFF_BUDGET = 400;

/** Maximum characters for style rule diff hint. */
export const STYLE_RULE_DIFF_BUDGET = 200;

/** Maximum number of user edits to include in agent prompt. */
export const MAX_USER_EDITS_IN_PROMPT = 5;
