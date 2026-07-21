/**
 * Type definition and parsing functions for the max_subagents configuration parameter.
 *
 * @remarks
 * The max_subagents parameter controls how many subagents can work in parallel on a task.
 * Users can set this via CLI flag /subagent cap to control resource usage and execution mode.
 * Supports special values (1, 2, "max") and custom numeric caps.
 */

/**
 * Type definition for the max_subagents parameter.
 *
 * @remarks
 * Can be special values (1, 2, "max") or a custom numeric cap.
 * - 1: Focus mode - single subagent, sequential execution
 * - 2: Collab mode - exactly two subagent groups
 * - "max": Unlimited subagents - use as many as the task needs
 * - number: Custom cap - user-defined limit (minimum 3)
 */
export type MaxSubagentsParam = 1 | 2 | "max" | number;

/** Default subagent cap when parsing fails or value is invalid */
const DEFAULT_SUBAGENT_CAP = 3;

/** Minimum allowed subagent cap (cannot go below 1) */
const MIN_SUBAGENT_CAP = 1;

/**
 * Clamps a subagent cap value to the minimum allowed value.
 *
 * @remarks
 * Floors the input value to remove decimals, then ensures the result is at least
 * MIN_SUBAGENT_CAP (1). Used to prevent invalid subagent cap values.
 *
 * @param subagentCap - The subagent cap value to clamp
 *
 * @returns The clamped subagent cap (minimum 1)
 */
export const clampSubagentCap = (subagentCap: number): number =>
  Math.max(MIN_SUBAGENT_CAP, Math.floor(subagentCap));

/**
 * Parses a max_subagents value from CLI or config into a normalized MaxSubagentsParam.
 *
 * @remarks
 * Handles special values (1, 2, "max"), numeric values, and string numeric values.
 * Clamps numeric values to the minimum allowed cap. Defaults to DEFAULT_SUBAGENT_CAP
 * (3) for invalid or unrecognized values.
 *
 * @param value - The raw value from CLI or config (untrusted)
 *
 * @returns Normalized max_subagents parameter
 */
export const parseMaxSubagentsPayload = (value: unknown): MaxSubagentsParam => {
  if (value === 1 || value === "1") {
    return 1;
  }
  if (value === 2 || value === "2") {
    return 2;
  }
  if (value === "max") {
    return "max";
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return clampSubagentCap(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsedNumber = parseInt(value, 10);
    if (Number.isInteger(parsedNumber)) {
      return clampSubagentCap(parsedNumber);
    }
  }

  return DEFAULT_SUBAGENT_CAP;
};

/**
 * Generates human-readable text describing the max_subagents constraint.
 *
 * @remarks
 * Returns descriptive text for special values (1, 2, "max") and custom numeric caps.
 * Used to display the current subagent constraint to users in status messages.
 *
 * @param maxSubagents - The max_subagents parameter to describe
 *
 * @returns Human-readable description of the constraint
 */
export const maxSubagentsConstraintText = (maxSubagents: MaxSubagentsParam): string => {
  if (maxSubagents === 1) {
    return "1 (focus — single subagent, all steps sequential)";
  }
  if (maxSubagents === 2) {
    return "2 (collab — exactly two subagent groups)";
  }
  if (maxSubagents === "max") {
    return "unlimited (no subagent cap — use as many subagents as the task needs)";
  }

  if (typeof maxSubagents === "number") {
    return `up to ${maxSubagents} subagents (user cap via /subagent cap)`;
  }

  return `up to ${DEFAULT_SUBAGENT_CAP} subagents (user cap)`;
};

/**
 * Type guard to check if maxSubagents is a custom numeric cap (> 2).
 *
 * @remarks
 * Returns true if maxSubagents is a number greater than 2, which indicates it's a
 * custom user cap rather than a special value (1 or 2). Used for type narrowing
 * in conditional logic.
 *
 * @param maxSubagents - The max_agents parameter to check
 *
 * @returns True if maxSubagents is a custom numeric cap (> 2)
 */
export const isNumericCap = (maxSubagents: MaxSubagentsParam): maxSubagents is number =>
  typeof maxSubagents === "number" && maxSubagents > 2;
