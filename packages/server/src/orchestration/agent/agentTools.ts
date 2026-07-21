/**
 * Agent tool definitions, constants, and detection utilities.
 *
 * @remarks
 * Exports tool schemas for submit_plan, explore_codebase, and rule strings for agent behavior.
 * Provides utility functions to classify and filter tool calls by name.
 */

import type { ToolSchema } from "../tools/types.js";
import {
  AGENT_PLAN_TOOL_SCHEMA,
  SUBMIT_PLAN_TOOL,
} from "./agentThink.js";

export { AGENT_PLAN_TOOL_SCHEMA, SUBMIT_PLAN_TOOL };

/** Official tool name for plan submission: "submit_plan". */
export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

/** Official tool name for workspace exploration: "explore_codebase". */
export const EXPLORE_CODEBASE_TOOL_NAME = "explore_codebase";

/** @deprecated Use SUBMIT_PLAN_TOOL — retained for backward compatibility. */
export const PROPOSE_PLAN_TOOL = SUBMIT_PLAN_TOOL;

/**
 * Checks whether a tool array contains at least one TokenSave search tool.
 *
 * @remarks
 * TokenSave search tools are identified by the `tokensave_` prefix.
 *
 * @param tools - Array of tool schemas to check.
 * @returns `true` if at least one search tool is present.
 */
export const hasAgentSearchTools = (tools: ToolSchema[]): boolean =>
  tools.some((schema) => schema.function.name.startsWith("tokensave_"));

/**
 * Checks whether a tool name is the explore_codebase tool.
 *
 * @param name - Tool name to check.
 * @returns `true` if name is exactly "explore_codebase".
 */
export const isExploreCodebaseTool = (name: string): boolean =>
  name === EXPLORE_CODEBASE_TOOL_NAME;

/**
 * Checks whether a tool name is a TokenSave search tool.
 *
 * @remarks
 * TokenSave search tools are identified by the `tokensave_` prefix.
 *
 * @param name - Tool name to check.
 * @returns `true` if name starts with "tokensave_".
 */
export const isAgentSearchToolName = (name: string): boolean =>
  name.startsWith("tokensave_");

/**
 * Checks whether a tool name is the submit_plan tool.
 *
 * @param name - Tool name to check.
 * @returns `true` if name is exactly "submit_plan".
 */
export const isSubmitPlanTool = (name: string): boolean =>
  name === SUBMIT_PLAN_TOOL_NAME;

/**
 * Checks whether a tool name is a pre-planning auxiliary tool (explore or search).
 *
 * @remarks
 * These tools are called before submit_plan for exploration and verification.
 *
 * @param name - Tool name to check.
 * @returns `true` if name is explore_codebase or a TokenSave search tool.
 */
export const isAgentPrePlanToolName = (name: string): boolean =>
  isExploreCodebaseTool(name) || isAgentSearchToolName(name);

/**
 * Rule string injected into agent system prompt to guide exploration behavior.
 *
 * @remarks
 * Instructs the agent to call explore_codebase only when truly needed (unknown stack/layout),
 * and to use the returned structure in planning. Prevents unnecessary exploration calls.
 */
export const AGENT_EXPLORATION_RULES = `
AGENT EXPLORATION RULES:
Before assuming language, framework, test runner, or file layout, decide in your EXPLORATION section whether you need workspace structure.
When need explore? is yes, call explore_codebase for the ONE specific unknown — this is the cheap exploration path; do not guess stack or test runner and do not burn planner context on file reads you can avoid.
Call explore_codebase when stack or layout is unknown, the session lacks a Structure snapshot, or the task depends on where code/tests live.
After explore_codebase returns, use the real directory tree in EXPLORATION's "if no" line before planning.
`.trim();

/**
 * Rule string injected into agent system prompt to guide TokenSave search tool usage.
 *
 * @remarks
 * Instructs the agent that it may call TokenSave search tools to verify file paths
 * and symbols instead of guessing, but to stop searching once it has enough information.
 */
export const AGENT_RETRIEVAL_RULES = `
AGENT RETRIEVAL RULES:
You may call tokensave_search / tokensave_context / tokensave_callers / tokensave_impact / tokensave_callees / tokensave_status before submitting your plan, to confirm real file paths and symbols instead of guessing.
Call submit_plan once you have enough information — do not search more than necessary.
`.trim();

/**
 * Tool schema for the explore_codebase tool.
 *
 * @remarks
 * Allows the agent to request a workspace directory tree snapshot (depth 2) to
 * detect language/framework, test layout, and file structure before planning.
 * Called when the agent's EXPLORATION section says "yes" and native tool calling is available.
 */
export const EXPLORE_CODEBASE_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: EXPLORE_CODEBASE_TOOL_NAME,
    description:
      "List the workspace directory tree (depth 2) so you can detect stack, test layout, and file paths before planning. Call when EXPLORATION need explore? is yes.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Brief reason you need structure (e.g. unknown stack, no session snapshot).",
        },
      },
      required: ["reason"],
    },
  },
};
