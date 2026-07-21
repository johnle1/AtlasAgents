/**
 * Helper utilities for agent plan parsing, normalization, and validation.
 *
 * @remarks
 * Provides functions for:
 * - Extracting JSON from model output (handles prose, markdown, thinking blocks)
 * - Normalizing plan shape variants (top-level array, property aliases, type coercion)
 * - Validating plan structure (DAG constraints, field types, uniqueness)
 * - Assigning default agent fields and labels
 * - Building revised task text for plan iterations
 * - Detecting codebase stack hints from context
 *
 * These utilities are used by Agent.plan() to process and validate raw model output
 * into executable SubagentPlan structures.
 */

import { ValidationError } from "../../errors/index.js";
import {
  buildAgentThinkInstruction,
  extractAgentThink,
  parseCommandPlan,
  parseCommandPlanGaps,
  parseParallelismGaps,
  parsePlanLines,
  parseRisks,
  parseVerifyGaps,
  stripAgentThink,
} from "./agentThink.js";
import type { MaxSubagentsParam } from "../maxSubagents.js";
import {
  applyMaxAgentsConstraint,
  deriveExecution,
  validateNoCycles,
} from "../planHelpers.js";
import type { SubagentPlan, PlannedSubtask } from "../types.js";
import { emptyCommandPlan } from "../types.js";

/**
 * Removes thinking blocks and reasoning tags from raw model output.
 *
 * @remarks
 * Strips `<agent-think>`, `<think>`, and `<redacted_reasoning>` blocks to prepare
 * the output for JSON extraction. Does not remove markdown code fences or prose.
 *
 * @param rawOutput - Raw model output containing potential thinking blocks.
 * @returns Cleaned output with thinking blocks removed.
 *
 * @example
 * ```ts
 * const raw = "<agent-think>...</agent-think>Some JSON here";
 * const cleaned = stripModelThinkingBlocks(raw);
 * Returns "Some JSON here"
 * ```
 */
export const stripModelThinkingBlocks = (rawOutput: string): string => {
  let cleanedText = stripAgentThink(rawOutput);
  cleanedText = cleanedText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  cleanedText = cleanedText
    .replace(/<redacted_reasoning>[\s\S]*?<\/redacted_reasoning>/gi, "")
    .trim();
  return cleanedText;
};

/**
 * Extracts the outermost JSON object from raw model output.
 *
 * @remarks
 * Attempts multiple extraction strategies in order of preference:
 * 1. Markdown code fence (```json ... ```)
 * 2. Search for "subtasks" key with brace matching (handles leading prose)
 * 3. Fallback to first "{" to last "}" (works for most shapes)
 * 4. Return entire cleaned string (hope it's pure JSON)
 *
 * This robust extraction handles variations in how different models format JSON output.
 *
 * @param rawOutput - Raw model output (may contain prose, fences, thinking blocks).
 * @returns Candidate JSON string ready for `JSON.parse()` (may fail parsing).
 *
 * @example
 * ```ts
 * const raw = "Here's the plan:\n```json\n{\"subtasks\": [...]}\n```";
 * const json = extractJsonObject(raw);
 * const parsed = JSON.parse(json); // Success
 * ```
 */
export const extractJsonObject = (rawOutput: string): string => {
  const cleanedText = stripModelThinkingBlocks(rawOutput);

  // Step 2: Try to extract JSON from markdown code fences (```json or ```)
  // Many LLMs wrap JSON in markdown code blocks for formatting
  const codeFenceMatch = /```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/i.exec(
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

const REDACTED_THINKING_RE = /<think>([\s\S]*?)<\/think>/i;

/**
 * Repairs common JSON issues emitted by LLMs.
 *
 * @remarks
 * Fixes:
 * - Smart/curly quotes (U+201C, U+201D \u2192 `"`)
 * - Smart apostrophes (U+2018, U+2019 \u2192 `'`)
 * - Trailing commas before closing braces/brackets
 * - Line comments (`//`)
 *
 * Does not attempt deep structural repairs.
 */
const repairJsonString = (candidate: string): string =>
  candidate
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Attempts to extract and parse JSON from raw model output.
 *
 * @remarks
 * Tries two parse strategies:
 * 1. Direct `JSON.parse()` on extracted JSON
 * 2. Repair common issues and retry
 *
 * Returns `null` (not throwing) on persistent parse failures, allowing
 * callers to try fallback strategies (e.g., build plan from think block).
 *
 * @param raw - Raw model output containing JSON.
 * @returns Parsed JSON object/array, or `null` if parsing failed.
 *
 * @example
 * ```ts
 * const parsed = tryParseAgentJson(modelOutput);
 * if (parsed) {
 *   // Use parsed plan
 * } else {
 *   // Try fallback (extract plan lines from think block)
 * }
 * ```
 */
export const tryParseAgentJson = (raw: string): unknown | null => {
  const candidate = extractJsonObject(raw).trim();
  if (candidate.length === 0) {
    return null;
  }

  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(repairJsonString(candidate));
    } catch {
      return null;
    }
  }
};

/**
 * Extracts think text for plan-line fallback using cascading strategies.
 *
 * @remarks
 * Tries in order:
 * 1. `<agent-think>` block (preferred)
 * 2. `<think>` block content
 * 3. Cleaned full response (if non-empty)
 * 4. `null` if nothing available
 *
 * Used when JSON parsing fails to build a plan from natural-language steps.
 *
 * @param raw - Raw model output.
 * @returns Think text for fallback plan extraction, or `null` if none available.
 */
export const extractThinkTextForPlan = (raw: string): string | null => {
  const agentThink = extractAgentThink(raw);
  if (agentThink) {
    return agentThink;
  }

  const redactedMatch = REDACTED_THINKING_RE.exec(raw);
  if (redactedMatch?.[1]?.trim()) {
    return redactedMatch[1].trim();
  }

  const cleaned = stripModelThinkingBlocks(raw).trim();
  return cleaned.length > 0 ? cleaned : null;
};

const coercePositiveInt = (value: unknown): number => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN;
  }
  return NaN;
};

const normalizeSubtaskEntry = (
  item: unknown,
): Record<string, unknown> | null => {
  if (typeof item !== "object" || item === null) {
    return null;
  }

  const itemObject = { ...(item as Record<string, unknown>) };
  const subtaskId = coercePositiveInt(itemObject.id);
  if (Number.isFinite(subtaskId)) {
    itemObject.id = subtaskId;
  }

  if (Array.isArray(itemObject.dependsOn)) {
    itemObject.dependsOn = itemObject.dependsOn.map((dependency) =>
      coercePositiveInt(dependency),
    );
  }

  if (itemObject.agentId !== undefined) {
    const agentId = coercePositiveInt(itemObject.agentId);
    if (Number.isFinite(agentId)) {
      itemObject.agentId = agentId;
    }
  }

  return itemObject;
};

/**
 * Normalizes common plan-shape variants into `{ subtasks: [...] }` before
 * strict validation (top-level array, `tasks` alias, numeric-string ids).
 */
const coercePlanShape = (
  parsedJson: unknown,
): Record<string, unknown> | null => {
  if (Array.isArray(parsedJson)) {
    const subtasks = parsedJson
      .map(normalizeSubtaskEntry)
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    return { subtasks };
  }

  if (typeof parsedJson === "object" && parsedJson !== null) {
    const parsedObject = parsedJson as Record<string, unknown>;
    const rawList = Array.isArray(parsedObject.subtasks)
      ? parsedObject.subtasks
      : Array.isArray(parsedObject.tasks)
        ? parsedObject.tasks
        : null;

    if (!rawList) {
      return null;
    }

    const subtasks = rawList
      .map(normalizeSubtaskEntry)
      .filter((entry): entry is Record<string, unknown> => entry !== null);

    return { ...parsedObject, subtasks };
  }

  return null;
};

/**
 * Assigns default agent fields to subtasks when missing or invalid.
 *
 * @remarks
 * Ensures every subtask has a valid `agentId` and `agentLabel` by:
 * - Keeping existing valid fields
 * - Assigning sequential agents for missing/invalid `agentId` (roughly 1/3 of tasks per agent, max 3)
 * - Assigning "tasks" label for missing/invalid `agentLabel`
 *
 * This is a normalization step, not enforcement of max_agents constraints (see `applyMaxAgentsConstraint`).
 *
 * @param subtasks - Array of subtasks to normalize.
 * @returns New array with default fields applied to subtasks missing or invalid agent info.
 *
 * @example
 * ```ts
 * const tasks = [
 *   { id: 1, text: "Setup", agentId: undefined, agentLabel: "" },
 *   { id: 2, text: "Build", agentId: 2, agentLabel: "build" }
 * ];
 * const normalized = defaultAgentFields(tasks);
 * tasks[0]: agentId=1, agentLabel="tasks"
 * tasks[1]: agentId=2, agentLabel="build" (unchanged)
 * ```
 */
export const defaultAgentFields = (
  subtasks: PlannedSubtask[],
): PlannedSubtask[] => {
  const tasksPerAgent = Math.max(1, Math.ceil(subtasks.length / 3));

  return subtasks.map((subtask, index) => ({
    ...subtask,
    agentId:
      typeof subtask.agentId === "number" && subtask.agentId > 0
        ? subtask.agentId
        : Math.min(Math.floor(index / tasksPerAgent) + 1, 3),
    agentLabel:
      typeof subtask.agentLabel === "string" &&
      subtask.agentLabel.trim().length > 0
        ? subtask.agentLabel.trim()
        : "tasks",
  }));
};

/**
 * Validates and normalizes a parsed JSON object into a typed SubagentPlan.
 *
 * @remarks
 * Performs strict validation on structure, types, and DAG constraints:
 * - Top-level must be object with `subtasks` array (coerces variants like top-level array or `tasks` alias)
 * - At least one subtask required
 * - Every subtask must have valid `id` (positive integer), non-empty `text`
 * - Subtask IDs must be unique
 * - `dependsOn` references must exist and not point to self (no cycles)
 * - Fields like `execution` and `risks` are normalized
 * - Default agent fields applied and max_agents constraint enforced
 *
 * Throws {@link ValidationError} on any validation failure with a generic message
 * (details logged separately for debugging).
 *
 * @param parsedJson - Untrusted result from JSON.parse.
 * @param maxSubagents - Max agent constraint to apply after normalization.
 * @returns Normalized and validated plan ready for execution.
 * @throws {ValidationError} When plan structure, types, or DAG constraints are violated.
 *
 * @example
 * ```ts
 * const json = { subtasks: [{id: 1, text: "Build", dependsOn: []}] };
 * const plan = normaliseSubagentPlan(json, 3);
 * Returns validated SubagentPlan
 * ```
 */
export const normaliseSubagentPlan = (
  parsedJson: unknown,
  maxSubagents: MaxSubagentsParam,
): SubagentPlan => {
  const coercedPlan = coercePlanShape(parsedJson);

  // Step 1: Top-level must be an object with a "subtasks" array (anything else is unusable)
  if (coercedPlan === null || !Array.isArray(coercedPlan.subtasks)) {
    throw new ValidationError("Agent returned invalid plan JSON");
  }

  const rawSubtaskList = coercedPlan.subtasks;

  // Step 2: Orchestrator needs at least one subtask to run
  if (rawSubtaskList.length === 0) {
    throw new ValidationError("Agent returned invalid plan JSON");
  }

  const idSet = new Set<number>();
  const validatedSubtasks: PlannedSubtask[] = [];

  // Step 3: Validate each array element — shape, types, uniqueness, non-empty text
  for (const subtaskItem of rawSubtaskList) {
    if (typeof subtaskItem !== "object" || subtaskItem === null) {
      throw new ValidationError("Agent returned invalid plan JSON");
    }

    const itemObject = subtaskItem as Record<string, unknown>;

    // id must be a positive integer (floats / strings / zero rejected via NaN)
    const subtaskId = coercePositiveInt(itemObject.id);

    const subtaskText =
      typeof itemObject.text === "string" ? itemObject.text.trim() : "";

    // dependsOn defaults to [] if missing or wrong type; entries must all be integers
    const dependencyList = Array.isArray(itemObject.dependsOn)
      ? itemObject.dependsOn.map((dependency) => coercePositiveInt(dependency))
      : [];

    if (
      !Number.isFinite(subtaskId) ||
      idSet.has(subtaskId) ||
      subtaskText.length === 0
    ) {
      throw new ValidationError("Agent returned invalid plan JSON");
    }

    if (dependencyList.some((dependencyId) => !Number.isFinite(dependencyId))) {
      throw new ValidationError("Agent returned invalid plan JSON");
    }

    const coercedAgentId = coercePositiveInt(itemObject.agentId);
    const agentId = Number.isFinite(coercedAgentId) ? coercedAgentId : 1;

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
        throw new ValidationError("Agent returned invalid plan JSON");
      }
      if (dependencyId === subtask.id) {
        throw new ValidationError("Agent returned invalid plan JSON");
      }
    }
  }

  // Check for circular dependencies in the DAG
  if (!validateNoCycles(validatedSubtasks)) {
    throw new ValidationError("Agent returned invalid plan JSON");
  }

  // Step 5: Stable order for logging / combine — execution order still comes from dependsOn + waves
  validatedSubtasks.sort((taskA, taskB) => taskA.id - taskB.id);

  const parsedObject = coercedPlan;

  // Normalize risks array (filter to non-empty strings)
  const risks = Array.isArray(parsedObject.risks)
    ? parsedObject.risks.filter(
        (riskItem): riskItem is string =>
          typeof riskItem === "string" && riskItem.trim().length > 0,
      )
    : [];

  // Normalize execution field (validate or derive)
  let execution: SubagentPlan["execution"] = "sequential";
  const rawExecution = parsedObject.execution;
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
    maxSubagents,
  );
};

/**
 * Checks whether the context header includes a workspace structure snapshot.
 *
 * @remarks
 * Used to avoid redundant `explore_codebase` calls when the context already
 * includes a Structure section from prior exploration or session history.
 *
 * @param contextHeader - Context header text (may include structure section).
 * @returns `true` if context contains a "Structure:" section.
 */
export const contextHasWorkspaceStructure = (contextHeader: string): boolean =>
  /Structure:/i.test(contextHeader);

/**
 * Constructs a revised task prompt that incorporates user feedback for plan revision.
 *
 * @remarks
 * When a user requests plan edits at review, `Agent.plan()` is re-invoked with a revised
 * task that includes the user's feedback. Since planning is stateless (no conversation
 * history across calls), the feedback must be embedded in the task text itself.
 *
 * @param originalTask - The original user task description.
 * @param feedback - User's free-text feedback about the proposed plan.
 * @returns Updated task string ready for `Agent.plan()`.
 *
 * @example
 * ```ts
 * const revisedTask = buildPlanRevisionTask(
 *   "Build a login form",
 *   "Use React hooks, not class components"
 * );
 * Returns: "Build a login form\n\nUser feedback on your plan: Use React hooks, not class components\n\nRevise the plan to address this feedback."
 * ```
 */
export const buildPlanRevisionTask = (
  originalTask: string,
  feedback: string,
): string =>
  `${originalTask}\n\nUser feedback on your plan: ${feedback}\n\nRevise the plan to address this feedback.`;

/**
 * Language/framework detection patterns based on manifest filenames.
 *
 * @remarks
 * Scanned against the workspace structure context to identify the primary stack.
 * Used by `summarizeWorkspaceStackHint` to provide a concise stack label for the agent.
 */
const STACK_MANIFEST_SIGNALS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  {
    pattern:
      /\bpyproject\.toml\b|\brequirements\.txt\b|\bsetup\.py\b|\bPipfile\b/i,
    label: "Python",
  },
  { pattern: /\bgo\.mod\b/i, label: "Go" },
  { pattern: /\bCargo\.toml\b/i, label: "Rust" },
  {
    pattern: /\bpom\.xml\b|\bbuild\.gradle(?:\.kts)?\b/i,
    label: "Java/Kotlin",
  },
  { pattern: /\bGemfile\b/i, label: "Ruby" },
  { pattern: /\bcomposer\.json\b/i, label: "PHP" },
  { pattern: /\bCMakeLists\.txt\b|\bmeson\.build\b/i, label: "C/C++" },
  { pattern: /\bPackage\.swift\b/i, label: "Swift" },
  { pattern: /\bpubspec\.yaml\b/i, label: "Dart/Flutter" },
  { pattern: /\bpackage\.json\b/i, label: "Node.js" },
  { pattern: /\btsconfig\.json\b/i, label: "TypeScript" },
  {
    pattern: /\bnext\.config|\bvite\.config|angular\.json|\.tsx\b/i,
    label: "web UI",
  },
  { pattern: /\bmanage\.py\b/i, label: "Django" },
  { pattern: /\bMakefile\b/i, label: "Make" },
  { pattern: /\bdocker-compose\.ya?ml\b|\bDockerfile\b/i, label: "Docker" },
];

/**
 * Test framework detection patterns based on config filenames and layout.
 *
 * @remarks
 * Complements STACK_MANIFEST_SIGNALS to identify the test runner.
 */
const STACK_TEST_SIGNALS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bvitest\.config/i, label: "Vitest" },
  { pattern: /\bjest\.config/i, label: "Jest" },
  { pattern: /\bmocha\.|\.mocharc/i, label: "Mocha" },
  { pattern: /\bpytest\.ini\b|\bconftest\.py\b/i, label: "pytest" },
  { pattern: /\bnose2\.cfg\b|\bunittest\b/i, label: "Python tests" },
  { pattern: /\b_rspec\b|\.rspec\b|\bspec\/helpers/i, label: "RSpec" },
  { pattern: /_test\.go\b/i, label: "go test" },
  { pattern: /\bcargo\.toml\b/i, label: "cargo test" },
  { pattern: /\bJUnit\b|surefire|gradle.*test/i, label: "JUnit/Gradle test" },
  {
    pattern: /(?:^|\s)(?:tests?|spec|__tests__|_Test_)\//im,
    label: "tests/ layout",
  },
];

/**
 * Extracts matching labels from context text using signal patterns.
 *
 * @remarks
 * Helper for stack hint summarization. Prevents duplicate labels.
 *
 * @param text - Context text to scan.
 * @param signals - Array of pattern/label pairs to test.
 * @returns Array of matched labels (deduplicated).
 */
const collectStackLabels = (
  text: string,
  signals: ReadonlyArray<{ pattern: RegExp; label: string }>,
): string[] => {
  const labels: string[] = [];
  for (const { pattern, label } of signals) {
    if (pattern.test(text) && !labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels;
};

/**
 * Generates a concise stack summary from workspace context for the agent.
 *
 * @remarks
 * When workspace structure is present in context, scans it for language/framework
 * signals and returns a comma-separated label (e.g., "Python + pytest, Docker").
 * Prevents the agent from restating the full directory tree.
 *
 * @param contextHeader - Context header (may include structure snapshot).
 * @returns Stack summary string for the agent (e.g., "Node.js, Jest, web UI"),
 *   or `null` if no structure snapshot present.
 *
 * @example
 * ```ts
 * const hint = summarizeWorkspaceStackHint(contextHeader);
 * Returns "TypeScript, Jest, web UI" or null
 * ```
 */
export const summarizeWorkspaceStackHint = (
  contextHeader: string,
): string | null => {
  if (!contextHasWorkspaceStructure(contextHeader)) {
    return null;
  }

  const stack = [
    ...collectStackLabels(contextHeader, STACK_MANIFEST_SIGNALS),
    ...collectStackLabels(contextHeader, STACK_TEST_SIGNALS),
  ];

  if (stack.length === 0) {
    return "Structure snapshot present — cite stack and test runner briefly; do not list folders.";
  }

  const unique = [...new Set(stack)].slice(0, 5);
  return unique.join(", ");
};

/**
 * Re-export functions from agentThink.js that are used in agent.ts.
 * This provides a single import point for agentThink functions used by the Agent class.
 */
export {
  buildAgentThinkInstruction,
  extractAgentThink,
  parseCommandPlan,
  parseCommandPlanGaps,
  parseParallelismGaps,
  parsePlanLines,
  parseRisks,
  parseVerifyGaps,
};
