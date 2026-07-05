/**
 * <Summary>
 * What it does:
 *   Builds initial messages for agent execution by combining tool instructions,
 *   command plans, skill content, and session context.
 *
 * How it fits in the system:
 *   The agent needs a comprehensive system prompt that includes tool usage rules,
 *   the advisor's command plan (for classifying shell commands), skill documentation,
 *   and session context. This module assembles all these components into a coherent
 *   system prompt and the initial user message containing the subtask.
 * </Summary>
 */

import type { Message } from "../types.js";
import type { CommandPlan } from "../types.js";
import { formatCommandPlanBlock } from "../commandClassifier.js";
import { TOOL_SYSTEM_INSTRUCTION } from "../toolProtocol.js";
import { emptyCommandPlan } from "../types.js";

/**
 * <Summary>
 * What it does:
 *   Builds initial messages for agent execution.
 *
 * How it does it (step by step):
 *   1. Format command plan block if provided (from advisor).
 *   2. Combine tool instruction, command plan, skill content, and session context.
 *   3. Filter out empty sections to avoid double newlines.
 *   4. Join sections with double newlines for separation.
 *   5. Create system message with combined content.
 *   6. Create user message with subtask description.
 *   7. Return message array [system, user].
 *
 * Parameters:
 *   @param subtask - The subtask description for the agent to execute.
 *   @param skillContent - Selected skill documentation (may be empty).
 *   @param sessionContext - Session context header (may be empty).
 *   @param commandPlan - Command plan with setup/verify/off-limits commands.
 *
 * Returns:
 *   {Message[]} — Initial message array [system, user] for agent.
 * </Summary>
 */
export const buildAgentMessages = (
  subtask: string,
  skillContent: string,
  sessionContext: string,
  commandPlan: CommandPlan = emptyCommandPlan(),
): Message[] => {
  // Step 1: Format command plan block if provided (from advisor)
  const commandPlanBlock = formatCommandPlanBlock(commandPlan);

  // Step 2-4: Combine tool instruction, command plan, skill content, and session context
  // Filter out empty sections to avoid double newlines
  const systemContent = [
    TOOL_SYSTEM_INSTRUCTION,
    commandPlanBlock,
    skillContent.trim(),
    sessionContext.trim(),
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");

  // Step 5-7: Create system and user messages
  return [
    { role: "system", content: systemContent },
    { role: "user", content: subtask },
  ];
};
