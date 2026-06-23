/**
 * <Summary>
 * What it does:
 *   Type definition and parsing functions for the max_agents configuration parameter.
 *
 * How it fits in the system:
 *   The max_agents parameter controls how many agents can work in parallel on a task.
 *   Users can set this via CLI flag /agent cap to control resource usage and execution mode.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Type definition for the max_agents parameter.
 *
 * How it fits in the system:
 *   Can be special values (1, 2, "max") or a custom numeric cap.
 *
 * Possible Values:
 *   1 — Focus mode: single agent, sequential execution.
 *   2 — Collab mode: exactly two agent groups.
 *   "max" — Unlimited agents: use as many as the task needs.
 *   number — Custom cap: user-defined limit (minimum 3).
 * </Summary>
 */
export type MaxAgentsParam = 1 | 2 | "max" | number;

/** Default agent cap when parsing fails or value is invalid. */
const DEFAULT_AGENT_CAP = 3;

/** Minimum allowed agent cap (cannot go below 1). */
const MIN_AGENT_CAP = 1;

/**
 * <Summary>
 * What it does:
 *   Clamps an agent cap value to the minimum allowed value.
 *
 * How it does it (step by step):
 *   1. Floor the input value to remove decimals.
 *   2. Ensure the result is at least MIN_AGENT_CAP.
 *
 * Parameters:
 *   @param agentCap - The agent cap value to clamp.
 *
 * Returns:
 *   {number} — The clamped agent cap (minimum 1).
 * </Summary>
 */
export const clampAgentCap = (agentCap: number): number =>
  // Step 1-2: Floor the value and ensure minimum cap
  Math.max(MIN_AGENT_CAP, Math.floor(agentCap));

/**
 * <Summary>
 * What it does:
 *   Parses a max_agents value from CLI or config into a normalized MaxAgentsParam.
 *
 * How it does it (step by step):
 *   1. Check for special values: 1, 2, "max".
 *   2. Handle numeric values (clamp to minimum).
 *   3. Handle string numeric values (parse and clamp).
 *   4. Default to DEFAULT_AGENT_CAP for invalid values.
 *
 * Parameters:
 *   @param value - The raw value from CLI or config (untrusted).
 *
 * Returns:
 *   {MaxAgentsParam} — Normalized max_agents parameter.
 * </Summary>
 */
export const parseMaxAgentsPayload = (value: unknown): MaxAgentsParam => {
  // Step 1: Check for special values: 1, 2, "max"
  if (value === 1 || value === "1") {
    return 1;
  }
  if (value === 2 || value === "2") {
    return 2;
  }
  if (value === "max") {
    return "max";
  }

  // Step 2: Handle numeric values (clamp to minimum)
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampAgentCap(value);
  }

  // Step 3: Handle string numeric values (parse and clamp)
  if (typeof value === "string" && value.trim().length > 0) {
    const parsedNumber = parseInt(value, 10);
    if (Number.isInteger(parsedNumber)) {
      return clampAgentCap(parsedNumber);
    }
  }

  // Step 4: Default to DEFAULT_AGENT_CAP for invalid values
  return DEFAULT_AGENT_CAP;
};

/**
 * <Summary>
 * What it does:
 *   Generates human-readable text describing the max_agents constraint.
 *
 * How it does it (step by step):
 *   1. Check for special values and return their descriptions.
 *   2. Handle custom numeric caps with user cap message.
 *   3. Default to DEFAULT_AGENT_CAP description.
 *
 * Parameters:
 *   @param maxAgents - The max_agents parameter to describe.
 *
 * Returns:
 *   {string} — Human-readable description of the constraint.
 * </Summary>
 */
export const maxAgentsConstraintText = (maxAgents: MaxAgentsParam): string => {
  // Step 1: Check for special values and return their descriptions
  if (maxAgents === 1) {
    return "1 (focus — single agent, all steps sequential)";
  }
  if (maxAgents === 2) {
    return "2 (collab — exactly two agent groups)";
  }
  if (maxAgents === "max") {
    return "unlimited (no agent cap — use as many agents as the task needs)";
  }

  // Step 2: Handle custom numeric caps with user cap message
  if (typeof maxAgents === "number") {
    return `up to ${maxAgents} agents (user cap via /agent cap)`;
  }

  // Step 3: Default to DEFAULT_AGENT_CAP description
  return `up to ${DEFAULT_AGENT_CAP} agents (user cap)`;
};

/**
 * <Summary>
 * What it does:
 *   Type guard to check if maxAgents is a custom numeric cap (> 2).
 *
 * How it does it (step by step):
 *   1. Check if maxAgents is a number.
 *   2. Check if it's greater than 2 (not special value 1 or 2).
 *
 * Parameters:
 *   @param maxAgents - The max_agents parameter to check.
 *
 * Returns:
 *   {boolean} — True if maxAgents is a custom numeric cap (> 2).
 * </Summary>
 */
export const isNumericCap = (maxAgents: MaxAgentsParam): maxAgents is number =>
  // Step 1-2: Check if it's a number greater than 2
  typeof maxAgents === "number" && maxAgents > 2;
