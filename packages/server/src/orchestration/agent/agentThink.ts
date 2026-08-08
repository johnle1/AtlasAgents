/**
 * Parser for agent-think blocks and plan extraction.
 *
 * @remarks
 * Parses structured `<agent-think>` blocks produced by the agent model to extract:
 * - Plan steps (numbered lines from PLAN section)
 * - Command plans (setup and verify commands)
 * - Verification and parallelism gaps
 * - Risks and execution strategy
 *
 * Also provides the agent think instruction template that guides model behavior.
 * These utilities feed into Agent.plan() validation and SubagentPlan construction.
 */

import type { MaxSubagentsParam } from "../maxSubagents.js";
import { maxSubagentsConstraintText } from "../maxSubagents.js";
import type { ToolSchema } from "../tools/types.js";
import type { CommandPlan, PlannedSubtask } from "../types.js";
import { stripMarkdownFencesFromText } from "../toolProtocol.js";

/**
 * Tag name for the agent's structured reasoning block, shared with
 * {@link AGENT_THINK_RE} and the incremental think-tag scanner in
 * `thinkStream.ts` so both agree on what to look for.
 */
export const AGENT_THINK_TAG = "agent-think";

/**
 * Regex to extract agent-think block from model output.
 *
 * @remarks
 * Matches `<agent-think>...</agent-think>` tags (case-insensitive).
 * Captures everything between the opening and closing tags as a single group.
 *
 * @example
 * ```ts
 * const thinkBlock = /<agent-think>([\s\S]*?)<\/agent-think>/i.exec(output)?.[1];
 * ```
 */
const AGENT_THINK_RE = new RegExp(
  `<${AGENT_THINK_TAG}>([\\s\\S]*?)<\\/${AGENT_THINK_TAG}>`,
  "i",
);

/**
 * JSON schema for the submit_plan tool that the agent calls to finalize planning.
 *
 * @remarks
 * Defines the structure and validation rules for the agent's final plan submission.
 * The schema enforces:
 * - At least one subtask with id, text, dependsOn, agentId, agentLabel
 * - Execution mode (parallel, sequential, or mixed)
 * - Agent count and risks array
 *
 * Template evolution notes:
 * 1. COMPLEXITY gates trivial tasks (skip full exploration)
 * 2. Context handoff: dependent subtasks embed prerequisite facts
 * 3. SELF-CHECK validates structure and file conflicts
 * 4. doneWhen criteria per agent (bounded one-level depth)
 * 5. EXPLORATION uses explore_codebase when needed
 * 6. Final output is submit_plan against this schema
 */
export const AGENT_PLAN_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "submit_plan",
    description: "Submit the finished subtask plan for this task.",
    parameters: {
      type: "object",
      properties: {
        subtasks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: {
                type: "integer",
                description: "Unique positive integer id.",
              },
              text: {
                type: "string",
                description: "Imperative instruction for a worker subagent.",
              },
              dependsOn: {
                type: "array",
                items: { type: "integer" },
                description:
                  "Prerequisite ids. Empty array if it can start immediately.",
              },
              agentId: { type: "integer" },
              agentLabel: {
                type: "string",
                description:
                  "Short label, e.g. setup, implementation, verification.",
              },
            },
            required: ["id", "text", "dependsOn", "agentId", "agentLabel"],
          },
        },
        execution: {
          type: "string",
          enum: ["parallel", "sequential", "mixed"],
        },
        agentCount: {
          type: "integer",
          description: "Unique agentId count.",
        },
        risks: { type: "array", items: { type: "string" } },
      },
      required: ["subtasks", "execution", "agentCount", "risks"],
    },
  },
} as const satisfies ToolSchema;

export const SUBMIT_PLAN_TOOL: ToolSchema = AGENT_PLAN_TOOL_SCHEMA;

const AGENT_THINK_TEMPLATE = `Before calling submit_plan, write a structured <agent-think> block:

<agent-think>
COMPLEXITY: [trivial | simple | moderate | complex]
  reasoning: [one line — why this bucket]
  trivial  = one obvious change, one file, nothing unresolved (e.g. fix a typo)
  simple   = a few related steps, one agent, mostly sequential
  moderate = multiple steps or files, may need exploration, still one agent
  complex  = real dependency structure, multiple independent surfaces, or user asked for parallel work

  IF trivial:
    - agentCount MUST be 1
    - skip UNDERSTAND entirely
    - EXPLORATION: n/a — trivial, skipped
    - PLAN: exactly 1 step (no agent breakdown beyond Agent 1)
    - waves: n/a — trivial, skipped
    - SELF-CHECK: one line only (issues? none)
    - then COMMAND PLAN + submit_plan — skip every other header below

UNDERSTAND: (skip for trivial)
  literal:  [what the user literally typed, one line]
  actual:   [what they actually need technically, one line]
  implicit: [env vars, error handling, edge cases they did not say, one line]

EXPLORATION: (default "no" — only "yes" if something is genuinely unresolved; trivial: n/a — trivial, skipped)
  need explore?  [yes | no]
  if yes: call explore_codebase for the ONE specific unknown (stack, test runner, or file layout) — prefer this cheap exploration path over reading files yourself in the planner. Not a general sweep.
  if no:  [max 12 words: name stack + test runner only, e.g. "Python + pytest" or "Node monorepo + Jest". Do NOT list folders or repeat words.]

PLAN:
  agent count: [default 1 — go higher only if surfaces are genuinely independent or the user asked for parallel work]
  execution:   [parallel | sequential | mixed]

  context handoff (critical):
    For any subtask with non-empty dependsOn, its "text" must contain the concrete facts it needs from prerequisites — exact file paths, function/variable names, decisions made. Never "use the result from step N." The executing agent has no memory of prior steps; whatever is not written into text does not exist for it.

  doneWhen:
    Each agent's last step (or subtask text) must state a checkable stopping condition, e.g. "done when npm test passes" or "done when README typo is fixed."

  Agent 1 — [label]:
    1. [step — tool it uses — why — doneWhen if last step for this agent]
  Agent 2 — [label]: (only if agent count > 1)
    2. [step]

VERIFY PLAN:
  requirement covered?  [yes / no — explain if no]
  order correct?        [yes / no]
  steps missing?        [none or list missing steps]
  risks?                [bullets of what could break]
PARALLELISM:
  waves: (only if agent count > 1 — trivial: n/a — trivial, skipped)
  Wave 1 (parallel): [step ids, dependsOn []] — [why independent; parallel steps must NOT write/edit the same file]
  Wave 2 (after Wave 1): [step ids] — [what concrete facts from wave 1 this wave needs in subtask text]
  Use "after Wave K" (the real previous number), not a literal "N". Mark "(parallel)" only when a wave has more than one step — the final wave may be a single step.

SELF-CHECK:
  issues? [none | unresolved: <one line only if PLAN or COMMAND PLAN still needs a fix>]
  file conflicts? [none | yes: <which subtasks share a write target — add dependsOn or merge>]
  wave assumptions? [none | note: <what later waves assume that Wave 1 might disprove — what to re-check after Wave 1>]
  If you already fixed something in PLAN above, write issues? none — do not list applied fixes here.

COMMAND PLAN:
  setup commands:   [concrete shell commands, one per line, no markdown fences]
  verify commands:  [concrete test/build/typecheck commands, or "none"]
</agent-think>

Then call submit_plan with the finished plan — don't also restate it as text.

Example (trivial task: "fix the typo in the README install section"):
<agent-think>
COMPLEXITY: trivial
  reasoning: single-line typo fix in one file
EXPLORATION: n/a — trivial, skipped
PLAN:
  agent count: 1
  execution: sequential
  Agent 1 — fix:
    1. Correct the typo in README.md — edit_file — done when typo is fixed
  waves: n/a — trivial, skipped
SELF-CHECK:
  issues? none
COMMAND PLAN:
  setup commands: none
  verify commands: none
</agent-think>
submit_plan({ subtasks: [{ id: 1, text: "Fix the typo in the README install section", dependsOn: [], agentId: 1, agentLabel: "fix" }], execution: "sequential", agentCount: 1, risks: [] })

Rules:
- Unique positive integer id per subtask.
- "text" is a clear imperative for a worker subagent (one plan line each).
- "dependsOn": only list an id when the task truly cannot start until that id finishes. Do NOT chain every task onto the previous one unless the work is genuinely sequential.
- "agentId" and "agentLabel" on every subtask — group steps by agent.
- At least one subtask.
- Never repeat the same word more than twice in any think line.
- Dispatched worker subagents execute tools directly and never re-run this planning prompt (one level deep — no nested planning).

maxSubagents constraint: {MAX_SUBAGENTS}

AGENT ASSIGNMENT RULES:
{AGENT_RULES}
- Give each agent a short descriptive label (setup, implementation, verification, etc.).
- Default to 1 agent. More agents only when the work is genuinely independent or the user asked for parallel execution — extra agents cost roughly proportional context, not proportional speed.`;

/**
 * Generates agent assignment rules tailored to the max_agents constraint.
 *
 * @remarks
 * Produces constraint-specific guidance for how the agent should distribute tasks.
 * - maxSubagents=1: All sequential in Agent 1
 * - maxSubagents=2: Exactly two agents
 * - maxSubagents="max": Unlimited (prefer parallelism)
 * - maxSubagents=N: At most N agents
 *
 * @param maxSubagents - The max_agents constraint.
 * @returns String describing agent assignment rules for the template.
 */
const agentAssignmentRules = (maxSubagents: MaxSubagentsParam): string => {
  if (maxSubagents === 1) {
    return "- All subtasks agentId 1, dependsOn fully sequential (chain).";
  }
  if (maxSubagents === 2) {
    return "- Exactly two agentIds; setup in Agent 1, rest in Agent 2.";
  }
  if (maxSubagents === "max") {
    return "- Use as many agents as the task needs (3+ when independent workstreams exist). Prefer parallelism over conservatism.";
  }
  if (typeof maxSubagents === "number") {
    return `- Use at most ${maxSubagents} agents. Prefer fewer when the task is simple. Only add agents for clearly independent workstreams.`;
  }
  return "- Assign by task structure.";
};

/**
 * Builds the complete agent think instruction by filling template placeholders.
 *
 * @remarks
 * Interpolates constraint-specific text (max_agents description and assignment rules)
 * into the instruction template. The result is injected into the agent's system prompt.
 *
 * @param maxSubagents - The max_agents constraint to include in instructions.
 * @returns Complete think instruction string with placeholders filled.
 *
 * @example
 * ```ts
 * const instruction = buildAgentThinkInstruction(3);
 * Returns full template with {MAX_SUBAGENTS} and {AGENT_RULES} replaced
 * ```
 */
export const buildAgentThinkInstruction = (
  maxSubagents: MaxSubagentsParam,
): string =>
  AGENT_THINK_TEMPLATE.replace(
    "{MAX_SUBAGENTS}",
    maxSubagentsConstraintText(maxSubagents),
  ).replace("{AGENT_RULES}", agentAssignmentRules(maxSubagents));

/**
 * @deprecated
 * <Summary>
 * What it does:
 *   Default agent think instruction using default maxSubagents (3).
 *
 * How it fits in the system:
 *   Kept for backward compatibility. New code should use
 *   buildAgentThinkInstruction(maxSubagents) to respect the constraint.
 * </Summary>
 */
export const AGENT_THINK_INSTRUCTION = buildAgentThinkInstruction(3);

/**
 * Extracts the agent-think block from model output.
 *
 * @remarks
 * Uses AGENT_THINK_RE to find and extract the content between `<agent-think>` tags.
 * Trims whitespace from the extracted content.
 *
 * @param raw - Raw model output (may contain think block and other content).
 * @returns The think block content trimmed, or `null` if no block found.
 *
 * @example
 * ```ts
 * const raw = "<agent-think>COMPLEXITY: moderate\n...</agent-think>\nJSON plan";
 * const think = extractAgentThink(raw);
 * // Returns "COMPLEXITY: moderate\n..."
 * ```
 */
export const extractAgentThink = (raw: string): string | null => {
  const regexMatch = AGENT_THINK_RE.exec(raw);
  return regexMatch?.[1]?.trim() ?? null;
};

/**
 * Removes the agent-think block from model output.
 *
 * @remarks
 * Uses regex replacement to strip `<agent-think>...</agent-think>` tags and
 * trims the remaining output. Used to isolate JSON or other content.
 *
 * @param raw - Raw model output containing a think block.
 * @returns Output with think block removed and trimmed.
 *
 * @example
 * ```ts
 * const raw = "<agent-think>...</agent-think>\n{\"subtasks\": [...]}";
 * const stripped = stripAgentThink(raw);
 * // Returns "{\"subtasks\": [...]}"
 * ```
 */
export const stripAgentThink = (raw: string): string => {
  return raw.replace(AGENT_THINK_RE, "").trim();
};

/**
 * Result of parsing the VERIFY PLAN section for gaps.
 *
 * @remarks
 * Used by Agent.plan() to validate whether the agent identified gaps in its planning
 * (missing requirements, missing steps, ordering issues). If gaps detected, a revision
 * round is triggered.
 */
export type VerifyGaps = {
  /** Whether the VERIFY PLAN section identified unresolved gaps. */
  hasGaps: boolean;

  /** Human-readable summary of detected gaps (empty if hasGaps is false). */
  missingSummary: string;
};

/**
 * Regex to match explicit "no gap" answers in verification responses.
 *
 * @remarks
 * Anchored at the start to catch clear negatives: "None", "No", "N/A", "Nothing missing", etc.
 * Avoids false positives like "no error handling yet" (which ARE gaps).
 */
const NO_GAP_ANSWER_RE =
  /^(?:none|no|n\/?a|nothing|nope|all (?:covered|good|done)|covered)\b/i;

/** Regex to match when a gap was already fixed in the plan (not an unresolved gap). */
const SELF_CHECK_FIX_APPLIED_RE =
  /^\[(?:added|fixed|applied|resolved)\b|\b(?:applied|fixed|corrected|updated|added)\b/i;

/** Regex to detect explicit "unresolved:" prefix in self-check responses. */
const SELF_CHECK_UNRESOLVED_RE = /\bunresolved\s*:/i;

/**
 * Determines if a self-check response indicates unresolved issues.
 *
 * @remarks
 * Applies multiple heuristics in order:
 * 1. Empty → no issues
 * 2. Explicit "no" → no issues
 * 3. Explicit "unresolved:" → has issues
 * 4. Explicit "fixed/applied" → no issues (was fixed, not pending)
 * 5. Legacy keywords (still, missing, forgot, etc.) → has issues
 */
const isUnresolvedSelfCheckAnswer = (issuesNormalized: string): boolean => {
  if (issuesNormalized.length === 0) {
    return false;
  }
  if (NO_GAP_ANSWER_RE.test(issuesNormalized)) {
    return false;
  }
  if (SELF_CHECK_UNRESOLVED_RE.test(issuesNormalized)) {
    return true;
  }
  if (SELF_CHECK_FIX_APPLIED_RE.test(issuesNormalized)) {
    return false;
  }
  return /\b(?:still|missing|forgot|without|not yet|unresolved)\b/i.test(
    issuesNormalized,
  );
};

/**
 * Checks whether a think block marks the task as trivial.
 *
 * @remarks
 * Trivial tasks are exempt from full EXPLORATION and SELF-CHECK validation.
 */
const isTrivialThinkBlock = (thinkText: string): boolean =>
  /(?:COMPLEXITY|TASK SIZE):\s*trivial/i.test(thinkText);

/**
 * Parses the SELF-CHECK section to detect validation gaps.
 *
 * @remarks
 * Extracts the `issues?` field from SELF-CHECK and evaluates whether gaps remain.
 * Trivial tasks always pass (no gaps). Returns `hasGaps=false` if issues are resolved.
 *
 * @param thinkText - The agent-think block content.
 * @returns Gap detection result with optional summary.
 */
export const parseVerifyGaps = (thinkText: string): VerifyGaps => {
  if (isTrivialThinkBlock(thinkText)) {
    return { hasGaps: false, missingSummary: "" };
  }

  const selfCheckMatch =
    /SELF-CHECK:\s*([\s\S]*?)(?=\n\s*COMMAND PLAN:|$)/i.exec(thinkText);
  const section = selfCheckMatch?.[1] ?? "";
  const issuesMatch = /issues\?\s*:?\s*([^\n]+)/i.exec(section);
  const issuesRaw = (issuesMatch?.[1] ?? "").trim();
  const issuesNormalized = issuesRaw.replace(/[.!,;:]+$/g, "").trim();
  const hasIssues = isUnresolvedSelfCheckAnswer(issuesNormalized);

  return {
    hasGaps: hasIssues,
    missingSummary: hasIssues ? `SELF-CHECK issues: ${issuesRaw}` : "",
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
 *   @param line - The line to check.
 *
 * Returns:
 *   {boolean} — True if the line is a placeholder.
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
 *   @param line - The line to strip.
 *
 * Returns:
 *   {string} — The line with wrapping removed.
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
 *   @param section - The section text containing commands.
 *
 * Returns:
 *   {string[]} — Array of command strings.
 * </Summary>
 */
const parseCommandLines = (section: string): string[] => {
  const commands: string[] = [];
  for (const line of stripMarkdownFencesFromText(section).split("\n")) {
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
 *   @param thinkText - The agent-think block content.
 *
 * Returns:
 *   {CommandPlan} — Object containing setup, verify, and run-project command arrays.
 * </Summary>
 */
export const parseCommandPlan = (thinkText: string): CommandPlan => {
  const blockMatch = /COMMAND PLAN:\s*([\s\S]*?)$/i.exec(thinkText);
  const blockText = blockMatch?.[1] ?? "";

  const setupMatch = /setup commands:\s*([\s\S]*?)(?=verify commands:|$)/i.exec(
    blockText,
  );

  const verifyMatch =
    /verify commands:\s*([\s\S]*?)(?=setup commands:|$)/i.exec(blockText);

  return {
    setupCommands: parseCommandLines(setupMatch?.[1] ?? ""),
    verifyCommands: parseCommandLines(verifyMatch?.[1] ?? ""),
    runProjectCommands: [],
  };
};

/**
 * Result of parsing the COMMAND PLAN section for gaps.
 *
 * @remarks
 * Used by Agent.plan() to validate whether the agent included required command categories
 * (setup and verify commands). If gaps detected, a revision round is triggered.
 */
export type CommandPlanGaps = {
  /** Whether required command categories are missing. */
  hasGaps: boolean;

  /** Human-readable summary of missing categories (empty if hasGaps is false). */
  missingSummary: string;
};

/**
 * Parses the COMMAND PLAN section and validates required categories.
 *
 * @remarks
 * Checks for missing verify commands (required unless the plan is trivial).
 * Trivial tasks skip full COMMAND PLAN validation. Returns gap result for use
 * in planning validation.
 *
 * @param thinkText - The agent-think block content.
 * @returns Gap detection result indicating whether verify commands are missing.
 */
export const parseCommandPlanGaps = (thinkText: string): CommandPlanGaps => {
  if (isTrivialThinkBlock(thinkText)) {
    return { hasGaps: false, missingSummary: "" };
  }

  const commandPlan = parseCommandPlan(thinkText);

  if (commandPlan.verifyCommands.length === 0) {
    return {
      hasGaps: true,
      missingSummary: "verify commands",
    };
  }

  return {
    hasGaps: false,
    missingSummary: "",
  };
};

/**
 * Result of analyzing parallelism gaps in planning.
 *
 * @remarks
 * Checks whether the agent's declared execution mode (parallel/mixed) matches
 * the actual dependsOn structure, and whether a PARALLELISM section is present
 * when needed. Parallelism gaps are logged for debugging but do NOT trigger
 * re-prompts — the agent's judgment is trusted.
 */
export type ParallelismGaps = {
  /** Whether parallelism reasoning is missing or contradicts the JSON structure. */
  hasGaps: boolean;

  /** Human-readable summary of gaps detected (empty if none). */
  missingSummary: string;
};

/**
 * Extracts the declared execution mode from the think block PLAN section.
 *
 * @remarks
 * Searches for an `execution:` line and normalizes the value to one of the
 * valid modes: parallel, sequential, mixed. Returns null if not found or invalid.
 *
 * @param thinkText - The agent-think block content.
 * @returns Normalized execution mode, or `null` if not found or invalid.
 */
const extractDeclaredExecution = (
  thinkText: string,
): "parallel" | "sequential" | "mixed" | null => {
  const executionMatch = /execution\s*:\s*([a-z]+)/i.exec(thinkText);
  const rawValue = executionMatch?.[1]?.toLowerCase().trim() ?? "";
  if (
    rawValue === "parallel" ||
    rawValue === "sequential" ||
    rawValue === "mixed"
  ) {
    return rawValue;
  }
  return null;
};

/**
 * Checks whether the JSON plan's subtask structure is fully sequential.
 *
 * @remarks
 * A fully sequential plan has:
 * - First subtask with empty dependsOn
 * - Each subsequent subtask depending only on the previous one (one-element dependsOn)
 * - No branching or parallelism
 *
 * Used to detect contradictions between declared execution mode and actual structure.
 *
 * @param parsedJson - Parsed plan JSON (typically from JSON.parse).
 * @returns `true` if the subtask graph is a strict sequential chain.
 */
const isFullySequentialChain = (parsedJson: unknown): boolean => {
  if (
    typeof parsedJson !== "object" ||
    parsedJson === null ||
    !("subtasks" in parsedJson) ||
    !Array.isArray((parsedJson as { subtasks: unknown }).subtasks)
  ) {
    return false;
  }

  const subtasks = (parsedJson as { subtasks: unknown[] }).subtasks
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }
      const obj = entry as Record<string, unknown>;
      const id =
        typeof obj.id === "number" && Number.isInteger(obj.id) ? obj.id : null;
      const dependsOn = Array.isArray(obj.dependsOn)
        ? (obj.dependsOn.filter(
            (dep) => typeof dep === "number" && Number.isInteger(dep),
          ) as number[])
        : [];
      return id === null ? null : { id, dependsOn };
    })
    .filter(
      (entry): entry is { id: number; dependsOn: number[] } => entry !== null,
    )
    .sort((a, b) => a.id - b.id);

  if (subtasks.length === 0) {
    return false;
  }

  if (subtasks[0]!.dependsOn.length !== 0) {
    return false;
  }

  for (let i = 1; i < subtasks.length; i += 1) {
    const current = subtasks[i]!;
    const previous = subtasks[i - 1]!;
    if (
      current.dependsOn.length !== 1 ||
      current.dependsOn[0] !== previous.id
    ) {
      return false;
    }
  }

  return true;
};

/**
 * Analyzes parallelism gaps: declared execution mode vs. actual structure.
 *
 * @remarks
 * Checks for contradictions between:
 * - Declared execution (parallel/mixed) and actual JSON structure (sequential chain)
 * - Declared execution (parallel/mixed) and missing PARALLELISM section
 *
 * Parallelism gaps are logged but do NOT trigger re-prompts — the agent's
 * declared strategy is trusted. This function is for debugging and observability.
 *
 * @param thinkText - The agent-think block content.
 * @param parsedJson - Parsed plan JSON.
 * @returns Gap analysis result (may be empty if no gaps found).
 */
export const parseParallelismGaps = (
  thinkText: string,
  parsedJson: unknown,
): ParallelismGaps => {
  const declaredExecution = extractDeclaredExecution(thinkText);

  if (declaredExecution === null || declaredExecution === "sequential") {
    return { hasGaps: false, missingSummary: "" };
  }

  const gapParts: string[] = [];

  if (!/^\s*waves\s*:/im.test(thinkText)) {
    gapParts.push("waves section missing");
  }

  if (isFullySequentialChain(parsedJson)) {
    gapParts.push(
      "execution claims parallel/mixed but every subtask chains onto the previous one",
    );
  }

  return {
    hasGaps: gapParts.length > 0,
    missingSummary: gapParts.join("; "),
  };
};

/**
 * Extracts risks from the agent-think block (stub implementation).
 *
 * @remarks
 * Currently a stub that always returns an empty array. The orchestration uses
 * the structured `risks` field from the submit_plan JSON instead. Kept as a
 * named export for future re-implementation if free-text risk extraction is needed.
 *
 * @param _thinkText - The agent-think block content (currently unused).
 * @returns Always an empty array `[]`.
 */
export const parseRisks = (_thinkText: string): string[] => [];

/**
 * Regex to match a numbered plan step line.
 *
 * @remarks
 * Captures the step text (without the number prefix). Matches lines like:
 * - `1. Deploy the application`
 * - `  2. Run integration tests`
 *
 * Used to extract individual steps from PLAN sections.
 */
const PLAN_STEP_RE = /^\s*\d+\.\s+(.+)$/;

/**
 * Regex to detect the end of a plan section.
 *
 * @remarks
 * Matches section headers that mark the end of a PLAN section:
 * - SELF-CHECK, COMMAND PLAN, UNDERSTAND, EXPLORATION, COMPLEXITY, TASK SIZE, waves
 *
 * Used to determine where one plan section ends and another begins.
 */
const PLAN_SECTION_END =
  /\n\s*(?:(?:SELF-CHECK|COMMAND)\s+PLAN|UNDERSTAND|EXPLORATION|(?:COMPLEXITY|TASK SIZE)|waves\s*:)/i;

/**
 * Checks whether a string is a placeholder (empty, "none", "N/A", etc.).
 *
 * @remarks
 * Used to filter out placeholder lines when extracting numbered plan steps.
 * Recognizes common patterns indicating "no content here".
 *
 * @param text - Text to check.
 * @returns `true` if text is a placeholder, `false` otherwise.
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
 * Extracts a named plan section from the think block.
 *
 * @remarks
 * Finds the section header (e.g., "PLAN", "DRAFT PLAN") and extracts all content
 * until the next section header (or end of text). Returns empty string if section not found.
 *
 * @param thinkText - The agent-think block content.
 * @param header - Section header name to extract (e.g., "PLAN").
 * @returns Content of the section, or empty string if not found.
 */
const extractPlanSection = (thinkText: string, header: string): string => {
  const headerRegex = new RegExp(
    `^\\s*${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*\\([^)]*\\))?:?\\s*$`,
    "im",
  );

  const headerMatch = headerRegex.exec(thinkText);
  if (!headerMatch) {
    return "";
  }

  const startIndex = headerMatch.index + headerMatch[0].length;
  const remainingText = thinkText.slice(startIndex);
  const endMatch = PLAN_SECTION_END.exec(remainingText);

  return endMatch ? remainingText.slice(0, endMatch.index) : remainingText;
};

/**
 * Extracts numbered plan steps from a plan section.
 *
 * @remarks
 * Splits section by lines, matches each line against PLAN_STEP_RE, extracts
 * step text, and filters out placeholders.
 *
 * @param section - Plan section text containing numbered steps.
 * @returns Array of valid (non-placeholder) step strings.
 */
const extractNumberedSteps = (section: string): string[] => {
  const steps: string[] = [];
  for (const line of section.split("\n")) {
    const stepMatch = PLAN_STEP_RE.exec(line);
    if (!stepMatch) {
      continue;
    }

    const stepText = stepMatch[1].trim();

    if (!isPlanPlaceholder(stepText)) {
      steps.push(stepText);
    }
  }

  return steps;
};

/**
 * Extracts numbered plan lines from the PLAN section of the think block.
 *
 * @remarks
 * Extracts the PLAN section from the think block, then extracts all numbered
 * steps from that section. Filters out placeholder lines (empty, "none", etc.).
 *
 * Used as a fallback when JSON parsing fails, to build a plan from natural-language steps.
 *
 * @param thinkText - The agent-think block content.
 * @returns Array of plan step strings (may be empty if no steps found).
 */
export const parsePlanLines = (thinkText: string): string[] =>
  extractNumberedSteps(extractPlanSection(thinkText, "PLAN"));

/**
 * Converts natural-language plan lines into structured subtask objects.
 *
 * @remarks
 * Used as a fallback when JSON parsing fails. Converts plan step lines into
 * PlannedSubtask objects with:
 * - Sequential numbering (id: 1, 2, 3, ...)
 * - Agent assignment based on maxSubagents constraint
 * - Dependencies chaining to previous task (sequential by default)
 * - Labels from predefined list (setup, implementation, verification, tasks)
 *
 * **Agent assignment:**
 * - maxSubagents=1: All tasks to Agent 1
 * - maxSubagents=2: Exactly 2 agents
 * - maxSubagents="max": Up to 4 agents
 * - maxSubagents=N: Up to N agents
 *
 * @param lines - Array of plan step strings (typically from parsePlanLines).
 * @param maxSubagents - Max agent constraint (default 3).
 * @returns Array of PlannedSubtask objects with ids, dependencies, and agent assignments.
 *
 * @example
 * ```ts
 * const lines = ["Set up the database", "Run migrations", "Deploy the app"];
 * const subtasks = buildPlanFromLines(lines, 2);
 * Returns [
 *   { id: 1, text: "Set up the database", dependsOn: [], agentId: 1, agentLabel: "setup" },
 *   { id: 2, text: "Run migrations", dependsOn: [1], agentId: 1, agentLabel: "setup" },
 *   { id: 3, text: "Deploy the app", dependsOn: [2], agentId: 2, agentLabel: "implementation" }
 * ]
 * ```
 */
export const buildPlanFromLines = (
  lines: string[],
  maxSubagents: MaxSubagentsParam = 3,
): PlannedSubtask[] => {
  const trimmedLines = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (maxSubagents === 1) {
    return trimmedLines.map((stepText, index) => ({
      id: index + 1,
      text: stepText,
      dependsOn: index === 0 ? [] : [index],
      agentId: 1,
      agentLabel: "all tasks",
    }));
  }

  const calculatedAgentCount =
    maxSubagents === 2
      ? 2
      : maxSubagents === "max"
        ? Math.min(trimmedLines.length, 4)
        : Math.min(trimmedLines.length, maxSubagents);
  const tasksPerAgent = Math.max(
    1,
    Math.ceil(trimmedLines.length / calculatedAgentCount),
  );

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
