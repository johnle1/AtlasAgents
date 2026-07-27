/**
 * Constructs system and user messages for subagent task execution.
 *
 * @remarks
 * This module builds the initial conversation messages that bootstrap a subagent
 * to handle a specific subtask. Messages are layered in order of priority:
 * 1. Core agent behavioral rules (from `toolProtocol`)
 * 2. Retrieval strategy guidance (if TokenSave tools are available)
 * 3. Tool calling instruction (if native tool calls are unavailable)
 * 4. Command plan hints (from the parent task breakdown)
 * 5. Skill-specific context and documentation
 * 6. Session-level context and prior results
 *
 * This ordering ensures that behavioral rules take precedence over skill hints,
 * and tool teaching only inflates token usage when the model cannot natively
 * call tools.
 *
 * @example
 * ```ts
 * const messages = buildAgentMessages(
 *   "Debug the failed test in src/utils/auth.test.ts",
 *   "You have access to debugging tools and test output context.",
 *   "Prior test results show this failure is intermittent.",
 *   commandPlan,
 *   true, // model supports native tool calls
 *   toolSchemas
 * );
 * Returns: [{ role: "system", content: "..." }, { role: "user", content: "..." }]
 * ```
 */

import type { Message } from "../types.js";
import type { CommandPlan } from "../types.js";
import { formatCommandPlanBlock } from "../commandClassifier.js";
import { AGENT_RULES } from "../toolProtocol.js";
import { buildLegacyToolBlock } from "../tools/promptText.js";
import type { ToolSchema } from "../tools/types.js";
import { emptyCommandPlan } from "../types.js";

/**
 * Guidance text for when and how to use TokenSave retrieval tools.
 *
 * @remarks
 * Only injected into the system message when TokenSave tools are available.
 * Teaches the agent to distinguish between search/context (when the exact file
 * or symbol is unknown) and read_file (when the path is known). This prevents
 * expensive full-file reads for symbol discovery and accelerates common lookups.
 */
const RETRIEVAL_RULES = `
RETRIEVAL RULES:
Use tokensave_search / tokensave_context to find where a concept or behavior is
implemented when you don't know the exact file or symbol name — faster and
cheaper than grepping via run_command or reading whole files to search by eye.
Before editing a function or exported symbol, call tokensave_callers or
tokensave_impact to see what depends on it.
If you already know the exact file, read_file is still the right tool.
`.trim();

/**
 * Detects whether TokenSave retrieval tools are available in the tool schema list.
 *
 * @remarks
 * TokenSave tools enable efficient code discovery without grepping. Their
 * presence in the available toolset determines whether retrieval guidance
 * should be added to the system message. See `RETRIEVAL_RULES` for the
 * guidance text that gets injected when this returns true.
 *
 * @param toolSchemas - The full list of tool schemas available to the subagent.
 * @returns True if at least one tool name starts with `"tokensave_"`, false otherwise.
 *
 * @example
 * ```ts
 * const tools = [
 *   { function: { name: "tokensave_search", ... } },
 *   { function: { name: "run_command", ... } }
 * ];
 * console.log(hasTokenSaveTools(tools)); // true
 * ```
 */
const hasTokenSaveTools = (toolSchemas: ToolSchema[]): boolean =>
  toolSchemas.some((schema) => schema.function.name.startsWith("tokensave_"));

/**
 * Constructs the initial system and user messages for a subagent subtask.
 *
 * @remarks
 * Assembles a conversation starter by layering message sections in order of
 * precedence: core agent behavioral rules, optional retrieval guidance,
 * tool calling instructions (if needed), task-specific hints, skill context,
 * and session state. Empty sections are filtered to minimize token usage.
 *
 * This design ensures that rule conflicts resolve predictably (core rules win),
 * and that expensive sections like tool teaching only appear when the model
 * lacks native tool support.
 *
 * @param subtask - The specific task the subagent must perform. Becomes the
 *   user message content that the agent responds to.
 * @param skillContent - Skill documentation, API reference, or other
 *   domain-specific guidance. Can be empty. Trimmed before inclusion.
 * @param sessionContext - State from prior task steps, test output, or
 *   results that inform this subtask. Trimmed before inclusion.
 * @param commandPlan - The parent task's breakdown and execution plan,
 *   formatted for agent consumption. Defaults to an empty plan.
 * @param supportsTools - True if the model supports native tool calls
 *   (JSON-structured); false if tool calls must be taught as text. When true,
 *   skips expensive tool teaching text. When false, injects `TOOL_BLOCK`.
 * @param toolSchemas - The complete list of tool schemas available to the
 *   subagent. Used to detect TokenSave tools and build teaching text.
 * @returns A two-element Message array: `[{ role: "system", ... }, { role: "user", ... }]`.
 *
 * @example
 * ```ts
 * const messages = buildAgentMessages(
 *   "Refactor the auth middleware to use async/await",
 *   "Middleware patterns and auth flows in this codebase...",
 *   "Previous step found 3 files using the old callback pattern.",
 *   commandPlan,
 *   true,
 *   toolSchemas
 * );
 * Returns conversation bootstrap messages ready to send to the subagent model
 * ```
 */
export const buildAgentMessages = (
  subtask: string,
  skillContent: string,
  sessionContext: string,
  commandPlan: CommandPlan = emptyCommandPlan(),
  supportsTools: boolean,
  toolSchemas: ToolSchema[],
): Message[] => {
  const commandPlanBlock = formatCommandPlanBlock(commandPlan);

  // Tool teaching (text-structured tool calls) is only needed when the model
  // cannot natively generate JSON tool calls. Native support means Ollama
  // handles structure parsing, so we skip the expensive teaching block.
  const toolTeaching = supportsTools ? "" : buildLegacyToolBlock(toolSchemas);

  // Build the system message by stacking sections in order of precedence.
  // Filter empty strings to avoid wasting tokens on blank lines when optional
  // sections are omitted (e.g., empty skillContent, missing commandPlan).
  const systemContent = [
    AGENT_RULES,
    hasTokenSaveTools(toolSchemas) ? RETRIEVAL_RULES : "",
    toolTeaching,
    commandPlanBlock,
    skillContent.trim(),
    sessionContext.trim(),
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");

  return [
    { role: "system", content: systemContent },
    { role: "user", content: subtask },
  ];
};
