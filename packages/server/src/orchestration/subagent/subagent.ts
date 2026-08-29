/**
 * Orchestrates subagent task execution with tool calling, retry logic, and escalation.
 *
 * @remarks
 * This module implements a complete agent loop:
 * 1. Build initial messages (subtask, skills, prior context, command plan)
 * 2. Fetch model response (native tool mode or text-based fallback)
 * 3. Parse tool calls and extract thinking
 * 4. Retry on format errors (malformed JSON, missing thinking, etc.)
 * 5. Execute tools, collect feedback, append to history
 * 6. Escalate to lead agent if retry budget exhausted
 * 7. Return final summary when done or iteration limit hit
 *
 * The agent enforces mandatory thinking (planning before action), accepts only one
 * tool per turn, and recovers gracefully from recoverable errors (malformed JSON).
 *
 * Not currently constructed by the default pipeline — the unified agent
 * turn (`agentTurn.ts`) completes every concurrent `run_steps_parallel`
 * step through its own loop instead, with no separate persona or
 * escalation ceremony (see `runToolCallLoop`). This class remains as a
 * tested, documented extension point for a caller that wants that
 * heavier ceremony (mandatory thinking, retry-then-escalate) for a
 * distinct worker role.
 *
 * @example
 * ```ts
 * const subagent = new Subagent({ ollama, config, agent });
 * const result = await subagent.run({
 *   taskId: "task-123",
 *   subtask: "Implement OAuth login flow",
 *   agentId: 1,
 *   agentLabel: "CodeWorker",
 *   skillContent: "OAuth patterns in this codebase...",
 *   sessionContext: "Previous steps: set up database schema",
 *   workspace,
 *   terminal,
 *   recorder,
 *   emit,
 *   signal,
 * });
 * console.log(result.summary); // "OAuth flow implemented and tested"
 * ```
 */

import type { Agent } from "../agent/agent.js";
import { hasCommandPlanSection } from "../commandClassifier.js";
import type {
  IConfigManager,
  IExperienceRecorder,
  IOllamaClient,
} from "../interfaces.js";
import type {
  CommandPlan,
  Message,
  TaskModelOverrides,
  ToolResultSummary,
} from "../types.js";
import { emptyCommandPlan } from "../types.js";
import type { ToolExecutionResult } from "../tools/types.js";
import {
  extractThinking,
  parseAllToolCalls,
  recoverFinishFromThink,
  recoverToolCallFromThink,
  stripMarkdownFencesFromText,
  THINK_BLOCK,
  TOOL_END,
  TOOL_START,
  type ParsedToolCall,
} from "../toolProtocol.js";
import { createThinkFrameEmitter, createThinkTagScanner } from "../thinkStream.js";
import type { ThinkTagScanner } from "../thinkStream.js";
import type { TaskFrame } from "../../transport/frames.js";
import type { TerminalExecutor } from "../../workspace/execution/terminalExecutor.js";
import type { WorkspaceManager } from "../../workspace/manager/workspaceManager.js";
import {
  createToolRegistry,
  getToolHandlerMap,
  getToolSchemas,
} from "../tools/registry.js";
import type { ToolHandler, ToolHandlerContext } from "../tools/types.js";
import type { ToolSchema } from "../tools/types.js";
import { buildAgentMessages } from "./subagentMessageBuilder.js";
import { handleAgentRetry } from "./subagentRetryHandler.js";
import type {
  AgentRunParams,
  ChatResult,
  SubagentConfig,
  TaskTrackers,
} from "./types.js";
import { AbortError } from "../../errors/index.js";
import { logger } from "../../utils/logger.js";

/**
 * Maximum iterations to prevent infinite tool loops in a single task.
 *
 * @remarks
 * If an agent reaches this limit, it's either stuck or the task is too complex.
 * The orchestrator can abort earlier via AbortSignal based on policy. This value
 * is a safety ceiling, not a target — most tasks complete in < 20 iterations.
 */
const MAX_TOOL_ITERATIONS = 300;

/**
 * Consecutive turns without a successful tool call before the run is killed.
 *
 * @remarks
 * `MAX_TOOL_ITERATIONS` is a ceiling for *productive* work; this is the
 * stagnation breaker. A weak model can loop on "think, but never emit a real
 * tool call" indefinitely — every retry/escalation path in `runIteration`
 * still costs a full model round trip, so 300 iterations of that can take
 * hours on a slow local model. 8 is chosen so that at the default `retries:
 * 3` (escalation fires roughly every 4th unproductive turn) the run still
 * gets two real escalation attempts before giving up.
 */
const MAX_UNPRODUCTIVE_TURNS = 8;

/**
 * Tools that steer the loop rather than advance the subtask.
 *
 * @remarks
 * Executing one of these does not count as progress for the stagnation
 * breaker: `escalate` has its own budget (see `escalateHandler.ts`), and a
 * *rejected* `finish` (see `finishHandler.ts`) returns `done: false` with
 * corrective feedback — precisely the unproductive-cycle shape the breaker
 * exists to catch, so it must not reset the counter.
 */
const CONTROL_FLOW_TOOLS = new Set(["escalate", "finish"]);

/**
 * Builds the one-line failure summary for a tripped stagnation breaker.
 *
 * @remarks
 * Interpolated into an `OrchestrationError` message downstream, so it stays
 * short and single-line; the truncated last think block gives enough signal
 * to diagnose why the model got stuck without dumping the whole transcript.
 */
const noProgressSummary = (turns: number, lastThink: string | null): string => {
  const tail = lastThink
    ? ` Last think: ${lastThink.replace(/\s+/g, " ").trim().slice(0, 160)}`
    : "";
  return `[agent failed: no progress after ${turns} turns — the model kept thinking without emitting a usable tool call.${tail}]`;
};

/**
 * Logs debug messages only when verbose debugging is enabled.
 *
 * @remarks
 * Reduces clutter in production logs. When `debug` is false, this is a no-op.
 */
const agentDebugLog = (debug: boolean, label: string, data: unknown): void => {
  if (!debug) {
    return;
  }
  logger.debug({ label, data }, "[Agent] debug");
};

/**
 * Formats a tool call as a legacy text-based tool block (for text-mode fallback).
 *
 * @remarks
 * Used when the model doesn't support native tool calling. The format is
 * `<<TOOL>>{JSON}<<END>>` so text parsing can extract the call.
 */
const formatLegacyToolBlock = (call: ParsedToolCall): string =>
  `${TOOL_START}${JSON.stringify({ tool: call.name, ...call.args })}${TOOL_END}`;

/**
 * Resolves effective subagent configuration by merging task overrides with global config.
 *
 * @remarks
 * Task-level overrides (modelOverrides) take precedence over persisted config.
 * This allows orchestrators to fine-tune model/temperature per task without
 * changing global settings. The escalation cap is derived from `configuredMaxRetries`.
 *
 * @param config - Global configuration manager.
 * @param modelOverrides - Optional per-task model/temperature/tool-support overrides.
 * @returns Effective configuration for this run.
 */
const resolveSubagentConfig = async (
  config: IConfigManager,
  modelOverrides: TaskModelOverrides | undefined,
): Promise<SubagentConfig> => {
  const subagentModel =
    modelOverrides?.subagentModel?.trim() ||
    (await config.getSubagentModel());
  const subagentTemperature =
    modelOverrides?.subagentTemp ??
    (await config.getSubagentTemperature());
  const configuredSupportsTools =
    modelOverrides?.subagentModelSupportsTools ??
    (await config.getSubagentModelSupportsTools());
  const configuredMaxRetries = await config.getMaxRetries();
  const maxEscalations = Math.max(1, Math.floor(configuredMaxRetries));
  return {
    subagentModel,
    subagentTemperature,
    configuredSupportsTools,
    maxEscalations,
  };
};

/**
 * Creates fresh per-run tracking state for a new task.
 *
 * @remarks
 * Called once per `run()` to initialize trackers. Survives retries/escalations
 * and is returned in the final result summary for change reporting and analysis.
 */
const createTaskTrackers = (): TaskTrackers => ({
  filesWrittenThisTask: new Set(),
  filesVerifiedThisTask: new Set(),
  filesReadThisTask: new Set(),
  verifyCommandPassed: false,
  completedSetupCommands: new Set(),
  failedCommandAttempts: new Map(),
  firstThinkSeen: false,
  commandPlanRetryUsed: false,
  lastThinkText: null,
  unproductiveTurns: 0,
});

/**
 * Stable, per-run collaboration state shared across loop iterations.
 *
 * @remarks
 * Built once at the start of `run()` and passed to `runIteration` on every
 * loop pass. `messages` and `trackers` are mutable references — mutations
 * inside one iteration are visible to the next — while the remaining fields
 * are effectively read-only for the lifetime of a run. Bundling this state
 * into an explicit object (rather than a closure) makes `runIteration` and
 * `buildToolContext` callable with an arbitrary state snapshot, which is
 * what makes them testable in isolation.
 */
type RunContext = {
  taskId: string;
  subtask: string;
  agentSource: { agentId: number; agentLabel: string };
  emit: (frame: TaskFrame) => void;
  emitSubagentStatus: ToolHandlerContext["emitSubagentStatus"];
  messages: Message[];
  workspace: WorkspaceManager;
  terminal: TerminalExecutor;
  recorder: IExperienceRecorder;
  modelOverrides: TaskModelOverrides | undefined;
  commandPlan: CommandPlan;
  trackers: TaskTrackers;
  toolSchemas: ReturnType<typeof getToolSchemas>;
  subagentModel: string;
  subagentTemperature: number;
  configuredSupportsTools: boolean;
  maxEscalations: number;
  signal: AbortSignal;
  debug: boolean;
};

/**
 * Outcome of a single loop iteration.
 *
 * @remarks
 * `runIteration` no longer owns the loop, so it communicates what happened
 * through a return value instead of `return`/`continue`: either the task is
 * complete (`done: true`, carrying the final result), or the loop should run
 * another pass with the given updated counters (`done: false`).
 */
type IterationOutcome =
  | { done: true; result: ToolResultSummary }
  | { done: false; escalationCount: number; thinkRetryCount: number };

/**
 * Orchestrates a single subtask via tool calling and retry/escalation logic.
 *
 * @remarks
 * The main agent loop:
 * 1. Fetch model response (thinking + tool call)
 * 2. Parse, validate, and check for format errors (malformed JSON, missing thinking)
 * 3. Retry on format errors (with corrective guidance) or escalate if budget exhausted
 * 4. Execute the tool, collect feedback, append to history
 * 5. Loop until the task is done (via finish tool), escalated, or iteration limit hit
 *
 * **Safety constraints:**
 * - Only one tool per turn (models sometimes emit multiple; we reject that)
 * - Mandatory thinking block (required for planning/chain-of-thought)
 * - Escalation when retry budget exhausted (prevents infinite loops)
 * - Command plan enforcement on first think (ensures planning before action)
 *
 * **Design notes:**
 * - Thinking is extracted early (for UI feedback) before tool parsing
 * - Command plan is checked on first think to catch early deviations
 * - Finish tool is recoverable from think text if the model wrote it there
 * - Format errors (JSON, thinking) do not escalate immediately; only budget exhaustion
 *   triggers escalation, allowing a few retries for format corrections
 *
 * @example
 * ```ts
 * const subagent = new Subagent({ ollama, config, agent });
 * const result = await subagent.run({
 *   taskId: "123",
 *   subtask: "Fix the auth bug in src/auth.ts",
 *   agentId: 1,
 *   agentLabel: "CodeWorker",
 *   skillContent: "Auth patterns...",
 *   sessionContext: "Bug: login fails with 401 on first attempt",
 *   workspace, terminal, recorder, emit, signal
 * });
 * console.log(result.ok); // true if task succeeded
 * ```
 */
export class Subagent {
  private readonly toolRegistry: ToolHandler[];
  private readonly toolHandlers: Map<string, ToolHandler>;

  /**
   * Initializes the subagent with dependencies: Ollama client, config, agent, and tools.
   *
   * @remarks
   * The tool registry is built once at construction and reused across multiple runs.
   * Extra tools (if provided) are merged with the standard tool set.
   *
   * @param dependencies.ollama - Ollama HTTP client for model inference.
   * @param dependencies.config - Configuration manager for model/temp/retry settings.
   * @param dependencies.agent - Parent agent (for tool context and agent reference).
   * @param dependencies.extraTools - Optional additional tool schemas to register.
   */
  constructor(
    private readonly dependencies: {
      ollama: IOllamaClient;
      config: IConfigManager;
      agent: Agent;
      extraTools?: ToolSchema[];
      /**
       * Resolved Ollama runtime context window for this task's subagent
       * model (see {@link ContextWindowResolver}). Omitted (or the role
       * isn't on the "ollama" provider) means don't send `num_ctx` at all —
       * the caller (`orchestratorPipeline.ts`) resolves this once per task,
       * not per call, since the model tag is fixed for this instance's
       * lifetime.
       */
      numCtx?: number;
      /** Ollama `keep_alive` duration for this role (see {@link ChatOptions.keepAlive}). */
      keepAlive?: string | number;
    },
  ) {
    this.toolRegistry = createToolRegistry(
      dependencies.agent,
      dependencies.extraTools ?? [],
    );
    this.toolHandlers = getToolHandlerMap(this.toolRegistry);
  }

  /**
   * Runs a single subtask to completion via the agent loop.
   *
   * @remarks
   * Main orchestration loop with retry/escalation. Loops until the task is
   * done (finish tool called), escalated to the lead agent, or iteration
   * limit hit. Emits thinking and status updates via the callback.
   *
   * @param params - Complete task configuration and context.
   * @returns Final summary: what was done, files touched, success status.
   * @throws {@link AbortError} if the orchestrator cancels via AbortSignal.
   */
  run = async (params: AgentRunParams): Promise<ToolResultSummary> => {
    const {
      taskId,
      subtask,
      agentId,
      agentLabel,
      skillContent,
      sessionContext,
      workspace,
      terminal,
      recorder,
      emit,
      signal,
      modelOverrides,
      commandPlan = emptyCommandPlan(),
      debug = false,
    } = params;

    const agentSource = { agentId, agentLabel };
    const toolSchemas = getToolSchemas(this.toolRegistry);

    /**
     * Emits agent status updates to the UI (thinking, reading files, running commands, etc.).
     * The stage and icon tell the UI what activity is happening.
     */
    const emitSubagentStatus = (
      stage:
        | "reading"
        | "writing"
        | "searching"
        | "running"
        | "escalating"
        | "thinking"
        | "done",
      icon: "◌" | "✓" | "⚠",
      statusMessage: string,
    ): void => {
      emit({
        kind: "status",
        source: agentSource,
        stage,
        icon,
        message: statusMessage,
        ...(stage !== "done"
          ? { activity: { stage, message: statusMessage } }
          : {}),
      });
    };

    // Resolve effective config: per-task overrides take precedence over persisted settings.
    // This enables fine-grained model/temp control per subtask without changing global config.
    const {
      subagentModel,
      subagentTemperature,
      configuredSupportsTools,
      maxEscalations,
    } = await resolveSubagentConfig(this.dependencies.config, modelOverrides);

    // Build initial messages with subtask, skill, prior results (sessionContext), and
    // command plan hints. Tool schemas are baked into the prompt for text-based mode.
    const messages = buildAgentMessages(
      subtask,
      skillContent,
      sessionContext,
      commandPlan,
      configuredSupportsTools,
      toolSchemas,
    );

    // Fresh per-run tracking: files touched, command execution state, retry counters.
    // Survives across multiple iterations and is returned in the final summary.
    const trackers: TaskTrackers = createTaskTrackers();

    // Bundle everything an iteration needs into one explicit object instead of
    // relying on closure capture. This is what lets runIteration/buildToolContext
    // be called (and tested) with an arbitrary state snapshot.
    const context: RunContext = {
      taskId,
      subtask,
      agentSource,
      emit,
      emitSubagentStatus,
      messages,
      workspace,
      terminal,
      recorder,
      modelOverrides,
      commandPlan,
      trackers,
      toolSchemas,
      subagentModel,
      subagentTemperature,
      configuredSupportsTools,
      maxEscalations,
      signal,
      debug,
    };

    // Simple counters threaded through each iteration via runIteration's return
    // value. Complex structural state lives on `trackers` instead (see above).
    let escalationCount = 0;
    let thinkRetryCount = 0;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      // Fail fast if orchestrator cancelled this subtask (e.g., downstream failure,
      // user abort, or timeout from pool controller).
      if (signal.aborted) {
        throw new AbortError("Agent execution aborted");
      }

      // STAGNATION BREAKER: checked before the model call so a run that's
      // already stuck doesn't pay for one more inference to learn it's stuck.
      // Unlike thinkRetryCount (threaded per-branch and easy to leave
      // unbumped on a new exit path), unproductiveTurns lives on trackers and
      // is bumped once here for every pass through the loop — so every
      // current and future runIteration exit is covered by construction.
      if (trackers.unproductiveTurns >= MAX_UNPRODUCTIVE_TURNS) {
        logger.warn(
          {
            taskId,
            unproductiveTurns: trackers.unproductiveTurns,
            escalationCount,
            lastThink: trackers.lastThinkText?.replace(/\s+/g, " ").trim().slice(0, 300) ?? null,
          },
          "[Agent] no-progress breaker tripped",
        );
        emitSubagentStatus("done", "⚠", "Stopped: no progress");
        return {
          summary: noProgressSummary(MAX_UNPRODUCTIVE_TURNS, trackers.lastThinkText),
          keyFindings: [],
          filesTouched: [...trackers.filesWrittenThisTask],
          ok: false,
        };
      }
      trackers.unproductiveTurns += 1;

      const outcome = await this.runIteration(
        context,
        iteration,
        escalationCount,
        thinkRetryCount,
      );

      if (outcome.done) {
        return outcome.result;
      }

      escalationCount = outcome.escalationCount;
      thinkRetryCount = outcome.thinkRetryCount;
    }

    // If we exit the loop without returning, the agent hit the iteration limit.
    // This indicates the task is too complex or the agent is stuck.
    logger.warn(
      { taskId, escalationCount, thinkRetryCount },
      "[Agent] exceeded maximum tool iterations",
    );
    return {
      summary: "[agent failed: exceeded maximum tool iterations]",
      keyFindings: [],
      filesTouched: [...trackers.filesWrittenThisTask],
      ok: false,
    };
  };

  /**
   * Runs one turn of the agent loop: fetch a model response, apply retry and
   * escalation rules, and execute at most one tool call.
   *
   * @remarks
   * This is the body of the loop in `run()`, extracted so the per-turn
   * decision logic (retry vs. escalate vs. execute) can be reasoned about —
   * and unit tested — independently of the loop control that surrounds it.
   * Because it no longer owns the loop, it can't use `return`/`continue` to
   * drive iteration; instead it reports what happened via `IterationOutcome`
   * and `run()` decides whether to stop or keep going.
   *
   * @param context - Stable per-run state (messages, trackers, config, etc.).
   * @param iteration - Index of this iteration, used only for debug logging.
   * @param escalationCount - Escalations used so far this run.
   * @param thinkRetryCount - Format-retry attempts used so far this run.
   * @returns `{ done: true, result }` once the task finishes (successfully or
   *   not); otherwise `{ done: false, escalationCount, thinkRetryCount }` with
   *   the counters `run()` should carry into the next iteration.
   */
  private runIteration = async (
    context: RunContext,
    iteration: number,
    escalationCount: number,
    thinkRetryCount: number,
  ): Promise<IterationOutcome> => {
    const { messages, trackers, debug } = context;

    // Let the UI show "thinking" while the model call below is in flight —
    // otherwise the task board goes silent for the whole round trip.
    context.emitSubagentStatus("thinking", "◌", "Thinking…");

    // Streams this iteration's think block to the UI as it arrives. The
    // `finally` below guarantees a stream opened by a partial response
    // before an abort/error still gets a matching close signal — `finish()`
    // is idempotent, so calling it again after the normal close below is a
    // no-op.
    const thinkFrames = createThinkFrameEmitter({
      emit: context.emit,
      agent: false,
      source: context.agentSource,
    });

    try {
      // Fetch one turn from the model (either native tool mode or text-based streaming).
      const chatResult = await this.fetchModelTurn({
        model: context.subagentModel,
        messages,
        toolSchemas: context.toolSchemas,
        supportsTools: context.configuredSupportsTools,
        temperature: context.subagentTemperature,
        signal: context.signal,
        onThinkDelta: (text) => thinkFrames.delta(text),
      });

      // Extract thinking early so we can show it to the user immediately,
      // before we parse/validate tool calls. A model on the native
      // tool-calling path can put its whole <redacted_thinking> block in the
      // separate `thinking` field instead of `content` — try content first
      // (the common case, and what text mode always uses), then fall back to
      // the reasoning channel so that placement doesn't make a real think
      // block look absent and trip the "missing thinking" retry below.
      const thinkText =
        extractThinking(chatResult.content) ??
        extractThinking(chatResult.thinking);
      thinkFrames.finish(
        thinkText ? stripMarkdownFencesFromText(thinkText) : null,
      );
      if (thinkText) {
        trackers.lastThinkText = thinkText;

        // Enforce command plan structure on the FIRST think block.
        // The agent must lay out setup, verify, and off-limits commands before
        // jumping into tool calls. This prevents agents from skipping planning.
        // Retry at most once; if the agent ignores the hint, proceed anyway.
        // (The agent *can* ignore hints, but we want to catch missed planning early.)
        if (!trackers.firstThinkSeen) {
          trackers.firstThinkSeen = true;
          if (
            !hasCommandPlanSection(thinkText) &&
            !trackers.commandPlanRetryUsed
          ) {
            trackers.commandPlanRetryUsed = true;
            messages.push({
              role: "assistant",
              content: chatResult.content,
            });
            messages.push({
              role: "user",
              content:
                "Your first think block must include setup commands, verify commands, and off-limits (run-project) sections before any tool call. List commands as plain lines — never wrap them in markdown code fences.",
            });
            return { done: false, escalationCount, thinkRetryCount };
          }
        }
      }

      let toolCalls = chatResult.toolCalls;
      let hadMalformedToolBlock = chatResult.hadMalformedToolBlock;
      let recoveredToolName: string | null = null;

      // RECOVERY: If the model wrote no tool calls but left a summary in the think block,
      // try to extract a "finish" action from it. Some models naturally write completion
      // summaries in their reasoning instead of JSON. This recovers that output without
      // forcing a retry — users see the summary immediately.
      if (toolCalls.length === 0 && thinkText) {
        const recoveredFinish = recoverFinishFromThink(thinkText);
        if (recoveredFinish) {
          toolCalls = [recoveredFinish];
          hadMalformedToolBlock = false;
          recoveredToolName = "finish";
          agentDebugLog(debug, "recovered finish from think action", {
            summary: recoveredFinish.args.summary,
          });
        } else if (!hadMalformedToolBlock) {
          // Only when the model emitted NO tool block at all — if it emitted
          // a broken one, its actual intent is in that block, and the
          // JSON-repair retry path (handleAgentRetry below) has real signal
          // that should win over a prose guess here.
          const recoveredCall = recoverToolCallFromThink(thinkText);
          if (recoveredCall) {
            toolCalls = [recoveredCall];
            recoveredToolName = recoveredCall.name;
            logger.info(
              {
                taskId: context.taskId,
                tool: recoveredCall.name,
                args: recoveredCall.args,
              },
              "[Agent] synthesized tool call from think block",
            );
            agentDebugLog(
              debug,
              "recovered tool call from think action",
              recoveredCall,
            );
          }
        }
      }

      agentDebugLog(debug, "turn", {
        iteration,
        think: Boolean(thinkText),
        tools: toolCalls.length,
        tool: toolCalls[0]?.name ?? null,
        native: context.configuredSupportsTools,
        malformed: hadMalformedToolBlock,
        recovered: recoveredToolName,
        thinkRetryCount,
        escalationCount,
        unproductiveTurns: trackers.unproductiveTurns,
      });

      // DECISION POINT: Evaluate this turn for retry, escalation, or execution.
      // The retry handler checks for malformed JSON, missing thinking, no tool calls,
      // and whether the retry budget is exhausted (if so, escalate).
      const retryResult = handleAgentRetry(
        chatResult.content,
        thinkText,
        toolCalls.length,
        hadMalformedToolBlock,
        thinkRetryCount,
        context.maxEscalations,
      );

      // RETRY/ESCALATION PATH: Agent output was invalid or incomplete.
      if (retryResult.shouldRetry) {
        if (retryResult.shouldEscalate) {
          // Budget exhausted — ask the lead agent for help.
          // Escalation is synchronous and blocking: the lead agent evaluates the situation,
          // provides guidance (e.g., "try a different approach", "skip this step"),
          // and the worker incorporates that feedback and retries.
          const escalationResult = await this.executeTool(
            {
              name: "escalate",
              args: {
                reason: retryResult.escalationReason ?? "Unknown reason",
              },
            },
            this.buildToolContext(context, escalationCount, thinkText),
          );

          // If the lead agent ran out of escalations too, the task is truly stuck.
          // Return the failure summary.
          if (escalationResult.done) {
            return {
              done: true,
              result: {
                summary: escalationResult.summary,
                keyFindings: [],
                filesTouched: [...trackers.filesWrittenThisTask],
                ok: escalationResult.ok === true,
              },
            };
          }

          // Lead agent provided guidance — append it to history and retry the loop.
          messages.push({ role: "user", content: escalationResult.feedback });
          return {
            done: false,
            escalationCount: escalationResult.escalationCount,
            thinkRetryCount: 0,
          };
        }

        // Simple retry: append corrective feedback (e.g., "invalid JSON", "missing thinking").
        // The agent sees the feedback and tries again with the correction in mind.
        messages.push(...retryResult.updatedMessages);
        return {
          done: false,
          escalationCount,
          thinkRetryCount: retryResult.updatedThinkRetryCount,
        };
      }

      // EXECUTION PATH: Agent output is valid. Prepare to execute the tool call.

      // GUARD: Only one tool per turn. Models sometimes emit multiple calls by accident;
      // we reject that. The agent must call one tool, get feedback, and call the next.
      if (toolCalls.length > 1) {
        messages.push({ role: "assistant", content: chatResult.content });
        messages.push({
          role: "user",
          content:
            "You called more than one tool. Call exactly one tool per turn.",
        });
        return { done: false, escalationCount, thinkRetryCount };
      }

      const toolCall = toolCalls[0];
      if (!toolCall) {
        return { done: false, escalationCount, thinkRetryCount };
      }

      // STAGNATION TRACKING: does this turn count as real progress? `escalate`
      // and `finish` are excluded (own budget / can be rejected-and-retried —
      // see CONTROL_FLOW_TOOLS), and an unrecognized name isn't a tool at all
      // (`executeTool` returns done:false with "Unknown tool: X" feedback for
      // that case, which must not look like progress either).
      const executedRealTool =
        this.toolHandlers.has(toolCall.name) &&
        !CONTROL_FLOW_TOOLS.has(toolCall.name);

      // Execute the tool (file read/write, terminal command, MCP call, finish, etc.).
      // The tool handler returns feedback to append to history and flags (done, escalationCount).
      const toolResult = await this.executeTool(
        toolCall,
        this.buildToolContext(context, escalationCount, thinkText),
      );

      // Check if execution is complete (finish tool called, or escalation limit reached).
      // If so, report the final result so run() can return it.
      if (toolResult.done) {
        return {
          done: true,
          result: {
            summary: toolResult.summary,
            keyFindings: toolResult.keyFindings ?? [],
            filesTouched: [...trackers.filesWrittenThisTask],
            ok: toolResult.ok !== false,
          },
        };
      }

      // Tool executed successfully. Append the tool call and result to the conversation
      // history so the model sees what it did and can adjust for the next turn.
      this.appendToolTurnToHistory(
        messages,
        chatResult.content,
        toolCall,
        toolResult.feedback,
        context.configuredSupportsTools,
      );

      // Reset the retry counter after a successful tool turn.
      // The counter only tracks thinking/parsing retries; successful execution resets it.
      //
      // The stagnation counter resets only for a genuine (non-control-flow)
      // tool call — see `executedRealTool` above. A control-flow tool (or an
      // unrecognized name) reaching here still counts as an unproductive turn.
      if (executedRealTool) {
        trackers.unproductiveTurns = 0;
      }
      return {
        done: false,
        escalationCount: toolResult.escalationCount,
        thinkRetryCount: 0,
      };
    } finally {
      // Safety net for abort/error paths that never reached the explicit
      // finish() above — idempotent, so it's a no-op after a normal close.
      thinkFrames.finish(null);
    }
  };

  /**
   * Builds the context object tool handlers need to execute (workspace,
   * terminal, tracking state, escalation budget, etc.).
   *
   * @remarks
   * Previously a closure defined inside the run loop, capturing over a dozen
   * local variables implicitly. As a method, its inputs are explicit: the
   * stable per-run state plus the two values that actually change turn to
   * turn (`escalationCount`, `thinkText`). This makes it callable outside the
   * loop — e.g. from a test — without reconstructing loop-local closures.
   *
   * @param context - Stable per-run state.
   * @param escalationCount - Current escalation count for this turn.
   * @param thinkText - The current turn's extracted thinking text, if any.
   * @returns Context object satisfying `ToolHandlerContext`, plus `supportsTools`.
   */
  private buildToolContext = (
    context: RunContext,
    escalationCount: number,
    thinkText: string | null,
  ): ToolHandlerContext & { supportsTools: boolean } => ({
    taskId: context.taskId,
    subtask: context.subtask,
    agentSource: context.agentSource,
    emitSubagentStatus: context.emitSubagentStatus,
    messages: context.messages,
    workspace: context.workspace,
    terminal: context.terminal,
    recorder: context.recorder,
    escalationCount,
    maxEscalations: context.maxEscalations,
    modelOverrides: context.modelOverrides,
    trackers: context.trackers,
    thinkText,
    commandPlan: context.commandPlan,
    supportsTools: context.configuredSupportsTools,
  });

  /**
   * Fetches one model inference turn and extracts tool calls.
   *
   * @remarks
   * Two paths depending on model capabilities:
   * - **Native tool calling**: Model returns structured tool calls; no parsing needed.
   * - **Text-based mode**: Stream tokens and parse tool calls from the text.
   *
   * Respects AbortSignal to allow orchestrator-level cancellation (e.g., timeout,
   * downstream failure).
   *
   * @param options.model - Model name/ID (e.g., "gemma3:27b").
   * @param options.messages - Conversation history to send to the model.
   * @param options.toolSchemas - Tool schemas (baked into prompt in text-mode;
   *   passed separately in native mode).
   * @param options.supportsTools - True for native tool calling, false for
   *   text-based fallback.
   * @param options.temperature - Sampling temperature (0 = deterministic, 1+ = creative).
   * @param options.signal - Cancellation signal.
   * @param options.onThinkDelta - Optional callback invoked with each
   *   newly-available slice of `<redacted_thinking>` inner text as the model
   *   streams its response. Fed from whichever channel actually carries
   *   thinking on each path — the native path's separate reasoning channel
   *   as well as its content channel (a model may put the tagged block in
   *   either), and the text-mode path's single content stream — through one
   *   scanner, so the tag is recognized wherever it appears without ever
   *   being scanned twice.
   * @returns The model's full text response, extracted tool calls, and malformation flag.
   * @throws {@link AbortError} if the orchestrator cancels the stream.
   */
  private fetchModelTurn = async (options: {
    model: string;
    messages: Message[];
    toolSchemas: ReturnType<typeof getToolSchemas>;
    supportsTools: boolean;
    temperature: number;
    signal: AbortSignal;
    onThinkDelta?: (text: string) => void;
  }): Promise<ChatResult> => {
    const {
      model,
      messages,
      toolSchemas,
      supportsTools,
      temperature,
      signal,
      onThinkDelta,
    } = options;

    // Only scan for incremental think text when someone is listening — skips
    // the scan entirely for callers that only want the final block.
    //
    // One scanner per provider channel, never one shared between them —
    // `chatWithTools` drives the content channel (`onToken`) and the native
    // reasoning channel (`onThinkToken`) independently and interleaved, so a
    // single shared scanner could have a tag split across channels (dropping
    // the block) or emit raw untagged reasoning verbatim. See the same
    // treatment in `Agent.plan`.
    const makeScanner = (): ThinkTagScanner | null =>
      onThinkDelta ? createThinkTagScanner([THINK_BLOCK]) : null;
    const contentThinkScanner = makeScanner();
    const reasoningThinkScanner = makeScanner();
    const pushThinkFrom =
      (scanner: ThinkTagScanner | null) =>
      (piece: string): void => {
        const delta = scanner?.push(piece) ?? "";
        if (delta.length > 0) {
          onThinkDelta?.(delta);
        }
      };
    const pushThink = pushThinkFrom(contentThinkScanner);
    // Flushes both channels' scanners; at most one ever holds an
    // unterminated block.
    const flushThinkScanners = (): void => {
      for (const scanner of [contentThinkScanner, reasoningThinkScanner]) {
        const flushed = scanner?.flush() ?? "";
        if (flushed.length > 0) {
          onThinkDelta?.(flushed);
        }
      }
    };

    if (supportsTools) {
      // Native tool calling: Ollama returns structured tool calls + content.
      // No manual parsing needed; Ollama validates against the provided schema.
      // Tool calls are guaranteed to be valid JSON with the right structure.
      if (signal.aborted) {
        throw new AbortError("Agent stream aborted");
      }
      const result = await this.dependencies.ollama.chatWithTools(
        model,
        messages,
        toolSchemas,
        {
          temperature,
          signal,
          numCtx: this.dependencies.numCtx,
          keepAlive: this.dependencies.keepAlive,
          onThinkToken: pushThinkFrom(reasoningThinkScanner),
        },
        pushThink,
      );
      flushThinkScanners();
      return {
        content: result.content,
        thinking: result.thinking,
        toolCalls: result.toolCalls.map((call) => ({
          name: call.name,
          args: call.args,
        })),
        hadMalformedToolBlock: false,
      };
    }

    // Text-based mode: stream tokens and accumulate the full response text.
    // Tool calls are embedded in the text as <<TOOL>>{JSON}<<END>> blocks.
    // The model may emit malformed JSON, missing markers, etc.; parseAllToolCalls
    // detects these issues so retry logic can handle them.
    // `includeThinking` is deliberately left unset here — setting it would
    // change Ollama's `think` request field and could alter the model's
    // output shape. Thinking already arrives inline in this content stream
    // when the model uses the `redacted_thinking` tag, so the scanner reads
    // it directly from `token` instead.
    let assistantResponseText = "";
    for await (const token of this.dependencies.ollama.chatStream(
      model,
      messages,
      {
        temperature,
        signal,
        numCtx: this.dependencies.numCtx,
        keepAlive: this.dependencies.keepAlive,
      },
    )) {
      if (signal.aborted) {
        throw new AbortError("Agent stream aborted");
      }
      assistantResponseText += token;
      pushThink(token);
    }
    flushThinkScanners();

    // Parse all tool calls from the accumulated text and flag any malformation.
    const { calls: toolCalls, hadMalformedBlock: hadMalformedToolBlock } =
      parseAllToolCalls(assistantResponseText, this.toolRegistry);
    // No separate reasoning channel in text mode — thinking already arrived
    // inline in assistantResponseText (see the includeThinking comment above).
    return {
      content: assistantResponseText,
      thinking: "",
      toolCalls,
      hadMalformedToolBlock,
    };
  };

  /**
   * Appends a tool call and its result feedback to the conversation history.
   *
   * @remarks
   * Formats the turn differently depending on whether the model supports native
   * tool calls or uses text-based fallback:
   * - **Native mode**: Uses `tool_calls` and `tool` roles (OpenAI format).
   * - **Text mode**: Appends legacy tool block to assistant content, feedback as user message.
   *
   * Both paths maintain a consistent conversation flow for the model to read
   * and adjust its next turn based on the feedback.
   *
   * @param messages - Conversation history to append to.
   * @param content - Full assistant response text (includes thinking, narrative, tool call).
   * @param call - The tool call that was executed.
   * @param feedback - Result or error message from the tool execution.
   * @param supportsTools - True for native tool mode, false for text-based fallback.
   */
  private appendToolTurnToHistory = (
    messages: Message[],
    content: string,
    call: ParsedToolCall,
    feedback: string,
    supportsTools: boolean,
  ): void => {
    if (supportsTools) {
      // Native tool calling: use structured tool_calls and tool result roles.
      messages.push({
        role: "assistant",
        content,
        tool_calls: [
          {
            function: {
              name: call.name,
              arguments: call.args,
            },
          },
        ],
      });
      // Tool result in a separate message with the tool's name.
      messages.push({
        role: "tool",
        tool_name: call.name,
        content: feedback,
      });
      return;
    }

    // Text-based fallback: append legacy tool block to the assistant response.
    messages.push({
      role: "assistant",
      content: `${content}\n${formatLegacyToolBlock(call)}`,
    });
    // Feedback as a user message so the model treats it as a reply.
    messages.push({ role: "user", content: feedback });
  };

  /**
   * Executes a tool call and returns the result.
   *
   * @remarks
   * Looks up the handler for the tool name and calls its execute method.
   * If no handler exists, returns an error result (unknown tool).
   *
   * The result includes:
   * - `feedback`: Text to append to history (result or error message)
   * - `done`: True if the task is complete or escalation budget exhausted
   * - `summary`: Final task summary (when done = true)
   * - `escalationCount`: Updated escalation count (may increment)
   *
   * @param call - The tool call to execute (name + args).
   * @param context - Execution context (workspace, terminal, tracking, etc.).
   * @returns Execution result with feedback, done flag, and summary.
   */
  private executeTool = async (
    call: ParsedToolCall,
    context: ToolHandlerContext & { supportsTools: boolean },
  ): Promise<ToolExecutionResult> => {
    const toolHandler = this.toolHandlers.get(call.name);

    // Unknown tool name — return error feedback.
    if (!toolHandler) {
      return {
        done: false,
        summary: "",
        feedback: `Unknown tool: ${call.name}`,
        escalationCount: context.escalationCount,
      };
    }

    // Execute the tool handler.
    const { supportsTools: _supportsTools, ...handlerContext } = context;
    const result = await toolHandler.execute(call.args, handlerContext);
    return result;
  };
}
