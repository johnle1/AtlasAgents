/**
 * <Summary>
 * What it does:
 *   Wraps the advisor Ollama role for planning (DAG JSON), blocking guidance
 *   when agents escalate, and streaming synthesis of multi-subtask results.
 *
 * How it fits in the system:
 *   The advisor model is responsible for high-level task decomposition and
 *   coordination. It breaks down user tasks into executable DAG plans of subtasks,
 *   provides guidance when agents escalate, and synthesizes multi-agent results
 *   into a final coherent answer. This class never touches RSocket or TCP directly.
 * </Summary>
 */

import { TaskSkippedError } from "./advisorErrors.js";
import { ValidationError, OrchestrationError } from "../../errors/index.js";
import {
  applyPlanReview,
  buildAdvisorThinkInstruction,
  buildPlanFromLines,
  extractAdvisorThink,
  parseCommandPlan,
  parseCommandPlanGaps,
  parsePlanLines,
  parseRisks,
  parseVerifyGaps,
} from "./advisorThink.js";
import type { MaxAgentsParam } from "../maxAgents.js";
import {
  applyMaxAgentsConstraint,
  deriveExecution,
  validateNoCycles,
} from "../planHelpers.js";
import { extractJsonObject, normaliseAdvisorPlan } from "./advisorHelpers.js";
import type { IConfigManager, IOllamaClient } from "../interfaces.js";
import type {
  AdvisorPlan,
  CommandPlan,
  Message,
  PlannedSubtask,
  PlanReviewResponse,
  SubtaskResult,
  TaskModelOverrides,
} from "../types.js";
import { emptyCommandPlan } from "../types.js";
import { AdvisorPlanHooks, MAX_ADVISOR_LOOPS } from "./advisorConstants.js";

export { TaskSkippedError } from "./advisorErrors.js";

/**
 * <Summary>
 * What it does:
 *   Advisor class that orchestrates task planning, escalation guidance, and result synthesis.
 *
 * How it fits in the system:
 *   The advisor is the "lead" AI model that decomposes user tasks into executable plans,
 *   provides guidance when worker agents get stuck, and synthesizes results from multiple
 *   agent executions into a final answer. It uses a specialized Ollama model configured
 *   for planning and coordination rather than execution.
 * </Summary>
 */
export class Advisor {
  /**
   * Constructor
   *
   * How it does it (step by step):
   *   1. Store dependencies (ollama client and config manager) as private readonly fields.
   *
   * @param deps - Collaborators for model IO and settings.
   */
  constructor(
    private readonly dependencies: {
      ollama: IOllamaClient;
      config: IConfigManager;
    },
  ) {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Produces a validated Directed Acyclic Graph(DAG) of subtasks as strict JSON from one blocking Ollama call.
   *
   * How it does it (step by step):
   *   1. Reads advisor model and temperature from IConfigManager.
   *   2. Builds system text: skill content, memory context header, then PLANNING_INSTRUCTION.
   *   3. Sends user message with the original task text.
   *   4. Enters verification loop (up to MAX_ADVISOR_LOOPS iterations).
   *   5. For each iteration: parse think block, validate gaps, parse JSON, normalize plan.
   *   6. If gaps or invalid JSON, prompt model to revise and continue loop.
   *   7. Apply max_agents constraint and return validated plan.
   *   8. If all loops exhausted without success, throw error.
   *
   * Parameters:
   *   @param task - Original user task string.
   *   @param contextHeader - Memory context block (may be empty).
   *   @param skillContent - Selected skill file body (may be empty).
   *   @param overrides - Optional model/temperature overrides.
   *   @param hooks - Optional lifecycle hooks for observation.
   *   @param maxAgents - The max_agents constraint.
   *
   * Returns:
   *   @returns Executable subtask DAG.
   *
   * Throws:
   *   @throws {ValidationError} — When JSON is missing or invalid.
   *   @throws {OrchestrationError} — When maximum verification loops exceeded.
   *   @throws {TaskSkippedError} — When user skips task at plan review.
   *
   </Summary>
   */
  plan = async (
    task: string,
    contextHeader: string,
    skillContent: string,
    overrides?: TaskModelOverrides,
    hooks?: AdvisorPlanHooks,
    maxAgents: MaxAgentsParam = 3,
  ): Promise<AdvisorPlan> => {
    // Step 1: Read advisor model and temperature from IConfigManager
    const advisorModel =
      overrides?.advisorModel?.trim() ||
      (await this.dependencies.config.getAdvisorModel());
    const advisorTemperature =
      overrides?.advisorTemp ??
      (await this.dependencies.config.getAdvisorTemperature());

    // Step 2: Build system text: skill content, memory context header, then PLANNING_INSTRUCTION
    const systemParts: string[] = [];
    if (skillContent.trim().length > 0) {
      systemParts.push(skillContent.trim());
    }
    if (contextHeader.trim().length > 0) {
      systemParts.push(contextHeader.trim());
    }
    systemParts.push(buildAdvisorThinkInstruction(maxAgents));
    const systemText = systemParts.join("\n\n");

    // Step 3: Send user message with the original task text
    const messages: Message[] = [
      { role: "system", content: systemText },
      { role: "user", content: task },
    ];

    // Track state across verification loop iterations
    let lastThinkBlock: string | null = null;
    let lastRiskList: string[] = [];
    let lastCommandPlan: CommandPlan = emptyCommandPlan();
    let planUnverified = false;

    // Step 4: Enter verification loop (up to MAX_ADVISOR_LOOPS iterations)
    for (
      let loopIteration = 0;
      loopIteration < MAX_ADVISOR_LOOPS;
      loopIteration += 1
    ) {
      // Call the advisor model
      const rawResponse = await this.dependencies.ollama.chat(
        advisorModel,
        messages,
        { temperature: advisorTemperature },
      );

      // Step 5: Parse think block from the response
      const thinkText = extractAdvisorThink(rawResponse);
      if (thinkText) {
        lastThinkBlock = thinkText;
        lastRiskList = parseRisks(thinkText);
        lastCommandPlan = parseCommandPlan(thinkText);
        // Call onThink hook if provided
        hooks?.onThink?.(thinkText);
      }

      // Validate plan completeness (verify section)
      const verificationGaps = thinkText
        ? parseVerifyGaps(thinkText)
        : {
            hasGaps: true,
            missingSummary: "missing advisor-think block",
          };

      // Validate command plan completeness
      const commandGaps = thinkText
        ? parseCommandPlanGaps(thinkText)
        : {
            hasGaps: true,
            missingSummary: "missing COMMAND PLAN",
          };

      const hasValidationGaps = verificationGaps.hasGaps || commandGaps.hasGaps;
      const gapSummary = [
        verificationGaps.missingSummary,
        commandGaps.missingSummary,
      ]
        .filter((summary) => summary.length > 0)
        .join("; ");

      // Step 6: If gaps exist and we have retries left, prompt model to revise
      if (hasValidationGaps && loopIteration < MAX_ADVISOR_LOOPS - 1) {
        messages.push({ role: "assistant", content: rawResponse });
        const commandHint = commandGaps.hasGaps
          ? " Your COMMAND PLAN is incomplete. List concrete verify commands and off-limits shell command prefixes for this repo."
          : "";
        messages.push({
          role: "user",
          content: `Your plan has gaps. Revise it.\nMissing: ${gapSummary}${commandHint}\nThink again and produce a corrected <advisor-think> block and JSON plan.`,
        });
        continue;
      }

      // Mark plan as unverified if gaps exist on final iteration
      if (hasValidationGaps) {
        planUnverified = true;
      }

      // Helper function to build plan from think block when JSON parsing fails
      const buildPlanFromThinkBlock = (): AdvisorPlan | null => {
        if (!thinkText) {
          return null;
        }
        const planLines = parsePlanLines(thinkText);
        if (planLines.length === 0) {
          return null;
        }
        const planSubtasks = buildPlanFromLines(planLines, maxAgents);
        return applyMaxAgentsConstraint(
          {
            subtasks: planSubtasks,
            risks: [],
            commandPlan: emptyCommandPlan(),
            execution: deriveExecution(planSubtasks),
            agentCount: new Set(planSubtasks.map((subtask) => subtask.agentId))
              .size,
          },
          maxAgents,
        );
      };

      // Helper function to attach metadata and apply review
      const attachMetadataAndReview = async (
        advisorPlan: AdvisorPlan,
      ): Promise<AdvisorPlan> => {
        // Attach parsed risks from think block
        advisorPlan.risks =
          lastRiskList.length > 0 ? lastRiskList : advisorPlan.risks;
        advisorPlan.commandPlan = lastCommandPlan;

        // Add warning if plan is unverified
        if (planUnverified && advisorPlan.risks.length === 0) {
          advisorPlan.risks = [
            "Plan may be incomplete — verification did not pass all checks.",
          ];
        }

        // Skip review if hook not provided
        if (!hooks?.reviewPlan) {
          return advisorPlan;
        }

        // Apply user review if hook provided
        const reviewResponse = await hooks.reviewPlan(advisorPlan);
        if (reviewResponse.decision === "skip") {
          throw new TaskSkippedError();
        }

        return applyMaxAgentsConstraint(
          applyPlanReview(advisorPlan, reviewResponse, maxAgents),
          maxAgents,
        );
      };

      // Extract JSON from response
      const extractedJson = extractJsonObject(rawResponse);

      let parsedPlan: unknown;
      try {
        // Step 5: Parse JSON from the response
        parsedPlan = JSON.parse(extractedJson);
      } catch {
        // If JSON parsing fails, try to build from think block
        const planFromThink = buildPlanFromThinkBlock();
        if (planFromThink) {
          return attachMetadataAndReview(planFromThink);
        }

        // If we have retries left, prompt model to fix JSON
        if (loopIteration < MAX_ADVISOR_LOOPS - 1) {
          messages.push({ role: "assistant", content: rawResponse });
          messages.push({
            role: "user",
            content:
              "Your response did not include valid JSON after </advisor-think>. Output the think block and then ONLY the JSON object.",
          });
          continue;
        }

        // Final iteration with no valid JSON
        throw new ValidationError("Advisor returned invalid plan JSON");
      }

      let validatedPlan: AdvisorPlan;
      try {
        // Normalize and validate the parsed plan
        validatedPlan = normaliseAdvisorPlan(parsedPlan, maxAgents);
      } catch {
        // If normalization fails, try to build from think block
        const planFromThink = buildPlanFromThinkBlock();
        if (!planFromThink) {
          if (loopIteration < MAX_ADVISOR_LOOPS - 1) {
            messages.push({ role: "assistant", content: rawResponse });
            messages.push({
              role: "user",
              content:
                "Your JSON plan was invalid. Output a corrected <advisor-think> block and valid JSON subtasks.",
            });
            continue;
          }
          throw new ValidationError("Advisor returned invalid plan JSON");
        }
        validatedPlan = planFromThink;
      }

      // Step 7: Apply max_agents constraint and return validated plan
      return attachMetadataAndReview(validatedPlan);
    }

    // Step 8: If all loops exhausted without success, throw error
    throw new OrchestrationError(
      "Advisor planning failed after maximum verification loops",
    );
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns a short natural-language hint for an agent that escalated with ESCALATE.
   *
   * How it does it (step by step):
   *   1. Reads advisor model and temperature from config.
   *   2. Serialises message history into a readable transcript for the prompt.
   *   3. Calls blocking Ollama chat with task, reason, and transcript.
   *   4. Returns the guidance text for the agent to use.
   *
   * Parameters:
   *   @param subtask - The subtask the agent was executing.
   *   @param reason - Text after the ESCALATE: prefix.
   *   @param history - Conversation turns built by the agent so far.
   *   @param overrides - Optional model/temperature overrides.
   *
   * Returns:
   *   @returns Guidance to append as a new user turn.
   *
   </Summary>
   */
  advise = async (
    subtask: string,
    reason: string,
    history: Message[],
    overrides?: TaskModelOverrides,
  ): Promise<string> => {
    // Step 1: Read advisor model and temperature from config
    const advisorModel =
      overrides?.advisorModel?.trim() ||
      (await this.dependencies.config.getAdvisorModel());
    const advisorTemperature =
      overrides?.advisorTemp ??
      (await this.dependencies.config.getAdvisorTemperature());

    // Step 2: Serialise message history into a readable transcript for the prompt
    // Flatten the agent's message list so the advisor sees the whole attempt in one user blob
    const conversationTranscript = history
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n");

    const userPromptContent = `The agent is stuck on this subtask:\n${subtask}\n\nReason for escalation:\n${reason}\n\nConversation so far:\n${conversationTranscript}\n\nReply with concise actionable guidance for the agent's next attempt. Do not repeat the ESCALATE protocol.`;

    const advisoryMessages: Message[] = [
      {
        role: "system",
        content:
          "You are a senior technical advisor helping a coding agent unblock. Be direct and specific.",
      },
      { role: "user", content: userPromptContent },
    ];

    // Step 3: Call blocking Ollama chat with task, reason, and transcript
    // Step 4: Return the guidance text for the agent to use
    // Blocking: the agent waits on this before appending guidance and retrying chatStream
    return this.dependencies.ollama.chat(advisorModel, advisoryMessages, {
      temperature: advisorTemperature,
    });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Streams a final user-facing answer that merges the original task with all subtask results.
   *
   * How it does it (step by step):
   *   1. Reads advisor model from config (combine uses same model as planning).
   *   2. Builds a user message listing each subtask id and its result body.
   *   3. Streams Ollama chat tokens and yields each chunk to the caller.
   *
   * Parameters:
   *   @param originalTask - User's top-level task string.
   *   @param results - Completed subtask outputs in display order.
   *
   * Returns:
   *   @returns Token strings for the client stream.
   * </Summary>
   */
  async *combine(
    originalTask: string,
    results: SubtaskResult[],
    overrides?: TaskModelOverrides,
  ): AsyncGenerator<string> {
    // Step 1: Read advisor model from config (combine uses same model as planning)
    const advisorModel =
      overrides?.advisorModel?.trim() ||
      (await this.dependencies.config.getAdvisorModel());
    const advisorTemperature =
      overrides?.advisorTemp ??
      (await this.dependencies.config.getAdvisorTemperature());

    // Step 2: Build a user message listing each subtask id and its result body
    // One section per completed subtask so the model can merge / dedupe / summarise
    const resultsBlock = results
      .map((result) => `### Subtask ${result.id}\n${result.content}`)
      .join("\n\n");

    const userPromptContent = `Original task:\n${originalTask}\n\nSubtask results:\n${resultsBlock}\n\nWrite one coherent final answer for the user that integrates the results. Do not mention internal subtask ids unless helpful.`;

    const advisoryMessages: Message[] = [
      {
        role: "system",
        content:
          "You are the lead assistant delivering the final response to the user based on prior sub-work.",
      },
      { role: "user", content: userPromptContent },
    ];
    // Step 3: Stream Ollama chat tokens and yield each chunk to the caller
    // Stream tokens out — AdvisorOrchestrator forwards these to the client as the only visible output when N>1 subtasks
    for await (const token of this.dependencies.ollama.chatStream(
      advisorModel,
      advisoryMessages,
      {
        temperature: advisorTemperature,
      },
    )) {
      yield token;
    }
  }
}
