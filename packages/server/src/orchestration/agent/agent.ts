/**
 * Orchestrates task planning, escalation guidance, and result synthesis using the agent model.
 *
 * @remarks
 * The Agent class handles three core responsibilities:
 * 1. **Planning** — Decomposes user tasks into executable Directed Acyclic Graph (DAG) plans using the agent model.
 * 2. **Escalation guidance** — Provides blocking advice when worker subagents get stuck.
 * 3. **Result synthesis** — Streams a final user-facing answer that merges multi-subtask results.
 *
 * The agent uses the Ollama inference API and never manages RSocket or TCP connections directly.
 * It's the "lead" coordinator model configured for reasoning and planning, distinct from execution subagents.
 *
 * @example
 * ```ts
 * const agent = new Agent({ ollama: client, config: configManager });
 * const plan = await agent.plan(userTask, contextHeader, skillContent);
 * // Returns validated SubagentPlan with subtasks, risks, and execution strategy
 * ```
 */

import { TaskSkippedError, PlanRevisionRequestedError } from "./agentErrors.js";
import { ValidationError, OrchestrationError } from "../../errors/index.js";
import {
  buildAgentThinkInstruction,
  buildPlanFromLines,
  extractAgentThink,
  parseCommandPlan,
  parseCommandPlanGaps,
  parseParallelismGaps,
  parsePlanLines,
  parseRisks,
  parseVerifyGaps,
} from "./agentThink.js";
import type { MaxSubagentsParam } from "../maxSubagents.js";
import {
  applyMaxAgentsConstraint,
  deriveExecution,
  validateNoCycles,
} from "../planHelpers.js";
import {
  extractThinkTextForPlan,
  normaliseSubagentPlan,
  tryParseAgentJson,
} from "./agentHelpers.js";
import type { IConfigManager, IOllamaClient } from "../interfaces.js";
import type {
  SubagentPlan,
  CommandPlan,
  Message,
  PlannedSubtask,
  PlanReviewResponse,
  SubtaskResult,
  TaskModelOverrides,
} from "../types.js";
import { emptyCommandPlan } from "../types.js";
import {
  SubagentPlanHooks,
  MAX_AGENT_EXPLORE_CALLS,
  MAX_AGENT_LOOPS,
  MAX_AGENT_SEARCH_CALLS,
  MAX_AGENT_TOTAL_ITERATIONS,
} from "./agentConstants.js";
import {
  AGENT_EXPLORATION_RULES,
  AGENT_RETRIEVAL_RULES,
  EXPLORE_CODEBASE_TOOL,
  hasAgentSearchTools,
  isAgentSearchToolName,
  isExploreCodebaseTool,
  SUBMIT_PLAN_TOOL,
  SUBMIT_PLAN_TOOL_NAME,
} from "./agentTools.js";
import { formatMcpData } from "../tools/tokenSaveToolHandler.js";
import type { ToolSchema } from "../tools/types.js";
import { logger } from "../../logger.js";

export { TaskSkippedError, PlanRevisionRequestedError } from "./agentErrors.js";

/** Extracts and formats error message from raw plan JSON response. */
const planJsonErrorMessage = (rawResponse: string): string => {
  const snippet = rawResponse.replace(/\s+/g, " ").trim().slice(0, 200);
  return snippet.length > 0
    ? `Agent returned invalid plan JSON. Model output started with: "${snippet}"`
    : "Agent returned invalid plan JSON";
};

/** Generates error message for empty model response (may indicate reasoning model). */
const emptyAgentResponseMessage = (agentModel: string): string =>
  `Agent model '${agentModel}' returned an empty response. It may be a reasoning model whose output was not captured, or the model tag may be incorrect.`;

/** Returns appropriate error message based on response content (empty vs. invalid JSON). */
const agentPlanFailureMessage = (
  agentModel: string,
  rawResponse: string,
): string => {
  if (rawResponse.trim().length === 0) {
    return emptyAgentResponseMessage(agentModel);
  }
  return planJsonErrorMessage(rawResponse);
};

/** Truncates text for revision prompts with ellipsis suffix. */
const truncateForRevisionPrompt = (text: string, max = 120): string =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;

/** Detects if response looks like conversational prose rather than structured plan output. */
const looksLikeConversationalReply = (rawResponse: string): boolean => {
  const trimmed = rawResponse.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (/<agent-think>/i.test(trimmed)) {
    return false;
  }
  return /^(?:the user|you(?:'re| are) (?:right|correct|pointing)|i (?:see|understand|missed|need to)|let me)/i.test(
    trimmed,
  );
};

/**
 * Constructs a targeted revision prompt telling the agent to fix specific gaps.
 *
 * @remarks
 * Incorporates gap summary and command hints into a concise revision request,
 * respecting tool calling mode (native vs. text-based).
 */
const revisionFollowUpMessage = (
  gapSummary: string,
  commandHint: string,
  configuredSupportsTools: boolean,
): string => {
  const planFollowUp = configuredSupportsTools
    ? "call submit_plan with your subtask breakdown."
    : "call submit_plan with your subtask breakdown after your <agent-think> block.";
  const missing = truncateForRevisionPrompt(gapSummary);
  return [
    "Revise your plan. Do not explain, acknowledge, or discuss this message.",
    missing.length > 0
      ? `Still missing: ${missing}${commandHint}`
      : commandHint.trim(),
    `Output ONLY a corrected <agent-think> block, then ${planFollowUp}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

/**
 * Constructs a recovery message when agent is over-explaining instead of focusing on structured output.
 *
 * @remarks
 * Directs the agent to stop conversational prose and output only the plan structure.
 */
const formatOnlyRecoveryMessage = (configuredSupportsTools: boolean): string =>
  configuredSupportsTools
    ? "Stop explaining. Output ONLY a <agent-think> block, then call submit_plan. No prose."
    : "Stop explaining. Output ONLY a <agent-think> block with your plan, then submit_plan JSON. No prose.";

/** A tool call parsed from a native tool-calling response: name plus arguments. */
type ParsedToolCall = { name: string; args: Record<string, unknown> };

/**
 * Resolved model, temperature, and tool-support settings for one planning call.
 *
 * @remarks
 * Combines persisted config with optional per-task overrides. Per-task overrides
 * take precedence for flexibility (e.g., trying a different model for one task).
 */
type PlanningConfig = {
  /** Ollama model identifier to use for planning. */
  agentModel: string;
  /** Sampling temperature for planning (typically low for consistency). */
  agentTemperature: number;
  /** Whether the configured model supports native tool calling. */
  configuredSupportsTools: boolean;
};

/** Resolved model and temperature for one advise/combine call (no tool-support flag needed). */
type ModelAndTemperature = {
  /** Ollama model identifier to use. */
  agentModel: string;
  /** Sampling temperature to use. */
  agentTemperature: number;
};

/**
 * Resolves the effective model and temperature from config, preferring per-task overrides.
 *
 * @remarks
 * Shared by `advise()`, `combine()`, and `resolvePlanningConfig()` so the
 * override-precedence logic (per-task override wins over persisted config) lives in one place.
 *
 * @param config - Config manager providing default settings.
 * @param overrides - Optional per-task model/temperature overrides.
 * @returns Resolved model and temperature.
 */
const resolveModelAndTemperature = async (
  config: IConfigManager,
  overrides: TaskModelOverrides | undefined,
): Promise<ModelAndTemperature> => {
  const agentModel =
    overrides?.agentModel?.trim() || (await config.getAgentModel());
  const agentTemperature =
    overrides?.agentTemp ?? (await config.getAgentTemperature());
  return { agentModel, agentTemperature };
};

/**
 * Resolves effective planning configuration from config manager and optional per-task overrides.
 *
 * @remarks
 * Per-task overrides take precedence over persisted config. This allows callers to
 * temporarily switch models or temperatures for specific tasks without persisting changes.
 *
 * @param config - Config manager providing default settings.
 * @param overrides - Optional per-task model/temperature/tool-support overrides.
 * @returns Resolved planning configuration with effective model and temperature.
 */
const resolvePlanningConfig = async (
  config: IConfigManager,
  overrides: TaskModelOverrides | undefined,
): Promise<PlanningConfig> => {
  const { agentModel, agentTemperature } = await resolveModelAndTemperature(
    config,
    overrides,
  );
  const configuredSupportsTools =
    overrides?.agentModelSupportsTools ??
    (await config.getAgentModelSupportsTools());
  return { agentModel, agentTemperature, configuredSupportsTools };
};

/**
 * Builds the complete system prompt for planning by combining skill, context, rules, and instructions.
 *
 * @remarks
 * Assembles the system prompt from multiple sources in order:
 * 1. Skill content (if provided)
 * 2. Memory context header (if provided)
 * 3. Exploration rules (always)
 * 4. Retrieval rules (if tool calling is supported and search tools are available)
 * 5. Agent think instruction template (always)
 *
 * @param skillContent - Selected skill markdown (may be empty).
 * @param contextHeader - Memory/preference context (may be empty).
 * @param hooks - Optional hooks that may provide search tools.
 * @param configuredSupportsTools - Whether native tool calling is available.
 * @param maxSubagents - Max agent constraint to include in instructions.
 * @returns Complete system prompt string.
 */
const buildPlanningSystemText = (
  skillContent: string,
  contextHeader: string,
  hooks: SubagentPlanHooks | undefined,
  configuredSupportsTools: boolean,
  maxSubagents: MaxSubagentsParam,
): string => {
  const systemParts: string[] = [];
  if (skillContent.trim().length > 0) {
    systemParts.push(skillContent.trim());
  }
  if (contextHeader.trim().length > 0) {
    systemParts.push(contextHeader.trim());
  }
  systemParts.push(AGENT_EXPLORATION_RULES);
  if (
    configuredSupportsTools &&
    hasAgentSearchTools(hooks?.searchTools ?? [])
  ) {
    systemParts.push(AGENT_RETRIEVAL_RULES);
  }
  systemParts.push(buildAgentThinkInstruction(maxSubagents));
  return systemParts.join("\n\n");
};

/**
 * Builds the tool list offered to the model for this planning iteration.
 *
 * @remarks
 * Respects per-call budgets: submit_plan is always offered (if native tools enabled),
 * explore_codebase only if budget remaining, search tools only if budget remaining.
 *
 * @param configuredSupportsTools - Whether native tool calling is available.
 * @param hooks - Optional hooks providing explore and search tool implementations.
 * @param exploreCallsUsed - Count of explore calls already made this iteration.
 * @param searchCallsUsed - Count of search calls already made this iteration.
 * @returns Array of tool schemas available for this model call.
 */
const buildPlanningTools = (
  configuredSupportsTools: boolean,
  hooks: SubagentPlanHooks | undefined,
  exploreCallsUsed: number,
  searchCallsUsed: number,
): ToolSchema[] =>
  configuredSupportsTools
    ? [
        SUBMIT_PLAN_TOOL,
        ...(hooks?.exploreCodebase && exploreCallsUsed < MAX_AGENT_EXPLORE_CALLS
          ? [EXPLORE_CODEBASE_TOOL]
          : []),
        ...(searchCallsUsed < MAX_AGENT_SEARCH_CALLS
          ? (hooks?.searchTools ?? [])
          : []),
      ]
    : [];

/**
 * Result of handling an explore or search tool call during planning.
 *
 * @remarks
 * Used to track whether an auxiliary tool call (explore or search) was handled,
 * and to report updated budgets so the planning loop knows when limits are reached.
 */
type AuxiliaryToolOutcome = {
  /** `true` when a tool call was dispatched; caller should continue the loop. */
  handled: boolean;
  /** Updated count of explore_codebase calls made. */
  exploreCallsUsed: number;
  /** Updated count of search tool calls made. */
  searchCallsUsed: number;
};

/**
 * Dispatches an `explore_codebase` or search tool call made during planning iteration.
 *
 * @remarks
 * Appends assistant and tool response turns to the message array in place.
 * Checks explore before search (priority order). Does not dispatch the same call type twice.
 * Respects per-call budgets and only dispatches if the budget is not exhausted.
 *
 * @param messages - Message array to append assistant/tool turns to (mutated in place).
 * @param rawResponse - The model's raw response text.
 * @param configuredSupportsTools - Whether native tool calling is available.
 * @param exploreCall - Parsed explore_codebase tool call (if present).
 * @param searchCall - Parsed search tool call (if present).
 * @param hooks - Optional hooks providing tool implementations.
 * @param exploreCallsUsed - Current count of explore calls made.
 * @param searchCallsUsed - Current count of search calls made.
 * @returns Outcome indicating whether a call was handled and updated budgets.
 */
const handleAuxiliaryToolCall = async (
  messages: Message[],
  rawResponse: string,
  configuredSupportsTools: boolean,
  exploreCall: ParsedToolCall | undefined,
  searchCall: ParsedToolCall | undefined,
  hooks: SubagentPlanHooks | undefined,
  exploreCallsUsed: number,
  searchCallsUsed: number,
): Promise<AuxiliaryToolOutcome> => {
  if (
    configuredSupportsTools &&
    exploreCall &&
    hooks?.exploreCodebase &&
    exploreCallsUsed < MAX_AGENT_EXPLORE_CALLS
  ) {
    const exploreResult = await hooks.exploreCodebase();
    messages.push({
      role: "assistant",
      content: rawResponse,
      tool_calls: [
        {
          function: {
            name: exploreCall.name,
            arguments: exploreCall.args,
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_name: exploreCall.name,
      content: exploreResult.snapshot.trim(),
    });
    return {
      handled: true,
      exploreCallsUsed: exploreCallsUsed + 1,
      searchCallsUsed,
    };
  }

  if (
    configuredSupportsTools &&
    searchCall &&
    hooks?.callSearchTool &&
    searchCallsUsed < MAX_AGENT_SEARCH_CALLS
  ) {
    const searchResult = await hooks.callSearchTool(
      searchCall.name,
      searchCall.args,
    );
    messages.push({
      role: "assistant",
      content: rawResponse,
      tool_calls: [
        {
          function: {
            name: searchCall.name,
            arguments: searchCall.args,
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_name: searchCall.name,
      content: searchResult.isError
        ? `[tokensave error]: ${searchResult.errorMessage ?? "unknown error"}`
        : formatMcpData(searchResult.data),
    });
    return {
      handled: true,
      exploreCallsUsed,
      searchCallsUsed: searchCallsUsed + 1,
    };
  }

  return { handled: false, exploreCallsUsed, searchCallsUsed };
};

/**
 * Result of evaluating a planning response for validation gaps.
 *
 * @remarks
 * Captures whether the response passes validation and provides a summary of
 * any gaps found (verification, commands, etc.). Used to decide whether to
 * re-prompt the model for a revision.
 */
type PlanGapEvaluation = {
  /** Whether the response has any validation gaps that require revision. */
  hasValidationGaps: boolean;
  /** Human-readable summary of detected gaps. */
  gapSummary: string;
  /** Detailed analysis of command plan gaps (see, e.g., parseCommandPlanGaps). */
  commandGaps: { hasGaps: boolean; missingSummary: string };
};

/**
 * Evaluates a planning response for validation gaps and missing components.
 *
 * @remarks
 * Checks the `<agent-think>` block for:
 * - Missing verification statements in VERIFY PLAN section
 * - Missing COMMAND PLAN section or verify commands
 * - (Informational only) parallelism gaps between declared mode and dependsOn structure
 *
 * Parallelism gaps are logged but do NOT trigger re-prompts — the model's
 * declared execution strategy is trusted as is.
 *
 * @param thinkText - Extracted agent-think block content (if available).
 * @param rawResponse - Raw model response (used as fallback).
 * @param planCall - Parsed submit_plan tool call (if present).
 * @returns Evaluation result with flags and summaries for detected gaps.
 */
const evaluatePlanGaps = (
  thinkText: string | null,
  rawResponse: string,
  planCall: ParsedToolCall | undefined,
): PlanGapEvaluation => {
  const verificationGaps = thinkText
    ? parseVerifyGaps(thinkText)
    : {
        hasGaps: true,
        missingSummary: "missing agent-think block",
      };

  const commandGaps = thinkText
    ? parseCommandPlanGaps(thinkText)
    : {
        hasGaps: true,
        missingSummary: "missing COMMAND PLAN",
      };

  // Validate parallelism: declared execution mode vs dependsOn structure
  let parallelismGaps = { hasGaps: false, missingSummary: "" };
  if (thinkText) {
    let probedJson: unknown = planCall?.args ?? null;
    if (probedJson === null) {
      probedJson = tryParseAgentJson(rawResponse);
    }
    if (probedJson !== null) {
      parallelismGaps = parseParallelismGaps(thinkText, probedJson);
    }
  }

  // Note: parallelismGaps computed for logging but NOT used to trigger re-prompts
  // — we trust the subsubagent model's judgment on execution mode
  const hasValidationGaps = verificationGaps.hasGaps || commandGaps.hasGaps;
  const gapSummary = [
    verificationGaps.missingSummary,
    commandGaps.missingSummary,
  ]
    .filter((summary) => summary.length > 0)
    .join("; ");

  return { hasValidationGaps, gapSummary, commandGaps };
};

/**
 * Builds a fallback plan from numbered plan-step lines when JSON parsing fails.
 *
 * @remarks
 * Used when the model's response cannot be parsed as JSON but its `<agent-think>`
 * (or `<think>`) block contains a numbered PLAN section. Returns `null` when no
 * usable plan lines are found, letting the caller fall back further (retry or fail).
 *
 * @param thinkTextForPlan - Think text to extract plan lines from (agent-think, think, or cleaned response).
 * @param maxSubagents - Max agent constraint to apply to the derived plan.
 * @returns A plan built from the numbered lines, or `null` if none were found.
 */
const buildPlanFromThinkBlock = (
  thinkTextForPlan: string | null,
  maxSubagents: MaxSubagentsParam,
): SubagentPlan | null => {
  if (!thinkTextForPlan) {
    return null;
  }
  const planLines = parsePlanLines(thinkTextForPlan);
  if (planLines.length === 0) {
    return null;
  }
  const planSubtasks = buildPlanFromLines(planLines, maxSubagents);
  return applyMaxAgentsConstraint(
    {
      subtasks: planSubtasks,
      risks: [],
      commandPlan: emptyCommandPlan(),
      execution: deriveExecution(planSubtasks),
      agentCount: new Set(planSubtasks.map((subtask) => subtask.agentId)).size,
    },
    maxSubagents,
  );
};

/**
 * Attaches parsed risks/command plan to an accepted plan and applies the review hook.
 *
 * @remarks
 * Fills in `risks` and `commandPlan` from the think block, adds a generic warning
 * when the plan was never fully verified, then (if `hooks.reviewPlan` is provided)
 * awaits user review. Throws {@link TaskSkippedError} on "skip" and
 * {@link PlanRevisionRequestedError} on "edit" — both propagate out of `Agent.plan()`
 * uncaught, by design, so the caller can react to the user's decision.
 *
 * @param agentPlan - The plan to finalize (mutated in place with risks/commandPlan).
 * @param lastRiskList - Risks parsed from the most recent think block.
 * @param lastCommandPlan - Command plan parsed from the most recent think block.
 * @param planUnverified - Whether the plan reached this point without passing all gap checks.
 * @param hooks - Optional lifecycle hooks; only `reviewPlan` is used here.
 * @param maxSubagents - Max agent constraint to apply after review.
 * @returns The finalized plan, or a plan with `max_agents` re-applied after edit-free review.
 * @throws {TaskSkippedError} When the review hook returns a "skip" decision.
 * @throws {PlanRevisionRequestedError} When the review hook returns an "edit" decision.
 */
const attachMetadataAndReview = async (
  agentPlan: SubagentPlan,
  lastRiskList: string[],
  lastCommandPlan: CommandPlan,
  planUnverified: boolean,
  hooks: SubagentPlanHooks | undefined,
  maxSubagents: MaxSubagentsParam,
): Promise<SubagentPlan> => {
  agentPlan.risks = lastRiskList.length > 0 ? lastRiskList : agentPlan.risks;
  agentPlan.commandPlan = lastCommandPlan;

  if (planUnverified && agentPlan.risks.length === 0) {
    agentPlan.risks = [
      "Plan may be incomplete — verification did not pass all checks.",
    ];
  }

  if (!hooks?.reviewPlan) {
    return agentPlan;
  }

  const reviewResponse = await hooks.reviewPlan(agentPlan);
  if (reviewResponse.decision === "skip") {
    throw new TaskSkippedError();
  }
  if (reviewResponse.decision === "edit") {
    // Not applied here — the caller catches this and re-invokes plan()
    // with the user's feedback folded into the task text.
    throw new PlanRevisionRequestedError(reviewResponse.feedback ?? "");
  }

  return applyMaxAgentsConstraint(agentPlan, maxSubagents);
};

/**
 * Appends the model's turn to the message history, preserving its tool call if present.
 *
 * @remarks
 * Mutates `messages` in place, mirroring the mutate-in-place style already used by
 * {@link handleAuxiliaryToolCall}. When `planCall` is present, the assistant turn
 * carries a `tool_calls` entry so the conversation stays consistent with native
 * tool-calling transcripts; otherwise it's a plain assistant content turn.
 *
 * @param messages - Message array to append to (mutated in place).
 * @param rawResponse - The model's raw response text for this turn.
 * @param planCall - The parsed submit_plan tool call for this turn, if present.
 */
const pushAssistantTurn = (
  messages: Message[],
  rawResponse: string,
  planCall: ParsedToolCall | undefined,
): void => {
  if (planCall) {
    messages.push({
      role: "assistant",
      content: rawResponse,
      tool_calls: [
        {
          function: {
            name: planCall.name,
            arguments: planCall.args,
          },
        },
      ],
    });
    return;
  }
  messages.push({ role: "assistant", content: rawResponse });
};

/**
 * Outcome of {@link resolvePlanAttempt}: either an accepted plan, a request to
 * retry the current planning iteration, or a terminal failure.
 *
 * @remarks
 * Mirrors the `handleAuxiliaryToolCall` → `AuxiliaryToolOutcome` shape already
 * used in this file — a per-iteration decision function returning a small
 * discriminated result for the loop to switch on.
 */
type PlanAttemptOutcome =
  | { outcome: "accepted"; plan: SubagentPlan }
  | { outcome: "retry"; updatedVerificationAttempt: number }
  | { outcome: "failed"; error: ValidationError };

/**
 * Resolves one planning turn's raw response into an accepted plan, a retry, or a failure.
 *
 * @remarks
 * Attempts, in order: the parsed `submit_plan` tool call args, then JSON extracted
 * from the raw response text, then a plan built from numbered PLAN lines in the
 * think block. If none produce a usable plan and retry attempts remain, appends a
 * corrective user turn and requests a retry. If attempts are exhausted, logs
 * diagnostic detail and returns a terminal {@link ValidationError}.
 *
 * Mutates `messages` in place (via `pushAssistantTurn`) only on the retry path,
 * matching how the model's turn is normally appended before a follow-up prompt.
 *
 * @param messages - Message array to append the assistant/retry turn to on retry (mutated in place).
 * @param rawResponse - The model's raw response text for this turn.
 * @param configuredSupportsTools - Whether native tool calling is available (affects recovery wording).
 * @param planCall - Parsed submit_plan tool call for this turn, if present.
 * @param thinkText - Extracted `<agent-think>` block content, if present (used for debug logging).
 * @param thinkTextForPlan - Think text to use for the plan-line fallback (agent-think, think, or cleaned response).
 * @param verificationAttempt - Current retry attempt count for this call to `plan()`.
 * @param agentModel - Model identifier, used in error messages and debug logs.
 * @param maxSubagents - Max agent constraint to apply to any derived plan.
 * @returns An accepted plan, a retry request with the incremented attempt count, or a failure.
 */
const resolvePlanAttempt = (
  messages: Message[],
  rawResponse: string,
  configuredSupportsTools: boolean,
  planCall: ParsedToolCall | undefined,
  thinkText: string | null,
  thinkTextForPlan: string | null,
  verificationAttempt: number,
  agentModel: string,
  maxSubagents: MaxSubagentsParam,
): PlanAttemptOutcome => {
  let parsedPlan: unknown | null = planCall ? planCall.args : null;
  if (parsedPlan === null) {
    parsedPlan = tryParseAgentJson(rawResponse);
  }

  if (parsedPlan === null) {
    const planFromThink = buildPlanFromThinkBlock(thinkTextForPlan, maxSubagents);
    if (planFromThink) {
      return { outcome: "accepted", plan: planFromThink };
    }

    if (verificationAttempt < MAX_AGENT_LOOPS - 1) {
      pushAssistantTurn(messages, rawResponse, planCall);
      messages.push({
        role: "user",
        content: looksLikeConversationalReply(rawResponse)
          ? formatOnlyRecoveryMessage(configuredSupportsTools)
          : "You must call submit_plan with your subtask breakdown after your <agent-think> block.",
      });
      return {
        outcome: "retry",
        updatedVerificationAttempt: verificationAttempt + 1,
      };
    }

    logger.debug(
      {
        agentModel,
        configuredSupportsTools,
        rawResponse: rawResponse.slice(0, 4000),
        thinkText: thinkText?.slice(0, 2000) ?? null,
      },
      "Agent returned invalid plan JSON (no parseable plan)",
    );
    return {
      outcome: "failed",
      error: new ValidationError(
        agentPlanFailureMessage(agentModel, rawResponse),
      ),
    };
  }

  try {
    const validatedPlan = normaliseSubagentPlan(parsedPlan, maxSubagents);
    return { outcome: "accepted", plan: validatedPlan };
  } catch (normaliseError) {
    const planFromThink = buildPlanFromThinkBlock(thinkTextForPlan, maxSubagents);
    if (planFromThink) {
      return { outcome: "accepted", plan: planFromThink };
    }

    if (verificationAttempt < MAX_AGENT_LOOPS - 1) {
      pushAssistantTurn(messages, rawResponse, planCall);
      messages.push({
        role: "user",
        content:
          "Your submit_plan arguments were invalid. Output a corrected <agent-think> block and call submit_plan with valid subtasks.",
      });
      return {
        outcome: "retry",
        updatedVerificationAttempt: verificationAttempt + 1,
      };
    }

    logger.debug(
      {
        agentModel,
        configuredSupportsTools,
        rawResponse: rawResponse.slice(0, 4000),
        thinkText: thinkText?.slice(0, 2000) ?? null,
        parsedPlan,
        normaliseError:
          normaliseError instanceof Error
            ? normaliseError.message
            : String(normaliseError),
      },
      "Agent returned invalid plan JSON (normalise failed, no think fallback)",
    );
    return {
      outcome: "failed",
      error: new ValidationError(
        agentPlanFailureMessage(agentModel, rawResponse),
      ),
    };
  }
};

/**
 * Orchestrates task planning, escalation guidance, and result synthesis.
 *
 * @remarks
 * The Agent class is the primary coordinator that:
 * - Decomposes user tasks into executable DAG plans (via `plan()`)
 * - Provides blocking guidance when worker subagents escalate (via `advise()`)
 * - Synthesizes multi-subtask results into a final user-facing answer (via `combine()`)
 *
 * It uses a specialized Ollama model configured for reasoning and planning, not execution.
 */
export class Agent {
  /**
   * Creates a new Agent instance with required dependencies.
   *
   * @param dependencies - Ollama client for inference and config manager for settings.
   */
  constructor(
    private readonly dependencies: {
      /** Ollama HTTP client for chat completions. */
      ollama: IOllamaClient;
      /** Config manager providing model names and temperatures. */
      config: IConfigManager;
    },
  ) {}

  /**
   * Produces a validated Directed Acyclic Graph (DAG) of subtasks from an Ollama planning call.
   *
   * @remarks
   * Executes a verification loop (up to MAX_AGENT_LOOPS iterations) that:
   * 1. Calls the agent model with system prompt, context, skill, and user task.
   * 2. Parses the `<agent-think>` block and validates for gaps (verification, commands, structure).
   * 3. Parses JSON output (or falls back to think-block-based plan).
   * 4. Re-prompts if gaps detected and retries remain; otherwise accepts the plan.
   * 5. Normalizes the plan (coerce shapes, validate DAG, apply max_agents constraint).
   * 6. Optionally invokes the `reviewPlan` hook for user approval/edits.
   *
   * The method respects per-call tool budgets (explore, search) and handles both
   * native tool calling and text-based modes.
   *
   * @param task - User task description for planning.
   * @param contextHeader - Memory/preference context to inject (may be empty).
   * @param skillContent - Selected skill guidance (may be empty).
   * @param overrides - Optional per-task model, temperature, and tool-support overrides.
   * @param hooks - Optional lifecycle hooks: `onThink` for logging, `reviewPlan` for approval,
   *   `exploreCodebase` for workspace structure, `callSearchTool` for TokenSave searches.
   * @param maxSubagents - Maximum agent count constraint (default 3).
   * @returns Normalized and validated SubagentPlan ready for execution.
   * @throws {ValidationError} When JSON parsing fails after all retries or plan structure is invalid.
   * @throws {OrchestrationError} When maximum verification loops are exhausted without success.
   * @throws {TaskSkippedError} When the user skips the task at review.
   * @throws {PlanRevisionRequestedError} When the user edits the plan at review (caller should re-invoke with updated task).
   *
   * @example
   * ```ts
   * const plan = await agent.plan(
   *   "Refactor the login component",
   *   contextHeader,
   *   skillContent,
   *   undefined,
   *   { reviewPlan: async (p) => ({ decision: "implement" }) }
   * );
   * // Returns validated plan with subtasks, risks, command checks, and execution strategy
   * ```
   */
  plan = async (
    task: string,
    contextHeader: string,
    skillContent: string,
    overrides?: TaskModelOverrides,
    hooks?: SubagentPlanHooks,
    maxSubagents: MaxSubagentsParam = 3,
  ): Promise<SubagentPlan> => {
    // Step 1: Read agent model and temperature from IConfigManager
    const { agentModel, agentTemperature, configuredSupportsTools } =
      await resolvePlanningConfig(this.dependencies.config, overrides);

    // Step 2: Build system text: skill content, memory context header, then PLANNING_INSTRUCTION
    const systemText = buildPlanningSystemText(
      skillContent,
      contextHeader,
      hooks,
      configuredSupportsTools,
      maxSubagents,
    );

    // Step 3: Send user message with the original task text
    const messages: Message[] = [
      { role: "system", content: systemText },
      { role: "user", content: task },
    ];

    // Track state across verification loop iterations
    let lastRiskList: string[] = [];
    let lastCommandPlan: CommandPlan = emptyCommandPlan();
    let planUnverified = false;

    let searchCallsUsed = 0;
    let exploreCallsUsed = 0;
    let verificationAttempt = 0;

    for (
      let iteration = 0;
      iteration < MAX_AGENT_TOTAL_ITERATIONS;
      iteration += 1
    ) {
      const planningTools = buildPlanningTools(
        configuredSupportsTools,
        hooks,
        exploreCallsUsed,
        searchCallsUsed,
      );

      let rawResponse = "";
      let exploreCall: ParsedToolCall | undefined;
      let searchCall: ParsedToolCall | undefined;
      let planCall: ParsedToolCall | undefined;

      if (configuredSupportsTools) {
        const agentResult = await this.dependencies.ollama.chatWithTools(
          agentModel,
          messages,
          planningTools,
          { temperature: agentTemperature, includeThinking: true },
        );
        rawResponse = agentResult.content || agentResult.thinking;
        planCall = agentResult.toolCalls.find(
          (toolCall) => toolCall.name === SUBMIT_PLAN_TOOL_NAME,
        );
        exploreCall = agentResult.toolCalls.find((toolCall) =>
          isExploreCodebaseTool(toolCall.name),
        );
        searchCall = agentResult.toolCalls.find((toolCall) =>
          isAgentSearchToolName(toolCall.name),
        );
      } else {
        for await (const token of this.dependencies.ollama.chatStream(
          agentModel,
          messages,
          { temperature: agentTemperature, includeThinking: true },
        )) {
          rawResponse += token;
        }
      }

      const auxOutcome = await handleAuxiliaryToolCall(
        messages,
        rawResponse,
        configuredSupportsTools,
        exploreCall,
        searchCall,
        hooks,
        exploreCallsUsed,
        searchCallsUsed,
      );
      exploreCallsUsed = auxOutcome.exploreCallsUsed;
      searchCallsUsed = auxOutcome.searchCallsUsed;
      if (auxOutcome.handled) {
        continue;
      }

      // Step 5: Parse think block from the response
      const thinkText = extractAgentThink(rawResponse);
      const thinkTextForPlan = extractThinkTextForPlan(rawResponse);
      if (thinkText) {
        lastRiskList = parseRisks(thinkText);
        lastCommandPlan = parseCommandPlan(thinkText);
        // Call onThink hook if provided
        hooks?.onThink?.(thinkText);
      }

      const { hasValidationGaps, gapSummary, commandGaps } = evaluatePlanGaps(
        thinkText,
        rawResponse,
        planCall,
      );

      // Step 6: If gaps exist and we have retries left, prompt model to revise
      if (hasValidationGaps && verificationAttempt < MAX_AGENT_LOOPS - 1) {
        messages.push({ role: "assistant", content: rawResponse });
        const commandHint = commandGaps.hasGaps
          ? " Your COMMAND PLAN is incomplete. List concrete verify commands for this repo."
          : "";
        messages.push({
          role: "user",
          content: revisionFollowUpMessage(
            gapSummary,
            commandHint,
            configuredSupportsTools,
          ),
        });
        verificationAttempt += 1;
        continue;
      }

      // Mark plan as unverified if gaps exist on final iteration
      if (hasValidationGaps) {
        planUnverified = true;
      }

      const resolution = resolvePlanAttempt(
        messages,
        rawResponse,
        configuredSupportsTools,
        planCall,
        thinkText,
        thinkTextForPlan,
        verificationAttempt,
        agentModel,
        maxSubagents,
      );

      if (resolution.outcome === "retry") {
        verificationAttempt = resolution.updatedVerificationAttempt;
        continue;
      }
      if (resolution.outcome === "failed") {
        throw resolution.error;
      }

      // Step 7: Apply max_agents constraint and return validated plan
      return attachMetadataAndReview(
        resolution.plan,
        lastRiskList,
        lastCommandPlan,
        planUnverified,
        hooks,
        maxSubagents,
      );
    }

    // Step 8: If all loops exhausted without success, throw error
    throw new OrchestrationError(
      "Agent planning failed after maximum verification loops",
    );
  };

  /**
   * Provides blocking guidance to a worker subagent that has escalated.
   *
   * @remarks
   * Called when a worker subagent hits an issue it cannot resolve and calls ESCALATE.
   * This method generates targeted guidance from the lead agent by:
   * 1. Formatting the escalation reason and conversation history into a readable transcript.
   * 2. Calling the agent model with context about the stuck subtask and prior attempts.
   * 3. Returning concise, actionable guidance for the subagent to use.
   *
   * This is a blocking operation — the subagent waits for guidance before retrying.
   *
   * @param subtask - The text of the subtask the subagent was executing when it escalated.
   * @param reason - The escalation reason (text following the ESCALATE signal).
   * @param history - Message history showing the subagent's prior attempts.
   * @param overrides - Optional per-task model/temperature overrides.
   * @returns Concise guidance text for the subagent to incorporate and retry.
   *
   * @example
   * ```ts
   * const guidance = await agent.advise(
   *   "Write unit tests for the login module",
   *   "Test framework not installed; unclear which to use",
   *   conversationHistory
   * );
   * // Returns e.g.: "Install Jest: npm install --save-dev jest. See package.json for scripts."
   * ```
   */
  advise = async (
    subtask: string,
    reason: string,
    history: Message[],
    overrides?: TaskModelOverrides,
  ): Promise<string> => {
    const { agentModel, agentTemperature } =
      await resolveModelAndTemperature(this.dependencies.config, overrides);

    // Flatten the agent's message list so the agent sees the whole attempt in one user blob
    const conversationTranscript = history
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n");

    const userPromptContent = `The agent is stuck on this subtask:\n${subtask}\n\nReason for escalation:\n${reason}\n\nConversation so far:\n${conversationTranscript}\n\nReply with concise actionable guidance for the agent's next attempt. Do not repeat the ESCALATE protocol.`;

    const agentMessages: Message[] = [
      {
        role: "system",
        content:
          "You are a senior technical agent helping a coding agent unblock. Be direct and specific.",
      },
      { role: "user", content: userPromptContent },
    ];

    // Blocking: the agent waits on this before appending guidance and retrying chatStream
    return this.dependencies.ollama.chat(agentModel, agentMessages, {
      temperature: agentTemperature,
    });
  };

  /**
   * Streams a final user-facing answer that integrates subtask results with the original task.
   *
   * @remarks
   * Used when multiple subtasks were executed and need to be synthesized into one coherent answer.
   * Streams tokens as they arrive, enabling real-time output to the client. For single-subtask
   * plans, this method is often skipped (the subtask result is returned directly instead).
   *
   * @param originalTask - The original user task description for context.
   * @param results - Array of completed subtask results in display order.
   * @param overrides - Optional per-task model/temperature overrides.
   * @returns Async generator yielding response tokens for streaming to the client.
   *
   * @example
   * ```ts
   * for await (const token of agent.combine(userTask, subtaskResults)) {
   *   process.stdout.write(token);
   * }
   * // Streams the integrated final answer
   * ```
   */
  async *combine(
    originalTask: string,
    results: SubtaskResult[],
    overrides?: TaskModelOverrides,
  ): AsyncGenerator<string> {
    // combine uses the same model as planning
    const { agentModel, agentTemperature } =
      await resolveModelAndTemperature(this.dependencies.config, overrides);

    // One section per completed subtask so the model can merge / dedupe / summarise
    const resultsBlock = results
      .map((result) => `### Subtask ${result.id}\n${result.content}`)
      .join("\n\n");

    const userPromptContent = `Original task:\n${originalTask}\n\nSubtask results:\n${resultsBlock}\n\nWrite one coherent final answer for the user that integrates the results. Do not mention internal subtask ids unless helpful.`;

    const agentMessages: Message[] = [
      {
        role: "system",
        content:
          "You are the lead assistant delivering the final response to the user based on prior sub-work.",
      },
      { role: "user", content: userPromptContent },
    ];
    // Stream tokens out — AgentOrchestrator forwards these to the client as the only visible output when N>1 subtasks
    for await (const token of this.dependencies.ollama.chatStream(
      agentModel,
      agentMessages,
      {
        temperature: agentTemperature,
      },
    )) {
      yield token;
    }
  }
}
