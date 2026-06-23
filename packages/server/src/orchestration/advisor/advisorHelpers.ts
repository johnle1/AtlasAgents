/**
 * <Summary>
 * What it does:
 *   Helper functions for advisor including JSON extraction, plan normalization,
 *   and agent field defaults.
 *
 * How it fits in the system:
 *   Provides utility functions for parsing and validating advisor plans.
 *   Handles the complex task of extracting JSON from AI model output that may
 *   contain prose, markdown fences, or other formatting. Normalizes plan structure
 *   and validates DAG constraints.
 * </Summary>
 */

import { ValidationError } from "../../errors/index.js";
import {
  buildAdvisorThinkInstruction,
  extractAdvisorThink,
  parseCommandPlan,
  parseCommandPlanGaps,
  parsePlanLines,
  parseRisks,
  parseVerifyGaps,
  stripAdvisorThink,
} from "./advisorThink.js";
import type { MaxAgentsParam } from "../maxAgents.js";
import {
  applyMaxAgentsConstraint,
  deriveExecution,
  validateNoCycles,
} from "../planHelpers.js";
import type { AdvisorPlan, PlannedSubtask } from "../types.js";
import { emptyCommandPlan } from "../types.js";

/**
 * <Summary>
 * What it does:
 *   Strips optional markdown fences and extracts the outermost JSON object substring.
 *
 * How it does it (step by step):
 *   1. Strip advisor-think block from the raw output.
 *   2. Remove any other thinking/reasoning blocks.
 *   3. Trim the result.
 *
 * Parameters:
 *   @param raw - Raw model output possibly containing prose or fences.
 *
 * Returns:
 *   @returns Candidate JSON object string for JSON.parse.
 * </Summary>
 */
export const stripModelThinkingBlocks = (rawOutput: string): string => {
  // Step 1: Strip advisor-think block from the raw output
  let cleanedText = stripAdvisorThink(rawOutput);

  // Step 2: Remove any other thinking/reasoning blocks
  // Some models use <think> or <redacted_reasoning> tags
  cleanedText = cleanedText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  cleanedText = cleanedText
    .replace(/<redacted_reasoning>[\s\S]*?<\/redacted_reasoning>/gi, "")
    .trim();

  // Step 3: Trim the result
  return cleanedText;
};

/**
 * <Summary>
 * What it does:
 *   Extracts the outermost JSON object string from raw model output.
 *
 * How it does it (step by step):
 *   1. Strip all thinking blocks from the raw output.
 *   2. Try to extract JSON from markdown code fences (```json or ```).
 *   3. Try to extract JSON by finding "subtasks" key and surrounding braces.
 *   4. Fallback to extracting from first "{" to last "}" in the string.
 *   5. Final fallback: return the entire stripped string.
 *
 * Parameters:
 *   @param raw - Raw model output possibly containing prose or fences.
 *
 * Returns:
 *   @returns Candidate JSON object string for JSON.parse.
 * </Summary>
 */
export const extractJsonObject = (rawOutput: string): string => {
  // Step 1: Strip all thinking blocks from the raw output
  const cleanedText = stripModelThinkingBlocks(rawOutput);

  // Step 2: Try to extract JSON from markdown code fences (```json or ```)
  // Many LLMs wrap JSON in markdown code blocks for formatting
  const codeFenceMatch = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/i.exec(
    cleanedText,
  );
  if (codeFenceMatch) {
    return codeFenceMatch[1].trim();
  }

  // Step 2a: Anchor on plan shape (Qwen and others may emit prose/braces before subtasks)
  const subtasksKey = '"subtasks"';
  const subtasksKeyIndex = cleanedText.indexOf(subtasksKey);
  if (subtasksKeyIndex !== -1) {
    // Find the opening brace before the subtasks key
    const openBraceIndex = cleanedText.lastIndexOf("{", subtasksKeyIndex);
    // Use brace counting to find the matching closing brace (handles nested objects)
    let braceCount = 0;
    let closeBraceIndex = -1;
    for (let i = openBraceIndex; i < cleanedText.length; i++) {
      if (cleanedText[i] === "{") braceCount++;
      if (cleanedText[i] === "}") braceCount--;
      if (braceCount === 0) {
        closeBraceIndex = i;
        break;
      }
    }
    if (
      openBraceIndex !== -1 &&
      closeBraceIndex !== -1 &&
      closeBraceIndex > openBraceIndex
    ) {
      return cleanedText.slice(openBraceIndex, closeBraceIndex + 1);
    }
  }

  // Step 2b: Otherwise take the substring from first "{" to last "}" (ignores leading prose)
  const openBraceIndex = cleanedText.indexOf("{");
  const closeBraceIndex = cleanedText.lastIndexOf("}");
  if (
    openBraceIndex !== -1 &&
    closeBraceIndex !== -1 &&
    closeBraceIndex > openBraceIndex
  ) {
    return cleanedText.slice(openBraceIndex, closeBraceIndex + 1);
  }

  // Step 3: Fallback — hope the whole string is pure JSON
  return cleanedText;
};

/**
 * <Summary>
 * What it does:
 *   Validates and normalizes agent assignment fields (agentId and agentLabel) for subtasks.
 *
 * How it does it (step by step):
 *   1. Calculate how many tasks per agent (roughly 1/3 of total, minimum 1).
 *   2. For each subtask, assign a default agentId if missing or invalid.
 *   3. For each subtask, assign a default agentLabel if missing or invalid.
 *
 * Parameters:
 *   @param subtasks - Array of subtasks to normalize.
 *
 * Returns:
 *   {PlannedSubtask[]} — Subtasks with normalized agent fields.
 * </Summary>
 */
export const defaultAgentFields = (
  subtasks: PlannedSubtask[],
): PlannedSubtask[] => {
  // Step 1: Calculate how many tasks per agent (roughly 1/3 of total, minimum 1)
  // Note: This uses a default of 3 agents before maxAgents constraint is applied
  const tasksPerAgent = Math.max(1, Math.ceil(subtasks.length / 3));

  // Step 2-3: For each subtask, normalize agentId and agentLabel
  return subtasks.map((subtask, index) => ({
    ...subtask,
    // Normalize agentId: use existing if valid, otherwise calculate based on index
    agentId:
      typeof subtask.agentId === "number" && subtask.agentId > 0
        ? subtask.agentId
        : Math.min(Math.floor(index / tasksPerAgent) + 1, 3),
    // Normalize agentLabel: use existing if valid, otherwise use default
    agentLabel:
      typeof subtask.agentLabel === "string" &&
      subtask.agentLabel.trim().length > 0
        ? subtask.agentLabel.trim()
        : "tasks",
  }));
};

/**
 * <Summary>
 * What it does:
 *   Validates parsed JSON and returns a typed AdvisorPlan with normalized structure.
 *
 * How it does it (step by step):
 *   1. Validate top-level structure (must be object with subtasks array).
 *   2. Ensure at least one subtask exists.
 *   3. Validate each subtask element (shape, types, uniqueness, non-empty text).
 *   4. Validate dependency references (all deps must exist, no self-deps).
 *   5. Validate no cycles in the dependency graph.
 *   6. Sort subtasks by ID for stable logging.
 *   7. Normalize and validate risks array.
 *   8. Normalize and validate execution field.
 *   9. Apply default agent fields and max agents constraint.
 *
 * Parameters:
 *   @param parsed - Result of JSON.parse (untrusted).
 *   @param maxAgents - The max_agents constraint to apply.
 *
 * Returns:
 *   @returns Normalized plan with sorted subtasks and validated structure.
 *
 * Throws:
 *   @throws {ValidationError} — When shape, ids, or dependency references are invalid.
 * </Summary>
 */
export const normaliseAdvisorPlan = (
  parsedJson: unknown,
  maxAgents: MaxAgentsParam,
): AdvisorPlan => {
  // Step 1: Top-level must be an object with a "subtasks" array (anything else is unusable)
  if (
    typeof parsedJson !== "object" ||
    parsedJson === null ||
    !("subtasks" in parsedJson) ||
    !Array.isArray((parsedJson as { subtasks: unknown }).subtasks)
  ) {
    throw new ValidationError("Advisor returned invalid plan JSON");
  }

  const rawSubtaskList = (parsedJson as { subtasks: unknown[] }).subtasks;

  // Step 2: Orchestrator needs at least one subtask to run
  if (rawSubtaskList.length === 0) {
    throw new ValidationError("Advisor returned invalid plan JSON");
  }

  const idSet = new Set<number>();
  const validatedSubtasks: PlannedSubtask[] = [];

  // Step 3: Validate each array element — shape, types, uniqueness, non-empty text
  for (const subtaskItem of rawSubtaskList) {
    if (typeof subtaskItem !== "object" || subtaskItem === null) {
      throw new ValidationError("Advisor returned invalid plan JSON");
    }

    const itemObject = subtaskItem as Record<string, unknown>;

    // id must be a positive integer (floats / strings / zero rejected via NaN)
    const subtaskId =
      typeof itemObject.id === "number" &&
      Number.isInteger(itemObject.id) &&
      itemObject.id > 0
        ? itemObject.id
        : NaN;

    const subtaskText =
      typeof itemObject.text === "string" ? itemObject.text.trim() : "";

    // dependsOn defaults to [] if missing or wrong type; entries must all be integers
    const dependencyList = Array.isArray(itemObject.dependsOn)
      ? itemObject.dependsOn.map((dependency) =>
          typeof dependency === "number" && Number.isInteger(dependency)
            ? dependency
            : NaN,
        )
      : [];

    if (
      !Number.isFinite(subtaskId) ||
      idSet.has(subtaskId) ||
      subtaskText.length === 0
    ) {
      throw new ValidationError("Advisor returned invalid plan JSON");
    }

    if (dependencyList.some((dependencyId) => !Number.isFinite(dependencyId))) {
      throw new ValidationError("Advisor returned invalid plan JSON");
    }

    const agentId =
      typeof itemObject.agentId === "number" &&
      Number.isInteger(itemObject.agentId) &&
      itemObject.agentId > 0
        ? itemObject.agentId
        : 1;

    const agentLabel =
      typeof itemObject.agentLabel === "string" &&
      itemObject.agentLabel.trim().length > 0
        ? itemObject.agentLabel.trim()
        : "tasks";

    idSet.add(subtaskId);
    validatedSubtasks.push({
      id: subtaskId,
      text: subtaskText,
      dependsOn: dependencyList,
      agentId,
      agentLabel,
    });
  }

  // Step 4: Every dependency id must exist on some subtask, and must not point at itself
  for (const subtask of validatedSubtasks) {
    for (const dependencyId of subtask.dependsOn) {
      if (!idSet.has(dependencyId)) {
        throw new ValidationError("Advisor returned invalid plan JSON");
      }
      if (dependencyId === subtask.id) {
        throw new ValidationError("Advisor returned invalid plan JSON");
      }
    }
  }

  // Check for circular dependencies in the DAG
  if (!validateNoCycles(validatedSubtasks)) {
    throw new ValidationError("Advisor returned invalid plan JSON");
  }

  // Step 5: Stable order for logging / combine — execution order still comes from dependsOn + waves
  validatedSubtasks.sort((taskA, taskB) => taskA.id - taskB.id);

  const parsedObject = parsedJson as Record<string, unknown>;

  // Normalize risks array (filter to non-empty strings)
  const risks = Array.isArray(parsedObject.risks)
    ? parsedObject.risks.filter(
        (riskItem): riskItem is string =>
          typeof riskItem === "string" && riskItem.trim().length > 0,
      )
    : [];

  // Normalize execution field (validate or derive)
  let execution: AdvisorPlan["execution"] = "sequential";
  const rawExecution = (parsedJson as { execution?: unknown }).execution;
  if (
    rawExecution === "parallel" ||
    rawExecution === "sequential" ||
    rawExecution === "mixed"
  ) {
    execution = rawExecution;
  } else {
    execution = deriveExecution(validatedSubtasks);
  }

  // Apply default agent fields and calculate agent count
  const normalizedWithAgents = defaultAgentFields(validatedSubtasks);
  const agentCount = new Set(
    normalizedWithAgents.map((subtask) => subtask.agentId),
  ).size;

  // Step 9: Apply max agents constraint
  return applyMaxAgentsConstraint(
    {
      subtasks: normalizedWithAgents,
      risks,
      commandPlan: emptyCommandPlan(),
      execution,
      agentCount,
    },
    maxAgents,
  );
};

/**
 * Re-export functions from advisorThink.js that are used in advisor.ts.
 * This provides a single import point for advisorThink functions used by the Advisor class.
 */
export {
  buildAdvisorThinkInstruction,
  extractAdvisorThink,
  parseCommandPlan,
  parseCommandPlanGaps,
  parsePlanLines,
  parseRisks,
  parseVerifyGaps,
};
