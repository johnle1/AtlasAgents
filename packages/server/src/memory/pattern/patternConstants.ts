/**
 * <Summary>
 * What it does:
 *   Constants for pattern extractor configuration and budget limits.
 *
 * How it fits in the system:
 *   Provides configuration values for token budgets and limits when
 *   extracting preference rules from experience records.
 * </Summary>
 */

/** Maximum characters for escalation reason in advisor prompt. */
export const ESCALATION_REASON_BUDGET = 200;

/** Maximum characters for escalation guidance in advisor prompt. */
export const ESCALATION_GUIDANCE_BUDGET = 600;

/** Maximum characters for user edit diff in advisor prompt. */
export const USER_EDIT_DIFF_BUDGET = 600;

/** Maximum characters for agent write diff in advisor prompt. */
export const AGENT_WRITE_DIFF_BUDGET = 400;

/** Maximum characters for style rule diff hint. */
export const STYLE_RULE_DIFF_BUDGET = 200;

/** Maximum number of user edits to include in advisor prompt. */
export const MAX_USER_EDITS_IN_PROMPT = 5;
