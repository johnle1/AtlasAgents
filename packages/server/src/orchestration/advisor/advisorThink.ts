/**
 * <Summary>
 * What it does:
 *   Parses advisor-think blocks to extract plan lines, command plans, risks,
 *   and verification gaps. Also builds the advisor think instruction template.
 *
 * How it fits in the system:
 *   The advisor AI model outputs a structured <advisor-think> block containing
 *   the planning process. These functions parse that block to extract structured
 *   data like command plans, risk lists, and numbered plan steps. This data is
 *   used to validate and build the executable AdvisorPlan.
 *
 * Dependencies:
 *   - maxAgents.ts — MaxAgentsParam type and constraint text.
 *   - planHelpers.ts — deriveExecution for plan validation.
 *   - types.ts — AdvisorPlan, CommandPlan, PlannedSubtask, PlanReviewResponse types.
 *
 * Dependants:
 *   - advisorHelpers.ts — re-exports these functions for use in advisor.ts.
 *   - advisor.ts — uses these functions to parse and validate advisor output.
 * </Summary>
 */

import type { MaxAgentsParam } from "../maxAgents.js";
import { maxAgentsConstraintText } from "../maxAgents.js";
import type {
  AdvisorPlan,
  CommandPlan,
  PlannedSubtask,
  PlanReviewResponse,
} from "../types.js";
import { deriveExecution } from "../planHelpers.js";

/**
 * <Summary>
 * What it does:
 *   Regular expression to match advisor-think blocks in model output.
 *
 * How it fits in the system:
 *   The advisor model wraps its reasoning in <advisor-think> blocks.
 *   This regex extracts the content between the tags for parsing.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - extractAdvisorThink — extracts think block content.
 *   - stripAdvisorThink — removes think block from output.
 * </Summary>
 */
const ADVISOR_THINK_RE = /<advisor-think>([\s\S]*?)<\/advisor-think>/i;

/**
 * <Summary>
 * What it does:
 *   Template for the advisor think instruction that prompts the model to
 *   include structured reasoning before the JSON plan.
 *
 * How it fits in the system:
 *   This template is inserted into the system prompt to tell the advisor model
 *   what structure to use for its reasoning. The template includes placeholders for
 *   max_agents constraint and agent assignment rules that are filled in dynamically.
 *
 * Dependencies:
 *   - maxAgents.ts — maxAgentsConstraintText for the MAX_AGENTS placeholder.
 *
 * Dependants:
 *   - buildAdvisorThinkInstruction — fills in placeholders to create instruction.
 * </Summary>
 */
const ADVISOR_THINK_TEMPLATE = `Before the JSON plan, write a structured <advisor-think> block:

<advisor-think>
UNDERSTAND:
  literal:  [what the user literally typed]
  actual:   [what they actually need technically]
  implicit: [env vars, error handling, edge cases they did not say]

CONTEXT FROM SESSION:
  stack:      [language, framework from context]
  state:      [what exists now relevant to this task]
  missing:    [what does not exist yet that this task needs]

DRAFT PLAN:
  agent count: [how many agents — explain why]
  execution:   [parallel | sequential | mixed]

  Agent 1 — [label]:
    1. [step — tool it uses — why]
    2. [step]

  Agent 2 — [label]:
    3. [step]
  ...

VERIFY PLAN:
  requirement covered?  [yes / no — explain if no]
  order correct?        [yes / no]
  steps missing?        [none or list missing steps]
  risks?                [bullets of what could break]

REVISED PLAN (only if verify found issues):
  1. [corrected step]
  ...

COMMAND PLAN:
  setup commands:   [concrete shell commands that install/configure and exit]
  verify commands:  [concrete test/build/typecheck commands — exit pass/fail]
  off-limits:       [exact shell command prefixes for dev servers/watchers — never verification; e.g. npm run dev]
</advisor-think>

After </advisor-think>, output ONLY valid JSON (no markdown fences):
{"subtasks":[{"id":1,"text":"imperative subtask","dependsOn":[],"agentId":1,"agentLabel":"setup"}],"execution":"mixed","agentCount":1,"risks":[]}

Rules for JSON:
- Unique positive integer id per subtask.
- "text" is a clear imperative for a worker agent (one plan line each).
- "dependsOn": prerequisite ids; [] for parallel-ready tasks.
- "agentId" and "agentLabel" on every subtask — group steps by agent.
- Top-level "execution": parallel | sequential | mixed.
- Top-level "agentCount": unique agentId count.
- Top-level "risks": string array (may be empty).
- At least one subtask.

maxAgents constraint: {MAX_AGENTS}

AGENT ASSIGNMENT RULES:
{AGENT_RULES}
- Give each agent a short descriptive label (setup, implementation, verification, etc.).`;

/**
 * <Summary>
 * What it does:
 *   Returns agent assignment rules based on the max_agents constraint.
 *
 * How it does it (step by step):
 *   1. If maxAgents is 1, require all tasks in Agent 1 with sequential dependencies.
 *   2. If maxAgents is 2, require exactly two agents (setup in Agent 1, rest in Agent 2).
 *   3. If maxAgents is "max", encourage using as many agents as needed.
 *   4. If maxAgents is a number, cap to that number and prefer parallelism.
 *   5. Default to assigning by task structure.
 *
 * Parameters:
 *   @param {MaxAgentsParam} maxAgents — The max_agents constraint.
 *
 * Returns:
 *   {string} — Agent assignment rules as a string.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - buildAdvisorThinkInstruction — fills AGENT_RULES placeholder.
 * </Summary>
 */
const agentAssignmentRules = (maxAgents: MaxAgentsParam): string => {
  if (maxAgents === 1) {
    return "- All subtasks agentId 1, dependsOn fully sequential (chain).";
  }
  if (maxAgents === 2) {
    return "- Exactly two agentIds; setup in Agent 1, rest in Agent 2.";
  }
  if (maxAgents === "max") {
    return "- Use as many agents as the task needs (3+ when independent workstreams exist). Prefer parallelism over conservatism.";
  }
  if (typeof maxAgents === "number") {
    return `- Use at most ${maxAgents} agents. Prefer fewer when the task is simple. Only add agents for clearly independent workstreams.`;
  }
  return "- Assign by task structure.";
};

/**
 * <Summary>
 * What it does:
 *   Builds the advisor think instruction by filling in template placeholders.
 *
 * How it does it (step by step):
 *   1. Replace {MAX_AGENTS} placeholder with constraint text.
 *   2. Replace {AGENT_RULES} placeholder with assignment rules.
 *
 * Parameters:
 *   @param {MaxAgentsParam} maxAgents — The max_agents constraint.
 *
 * Returns:
 *   {string} — Complete advisor think instruction.
 *
 * Dependencies:
 *   - ADVISOR_THINK_TEMPLATE — template with placeholders.
 *   - maxAgentsConstraintText — fills MAX_AGENTS placeholder.
 *   - agentAssignmentRules — fills AGENT_RULES placeholder.
 *
 * Dependants:
 *   - Advisor.plan — includes in system prompt for advisor model.
 * </Summary>
 */
export const buildAdvisorThinkInstruction = (
  maxAgents: MaxAgentsParam,
): string =>
  ADVISOR_THINK_TEMPLATE.replace(
    "{MAX_AGENTS}",
    maxAgentsConstraintText(maxAgents),
  ).replace("{AGENT_RULES}", agentAssignmentRules(maxAgents));

/**
 * @deprecated
 * <Summary>
 * What it does:
 *   Default advisor think instruction using default maxAgents (3).
 *
 * How it fits in the system:
 *   Kept for backward compatibility. New code should use
 *   buildAdvisorThinkInstruction(maxAgents) to respect the constraint.
 *
 * Dependencies:
 *   - buildAdvisorThinkInstruction — called with default maxAgents.
 *
 * Dependants:
 *   - None (deprecated).
 * </Summary>
 */
export const ADVISOR_THINK_INSTRUCTION = buildAdvisorThinkInstruction(3);

/**
 * <Summary>
 * What it does:
 *   Extracts the advisor-think block content from model output.
 *
 * How it does it (step by step):
 *   1. Execute regex to find advisor-think block.
 *   2. Return the first capture group (the content between tags).
 *   3. Return null if no match found.
 *
 * Parameters:
 *   @param {string} raw — Raw model output containing think block.
 *
 * Returns:
 *   {string | null} — The think block content, or null if not found.
 *
 * Dependencies:
 *   - ADVISOR_THINK_RE — regex pattern for matching think blocks.
 *
 * Dependants:
 *   - Advisor.plan — extracts reasoning for validation and metadata.
 *   - stripModelThinkingBlocks — removes think block from output.
 * </Summary>
 */
export const extractAdvisorThink = (raw: string): string | null => {
  const regexMatch = ADVISOR_THINK_RE.exec(raw);
  return regexMatch?.[1]?.trim() ?? null;
};

/**
 * <Summary>
 * What it does:
 *   Removes the advisor-think block from model output.
 *
 * How it does it (step by step):
 *   1. Use regex to find and replace the advisor-think block.
 *   2. Return the result with whitespace trimmed.
 *
 * Parameters:
 *   @param {string} raw — Raw model output containing think block.
 *
 * Returns:
 *   {string} — Model output with think block removed.
 *
 * Dependencies:
 *   - ADVISOR_THINK_RE — regex pattern for matching think blocks.
 *
 * Dependants:
 *   - stripModelThinkingBlocks — removes all thinking blocks.
 * </Summary>
 */
export const stripAdvisorThink = (raw: string): string => {
  return raw.replace(ADVISOR_THINK_RE, "").trim();
};

/**
 * <Summary>
 * What it does:
 *   Type definition for verification gap analysis results.
 *
 * How it fits in the system:
 *   Used to check if the advisor's VERIFY PLAN section identified gaps
 *   in the plan (e.g., missing requirements or missing steps). This validation
 *   ensures the advisor has properly verified the plan before generating JSON.
 *
 * Fields:
 *   hasGaps — Whether gaps were detected in the verification section.
 *   missingSummary — Human-readable description of what's missing.
 *
 * Dependants:
 *   - parseVerifyGaps — returns this type to report verification status.
 *   - Advisor.plan — uses to validate plan completeness before acceptance.
 * </Summary>
 */
export type VerifyGaps = {
  /** Whether gaps were detected in the verification section. */
  hasGaps: boolean;

  /** Human-readable description of what's missing. */
  missingSummary: string;
};

/**
 * <Summary>
 * What it does:
 *   Regular expression pattern for "no gap" answers in verification.
 *
 * How it fits in the system:
 *   Anchored at the start so a genuine gap such as "no error handling
 *   yet" is still flagged, while "No.", "None;", "N/A", "Nothing missing", or
 *   "No, all covered." are correctly treated as no-gap answers.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - parseVerifyGaps — determines if missing steps are real gaps or negations.
 * </Summary>
 */
const NO_GAP_ANSWER_RE =
  /^(?:none|no|n\/?a|nothing|nope|all (?:covered|good|done)|covered)\b/i;

/**
 * <Summary>
 * What it does:
 *   Parses the VERIFY PLAN section to detect gaps in verification reasoning.
 *
 * How it does it (step by step):
 *   1. Extract the requirement covered answer (yes/no).
 *   2. Extract the steps missing answer (if any).
 *   3. Normalize and check if missing steps represent a real gap.
 *   4. Build gap summary string if gaps exist.
 *
 * Parameters:
 *   @param {string} thinkText — The advisor-think block content to parse.
 *
 * Returns:
 *   {VerifyGaps} — Object indicating whether gaps exist and what's missing.
 *
 * Dependencies:
 *   - NO_GAP_ANSWER_RE — distinguishes real gaps from negations.
 *
 * Dependants:
 *   - Advisor.plan — validates plan completeness.
 * </Summary>
 */
export const parseVerifyGaps = (thinkText: string): VerifyGaps => {
  // Step 1: Extract the requirement covered answer (yes/no)
  const requirementMatch = /requirement covered\?\s*:?\s*(yes|no)/i.exec(
    thinkText,
  );
  const requirementNotCovered = requirementMatch?.[1]?.toLowerCase() === "no";

  // Step 2: Extract the steps missing answer (if any)
  const missingMatch = /steps missing\?\s*:?\s*([^\n]+)/i.exec(thinkText);
  const missingRaw = (missingMatch?.[1] ?? "").trim();
  const missingNormalized = missingRaw.replace(/[.!,;:]+$/g, "").trim();
  const hasMissingList =
    missingNormalized.length > 0 && !NO_GAP_ANSWER_RE.test(missingNormalized);

  // Step 3: Build gap summary string if gaps exist
  const gapParts: string[] = [];
  if (requirementNotCovered) {
    gapParts.push("requirement not fully covered");
  }
  if (hasMissingList) {
    gapParts.push(`steps missing: ${missingRaw}`);
  }

  // Step 4: Return gap detection results
  return {
    hasGaps: requirementNotCovered || hasMissingList,
    missingSummary: gapParts.join("; "),
  };
};

/**
 * <Summary>
 * What it does:
 *   Checks if a line is a placeholder (empty, "none", or in brackets).
 *
 * How it does it (step by step):
 *   1. Trim the line.
 *   2. Check if empty or matches placeholder patterns.
 *
 * Parameters:
 *   @param {string} line — The line to check.
 *
 * Returns:
 *   {boolean} — True if the line is a placeholder.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - parseCommandLines — filters out placeholder lines.
 * </Summary>
 */
const isPlaceholderLine = (line: string): boolean => {
  const trimmedLine = line.trim();
  return (
    trimmedLine.length === 0 ||
    /^none$/i.test(trimmedLine) ||
    /^\[.*\]$/.test(trimmedLine)
  );
};

/**
 * <Summary>
 * What it does:
 *   Strips command wrapping characters from a line (bullets, numbers, backticks).
 *
 * How it does it (step by step):
 *   1. Trim the line.
 *   2. Remove bullet points (-, •, *).
 *   3. Remove numbered prefixes (1., 2., etc.).
 *   4. Remove backtick wrapping.
 *   5. Trim again.
 *
 * Parameters:
 *   @param {string} line — The line to strip.
 *
 * Returns:
 *   {string} — The line with wrapping removed.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - parseCommandLines — normalizes command lines for parsing.
 * </Summary>
 */
const stripCommandWrapping = (line: string): string =>
  line
    .trim()
    .replace(/^[-•*]\s*/, "") // Remove bullet points
    .replace(/^\d+\.\s*/, "") // Remove numbered prefixes
    .replace(/^`+|`+$/g, "") // Remove backtick wrapping
    .trim();

/**
 * <Summary>
 * What it does:
 *   Parses command lines from a section of the COMMAND PLAN.
 *
 * How it does it (step by step):
 *   1. Split the section by newlines.
 *   2. Strip wrapping from each line.
 *   3. Filter out placeholder lines.
 *   4. Return the list of valid commands.
 *
 * Parameters:
 *   @param {string} section — The section text containing commands.
 *
 * Returns:
 *   {string[]} — Array of command strings.
 *
 * Dependencies:
 *   - stripCommandWrapping — normalizes command lines.
 *   - isPlaceholderLine — filters placeholders.
 *
 * Dependants:
 *   - parseCommandPlan — extracts command lists from sections.
 * </Summary>
 */
const parseCommandLines = (section: string): string[] => {
  const commands: string[] = [];
  for (const line of section.split("\n")) {
    const cleanedLine = stripCommandWrapping(line);
    if (!isPlaceholderLine(cleanedLine)) {
      commands.push(cleanedLine);
    }
  }
  return commands;
};

/**
 * <Summary>
 * What it does:
 *   Parses the COMMAND PLAN section to extract setup, verify, and run-project commands.
 *
 * How it does it (step by step):
 *   1. Extract the entire COMMAND PLAN block.
 *   2. Extract setup commands section.
 *   3. Extract verify commands section.
 *   4. Extract off-limits (run-project) commands section.
 *   5. Parse commands from each section.
 *
 * Parameters:
 *   @param {string} thinkText — The advisor-think block content.
 *
 * Returns:
 *   {CommandPlan} — Object containing setup, verify, and run-project command arrays.
 *
 * Dependencies:
 *   - parseCommandLines — parses individual command sections.
 *
 * Dependants:
 *   - Advisor.plan — extracts command classification plan.
 * </Summary>
 */
export const parseCommandPlan = (thinkText: string): CommandPlan => {
  // Step 1: Extract the entire COMMAND PLAN block
  const blockMatch = /COMMAND PLAN:\s*([\s\S]*?)$/i.exec(thinkText);
  const blockText = blockMatch?.[1] ?? "";

  // Step 2: Extract setup commands section
  const setupMatch =
    /setup commands:\s*([\s\S]*?)(?=verify commands:|off-limits:|$)/i.exec(
      blockText,
    );

  // Step 3: Extract verify commands section
  const verifyMatch =
    /verify commands:\s*([\s\S]*?)(?=off-limits:|setup commands:|$)/i.exec(
      blockText,
    );

  // Step 4: Extract off-limits (run-project) commands section
  const offLimitsMatch =
    /off-limits(?:\s*\(run-project\))?:\s*([\s\S]*?)$/i.exec(blockText);

  // Step 5: Parse commands from each section
  return {
    setupCommands: parseCommandLines(setupMatch?.[1] ?? ""),
    verifyCommands: parseCommandLines(verifyMatch?.[1] ?? ""),
    runProjectCommands: parseCommandLines(offLimitsMatch?.[1] ?? ""),
  };
};

/**
 * <Summary>
 * What it does:
 *   Type definition for command plan gap analysis results.
 *
 * How it fits in the system:
 *   Used to check if the advisor's COMMAND PLAN section is missing required
 *   categories (verify commands or off-limits commands).
 *
 * Fields:
 *   hasGaps — Whether command plan is missing required categories.
 *   missingSummary — Human-readable description of what's missing.
 *
 * Dependants:
 *   - parseCommandPlanGaps — returns this type to report command plan status.
 *   - Advisor.plan — validates command plan completeness.
 * </Summary>
 */
export type CommandPlanGaps = {
  /** Whether command plan is missing required categories. */
  hasGaps: boolean;

  /** Human-readable description of what's missing. */
  missingSummary: string;
};

/**
 * <Summary>
 * What it does:
 *   Parses the COMMAND PLAN section and checks for missing required categories.
 *
 * How it does it (step by step):
 *   1. Parse the command plan.
 *   2. Check if verify commands are missing.
 *   3. Check if off-limits commands are missing.
 *   4. Build gap summary string if gaps exist.
 *
 * Parameters:
 *   @param {string} thinkText — The advisor-think block content.
 *
 * Returns:
 *   {CommandPlanGaps} — Object indicating gaps and missing categories.
 *
 * Dependencies:
 *   - parseCommandPlan — extracts command plan for validation.
 *
 * Dependants:
 *   - Advisor.plan — validates command plan completeness.
 * </Summary>
 */
export const parseCommandPlanGaps = (thinkText: string): CommandPlanGaps => {
  // Step 1: Parse the command plan
  const commandPlan = parseCommandPlan(thinkText);

  // Step 2-3: Check for missing required categories
  const gapParts: string[] = [];
  if (commandPlan.verifyCommands.length === 0) {
    gapParts.push("verify commands");
  }
  if (commandPlan.runProjectCommands.length === 0) {
    gapParts.push("off-limits commands");
  }

  // Step 4: Build gap summary and return results
  return {
    hasGaps: gapParts.length > 0,
    missingSummary: gapParts.join(", "),
  };
};

/**
 * <Summary>
 * What it does:
 *   Parses the risks section from the advisor-think block.
 *
 * How it does it (step by step):
 *   1. Extract the risks section using regex.
 *   2. Split by newlines.
 *   3. Remove bullet points from each line.
 *   4. Filter out empty lines and "none" placeholders.
 *   5. Return the list of risk strings.
 *
 * Parameters:
 *   @param {string} thinkText — The advisor-think block content.
 *
 * Returns:
 *   {string[]} — Array of risk strings (may be empty).
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - Advisor.plan — extracts risks for plan metadata.
 * </Summary>
 */
export const parseRisks = (thinkText: string): string[] => {
  const risks: string[] = [];
  // Step 1: Extract the risks section using regex
  const blockMatch =
    /risks\?\s*:?\s*([\s\S]*?)(?:\n\s*\n|REVISED PLAN|COMMAND PLAN|$)/i.exec(
      thinkText,
    );
  const sectionText = blockMatch?.[1] ?? "";

  // Step 2-4: Split by newlines, remove bullets, filter placeholders
  for (const line of sectionText.split("\n")) {
    const cleanedRisk = line.trim().replace(/^[-•*]\s*/, "");
    if (cleanedRisk.length > 0 && !/^none$/i.test(cleanedRisk)) {
      risks.push(cleanedRisk);
    }
  }

  // Step 5: Return the list of risk strings
  return risks;
};

/**
 * <Summary>
 * What it does:
 *   Regular expression to match numbered plan steps (e.g., "1. step description").
 *
 * How it fits in the system:
 *   Used to extract individual steps from the DRAFT PLAN or REVISED PLAN sections.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - extractNumberedSteps — matches plan step lines.
 * </Summary>
 */
const PLAN_STEP_RE = /^\s*\d+\.\s+(.+)$/;

/**
 * <Summary>
 * What it does:
 *   Regular expression to detect the end of a plan section.
 *
 * How it fits in the system:
 *   Used to determine where one plan section ends and another begins.
 *   Matches section headers like VERIFY PLAN, REVISED PLAN, etc.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - extractPlanSection — finds the end of a plan section.
 * </Summary>
 */
const PLAN_SECTION_END =
  /\n\s*(?:(?:VERIFY|REVISED|COMMAND)\s+PLAN|UNDERSTAND|CONTEXT FROM SESSION):/i;

/**
 * <Summary>
 * What it does:
 *   Checks if plan text is a placeholder (no changes, none, N/A, etc.).
 *
 * How it does it (step by step):
 *   1. Trim the text.
 *   2. Check for placeholder patterns.
 *
 * Parameters:
 *   @param {string} text — The plan text to check.
 *
 * Returns:
 *   {boolean} — True if the text is a placeholder.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - extractNumberedSteps — filters out placeholder steps.
 * </Summary>
 */
const isPlanPlaceholder = (text: string): boolean => {
  const trimmedText = text.trim();
  return (
    trimmedText.length === 0 ||
    /^\(no changes needed/i.test(trimmedText) ||
    /^\(none\)/i.test(trimmedText) ||
    /^none$/i.test(trimmedText) ||
    /^n\/a$/i.test(trimmedText)
  );
};

/**
 * <Summary>
 * What it does:
 *   Extracts a plan section (DRAFT PLAN or REVISED PLAN) from the think block.
 *
 * How it does it (step by step):
 *   1. Build regex to match the section header.
 *   2. Find the header in the think text.
 *   3. Extract content from header to the next section.
 *   4. Return the section content.
 *
 * Parameters:
 *   @param {string} thinkText — The advisor-think block content.
 *   @param {string} header — The section header to extract (e.g., "DRAFT PLAN").
 *
 * Returns:
 *   {string} — The section content, or empty string if not found.
 *
 * Dependencies:
 *   - PLAN_SECTION_END — detects section boundaries.
 *
 * Dependants:
 *   - parsePlanLines — extracts DRAFT PLAN or REVISED PLAN content.
 * </Summary>
 */
const extractPlanSection = (thinkText: string, header: string): string => {
  // Step 1: Build regex to match the section header (escape special characters)
  const headerRegex = new RegExp(
    `^\\s*${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*\\([^)]*\\))?:?\\s*$`,
    "im",
  );

  // Step 2: Find the header in the think text
  const headerMatch = headerRegex.exec(thinkText);
  if (!headerMatch) {
    return "";
  }

  // Step 3: Extract content from header to the next section
  const startIndex = headerMatch.index + headerMatch[0].length;
  const remainingText = thinkText.slice(startIndex);
  const endMatch = PLAN_SECTION_END.exec(remainingText);

  // Step 4: Return the section content
  return endMatch ? remainingText.slice(0, endMatch.index) : remainingText;
};

/**
 * <Summary>
 * What it does:
 *   Extracts numbered plan steps from a plan section text.
 *
 * How it does it (step by step):
 *   1. Split the section by newlines.
 *   2. Match each line against the step pattern.
 *   3. Extract the step text from matches.
 *   4. Filter out placeholder steps.
 *   5. Return the list of step strings.
 *
 * Parameters:
 *   @param {string} section — The plan section text to parse.
 *
 * Returns:
 *   {string[]} — Array of plan step strings.
 *
 * Dependencies:
 *   - PLAN_STEP_RE — matches numbered step lines.
 *   - isPlanPlaceholder — filters out placeholder steps.
 *
 * Dependants:
 *   - parsePlanLines — extracts steps from DRAFT or REVISED PLAN.
 * </Summary>
 */
const extractNumberedSteps = (section: string): string[] => {
  const steps: string[] = [];
  // Step 1-2: Split by newlines and match each line
  for (const line of section.split("\n")) {
    const stepMatch = PLAN_STEP_RE.exec(line);
    if (!stepMatch) {
      continue;
    }

    // Step 3: Extract the step text from matches
    const stepText = stepMatch[1].trim();

    // Step 4: Filter out placeholder steps
    if (!isPlanPlaceholder(stepText)) {
      steps.push(stepText);
    }
  }

  // Step 5: Return the list of step strings
  return steps;
};

/**
 * <Summary>
 * What it does:
 *   Pulls numbered plan steps from REVISED PLAN, or DRAFT PLAN when revised has none.
 *
 * How it does it (step by step):
 *   1. Extract steps from REVISED PLAN section.
 *   2. If REVISED PLAN has steps, return them.
 *   3. Otherwise, extract and return steps from DRAFT PLAN section.
 *
 * Parameters:
 *   @param {string} thinkText — The advisor-think block content.
 *
 * Returns:
 *   {string[]} — Array of plan step strings.
 *
 * Dependencies:
 *   - extractPlanSection — extracts plan section content.
 *   - extractNumberedSteps — parses numbered steps from content.
 *
 * Dependants:
 *   - buildPlanFromLines — converts plan lines to PlannedSubtask array.
 * </Summary>
 */
export const parsePlanLines = (thinkText: string): string[] => {
  // Step 1: Extract steps from REVISED PLAN section
  const revisedSteps = extractNumberedSteps(
    extractPlanSection(thinkText, "REVISED PLAN"),
  );

  // Step 2: If REVISED PLAN has steps, return them
  if (revisedSteps.length > 0) {
    return revisedSteps;
  }

  // Step 3: Otherwise, extract and return steps from DRAFT PLAN section
  return extractNumberedSteps(extractPlanSection(thinkText, "DRAFT PLAN"));
};

/**
 * <Summary>
 * What it does:
 *   Converts plan step lines into PlannedSubtask objects with agent assignments.
 *
 * How it does it (step by step):
 *   1. Trim and filter lines.
 *   2. If maxAgents is 1, assign all to agent 1 with sequential dependencies.
 *   3. Calculate agent count and tasks per agent for other cases.
 *   4. Assign agent IDs based on index and task distribution.
 *   5. Assign agent labels from predefined list.
 *   6. Set dependencies to previous task (sequential by default).
 *
 * Parameters:
 *   @param {string[]} lines — Array of plan step strings.
 *   @param {MaxAgentsParam} maxAgents — The max_agents constraint.
 *
 * Returns:
 *   {PlannedSubtask[]} — Array of PlannedSubtask objects.
 *
 * Dependencies:
 *   - MaxAgentsParam — type for constraint.
 *
 * Dependants:
 *   - Advisor.plan — builds plan from think block when JSON parsing fails.
 *   - applyPlanReview — builds plan from user-edited steps.
 * </Summary>
 */
export const buildPlanFromLines = (
  lines: string[],
  maxAgents: MaxAgentsParam = 3,
): PlannedSubtask[] => {
  // Step 1: Trim and filter lines
  const trimmedLines = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Step 2: If maxAgents is 1, assign all to agent 1 with sequential dependencies
  if (maxAgents === 1) {
    return trimmedLines.map((stepText, index) => ({
      id: index + 1,
      text: stepText,
      dependsOn: index === 0 ? [] : [index],
      agentId: 1,
      agentLabel: "all tasks",
    }));
  }

  // Step 3: Calculate agent count and tasks per agent for other cases
  const calculatedAgentCount =
    maxAgents === 2
      ? 2
      : maxAgents === "max"
        ? Math.min(trimmedLines.length, 4)
        : Math.min(trimmedLines.length, maxAgents);
  const tasksPerAgent = Math.max(
    1,
    Math.ceil(trimmedLines.length / calculatedAgentCount),
  );

  // Step 4-6: Assign agent IDs, labels, and dependencies
  const subtasks = trimmedLines.map((stepText, index) => {
    const assignedAgentId = Math.min(
      Math.floor(index / tasksPerAgent) + 1,
      calculatedAgentCount,
    );
    const agentLabels = ["setup", "implementation", "verification", "tasks"];
    return {
      id: index + 1,
      text: stepText,
      dependsOn: index === 0 ? [] : [index],
      agentId: assignedAgentId,
      agentLabel: agentLabels[assignedAgentId - 1] ?? "tasks",
    };
  });

  return subtasks;
};

/**
 * <Summary>
 * What it does:
 *   Applies user review changes to the advisor plan.
 *
 * How it does it (step by step):
 *   1. If decision is "skip", return plan unchanged.
 *   2. If decision is "edit" with steps, rebuild plan from edited steps.
 *   3. Recalculate execution mode and agent count.
 *   4. Preserve original risks and command plan.
 *   5. If decision is "implement", return plan unchanged.
 *
 * Parameters:
 *   @param {AdvisorPlan} plan — The original advisor plan.
 *   @param {PlanReviewResponse} review — The user's review response.
 *   @param {MaxAgentsParam} maxAgents — The max_agents constraint.
 *
 * Returns:
 *   {AdvisorPlan} — The updated plan (original or edited).
 *
 * Dependencies:
 *   - buildPlanFromLines — builds subtasks from edited step lines.
 *   - deriveExecution — calculates execution mode from subtasks.
 *
 * Dependants:
 *   - Advisor.plan — applies user review before returning final plan.
 * </Summary>
 */
export const applyPlanReview = (
  plan: AdvisorPlan,
  review: PlanReviewResponse,
  maxAgents: MaxAgentsParam = 3,
): AdvisorPlan => {
  // Step 1: If decision is "skip", return plan unchanged
  if (review.decision === "skip") {
    return plan;
  }

  // Step 2-4: If decision is "edit" with steps, rebuild plan from edited steps
  if (review.decision === "edit" && review.steps && review.steps.length > 0) {
    const editedSubtasks = buildPlanFromLines(review.steps, maxAgents);
    return {
      // Preserve original risks
      risks: plan.risks,
      // Use edited subtasks
      subtasks: editedSubtasks,
      // Preserve original command plan
      commandPlan: plan.commandPlan,
      // Step 3: Recalculate execution mode from new subtasks
      execution: deriveExecution(editedSubtasks),
      // Step 3: Recalculate agent count from new subtasks
      agentCount: new Set(editedSubtasks.map((subtask) => subtask.agentId))
        .size,
    };
  }

  // Step 5: If decision is "implement", return plan unchanged
  return plan;
};
