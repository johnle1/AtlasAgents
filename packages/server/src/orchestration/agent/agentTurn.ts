/**
 * The unified agent turn: one loop that behaves like an ordinary coding
 * assistant in every mode.
 *
 * @remarks
 * Replaces the old forced pipeline of `Agent.plan()` → subagent pool →
 * `Agent.combine()`, which ran a planner scaffold for every message
 * regardless of content — including a bare "hello". This loop instead:
 *
 * - Answers directly when nothing needs looking up (no tool calls at all).
 * - Calls a tool (`read_file`, `run_command`, ...) when the answer depends
 *   on the workspace.
 * - Writes a checklist via `update_plan` only for genuinely multi-step work,
 *   and only then runs independent steps concurrently via
 *   `run_steps_parallel` — each one completed by this same loop, not a
 *   separate subagent persona or model.
 *
 * No subagent or distinct worker persona is required for this loop to run;
 * `run_steps_parallel` is just this loop invoked several times concurrently
 * (see `runToolCallLoop` below). It deliberately omits the old subagent
 * loop's ceremony — the mandatory `<redacted_thinking>` block, first-turn
 * command-plan enforcement, and escalation machinery — none of which make
 * sense for a single agent with no lead to defer to.
 */

import type { EffortLevel } from "../../config/types.js";
import type {
  IConfigManager,
  IExperienceRecorder,
  IOllamaClient,
} from "../interfaces.js";
import type {
  ClientEnv,
  CommandPlan,
  Message,
  PlannedSubtask,
  PlanStep,
  SubagentPlan,
  TaskModelOverrides,
  ToolResultSummary,
} from "../types.js";
import { emptyCommandPlan } from "../types.js";
import type { PerConnection } from "../../container/types.js";
import type { MaxSubagentsParam } from "../maxSubagents.js";
import { clampUsage, type TaskApprovalMode } from "@atlasagents/shared";
import type { TaskFrame } from "../../transport/frames.js";
import { modeLabelFromMaxAgents } from "../planHelpers.js";
import {
  parseAllToolCalls,
  stripMarkdownFencesFromText,
  TOOL_END,
  TOOL_START,
  type ParsedToolCall,
} from "../toolProtocol.js";
import {
  createAgentTurnToolRegistry,
  createWorkerToolRegistry,
  getToolHandlerMap,
  getToolSchemas,
} from "../tools/registry.js";
import type { ToolHandler, ToolHandlerContext } from "../tools/types.js";
import {
  buildAgentTurnSystemText,
  buildWorkerSystemText,
} from "./agentPrompt.js";
import {
  createThinkFrameEmitter,
  createThinkTagScanner,
} from "../thinkStream.js";
import type { ThinkTagScanner } from "../thinkStream.js";
import { runAgentPool } from "../orchestrator/orchestratorPipelineHelpers.js";
import { resolveOllamaTuning } from "../../ollama/runtimeTuning.js";
import { AbortError } from "../../errors/index.js";
import { logger } from "../../utils/logger.js";
import {
  completionGap,
  shouldStopForUnproductiveStreak,
} from "./terminationManager.js";
import { runReasoningPhase } from "./reasoner.js";
import {
  applyCompaction,
  applyElisionFallback,
  buildCompactionRequest,
  DEFAULT_COMPACTION_BUDGET,
  estimateMessagesTokens,
  selectCompactionRange,
  shouldCompact,
} from "./contextCompaction.js";
import { recordExchange, toHistoryMessages } from "./conversationMemory.js";

/**
 * Safety ceiling on tool-call turns in one agent turn — the single honest
 * backstop for a model that never converges. There is no separate give-up
 * counter for stalls or rejected `finish` calls (see `resolveEmptyTurn` and
 * `runToolCalls`): the model keeps reasoning and acting for as long as it
 * takes, bounded only by this ceiling and by the user's own Ctrl+C.
 */
const MAX_AGENT_TURN_ITERATIONS = 200;
/** Cap on tool calls run from a single model response — extras are deferred back to the model. */
const MAX_TOOL_CALLS_PER_ITERATION = 5;
/** Consecutive iterations that executed no tool (malformed block, unknown tool) before the loop gives up. Mirrors the old (now-dead) subagent.ts's MAX_UNPRODUCTIVE_TURNS. This is a distinct pathology from an empty-turn stall (a model replying with no tool call): it's a model that emits well-formed prose but no valid tool syntax at all, so unlike a stall there's genuinely nothing else to observe or reset on. */
const MAX_UNPRODUCTIVE_ITERATIONS = 100;

/**
 * Recognized reasoning-tag names to scan for in the model's CONTENT channel.
 *
 * @remarks
 * Unlike the subagent, agentTurn's system prompt never instructs the model
 * to wrap reasoning in a specific tag — there's no mandatory ceremony here.
 * But some open-weight models (DeepSeek-R1-style) emit `<think>` reasoning
 * inline in their content channel unprompted, out of habit from training.
 * Scanning for it live means that reasoning renders as a "thinking" block
 * instead of leaking into the visible answer. `redacted_thinking` and
 * `agent-think` are included too, matching the tags the subagent/old
 * planner used — harmless to also recognize here.
 *
 * This only applies to the content channel. A provider's separate native
 * reasoning channel (Ollama `message.thinking`, OpenAI-compatible
 * `delta.reasoning_content`, surfaced via `onThinkToken`) is passed through
 * to the client raw, with no tag scanning — see `runToolCallLoop` below.
 * Nothing in this loop's prompt asks a model to wrap that channel in a tag,
 * so scanning it for one only means silently dropping every reasoning token
 * a model that doesn't happen to use one emits.
 */
const REASONING_TAG_NAMES = ["think", "agent-think", "redacted_thinking"];

/**
 * Defensive final-answer cleanup: strips any recognized reasoning tag that
 * survived to the end of a turn uncaught by the live scanner (e.g. a tag
 * name the scanner wasn't watching for, or one split in a way the model
 * never actually closes). The live scanner (see `REASONING_TAG_NAMES`)
 * handles the common case; this is the safety net so a raw `<think>...`
 * block can never reach the user even in an edge case the scanner misses.
 *
 * @remarks
 * Matches through to the closing tag, or — if the model was cut off before
 * emitting one — through to the end of the string, so a truncated response
 * doesn't leave a raw `<think>` prefix and its unfinished contents visible.
 */
const stripReasoningTags = (text: string): string =>
  REASONING_TAG_NAMES.reduce(
    (cleaned, tag) =>
      cleaned.replace(
        new RegExp(`<${tag}>[\\s\\S]*?(?:<\\/${tag}>|$)`, "gi"),
        "",
      ),
    text,
  ).trim();

/** Formats a tool call as a legacy text-based tool block (text-mode fallback, mirrors subagent.ts). */
const formatLegacyToolBlock = (call: ParsedToolCall): string =>
  `${TOOL_START}${JSON.stringify({ tool: call.name, ...call.args })}${TOOL_END}`;

/** Builds a one-line summary of the carried-over plan for a resumed turn (see Phase 6 in the plan doc). */
const buildResumeBlock = (steps: PlanStep[]): string | null => {
  if (steps.length === 0 || steps.every((step) => step.status === "done")) {
    return null;
  }
  const done = steps.filter((step) => step.status === "done");
  const next = steps.find(
    (step) => step.status !== "done" && step.status !== "failed",
  );
  const lines = [
    "[CARRIED-OVER PLAN]",
    `A previous turn (possibly a different model) left this checklist ${done.length}/${steps.length} done:`,
    ...steps.map(
      (step) =>
        `  [${step.status === "done" ? "x" : step.status === "in_progress" ? "#" : " "}] ${step.id}. ${step.text}`,
    ),
    next
      ? `Continue from step ${next.id}. Call update_plan to mark progress as you go; call run_steps_parallel for any remaining steps you can verify are independent.`
      : "Review whether remaining steps are still needed, then continue.",
  ];
  return lines.join("\n");
};

/** How many of the most recent messages the REASON phase gets to look at — see `buildReasonContext`. */
const REASON_CONTEXT_MESSAGE_COUNT = 6;
/** Character cap on the rendered REASON-phase context, so a long tool observation doesn't balloon the reasoning prompt. */
const REASON_CONTEXT_CHAR_LIMIT = 3000;

/**
 * Renders a compact summary of where the loop currently stands for the
 * REASON phase (`reasoner.ts`) — the task itself (always `messages[1]`, the
 * first user message after the system prompt) plus the most recent exchange,
 * so the reasoner has enough to decide the next step without being handed
 * the full tool-calling conversation it's deliberately kept out of (see
 * `reasoner.ts`'s module remarks).
 */
const buildReasonContext = (messages: Message[]): string => {
  const task = messages[1]?.content ?? "";
  const recent = messages.slice(-REASON_CONTEXT_MESSAGE_COUNT);
  const recentText = recent
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const combined =
    recentText.length > 0 ? `Task: ${task}\n\n${recentText}` : `Task: ${task}`;
  return combined.length > REASON_CONTEXT_CHAR_LIMIT
    ? combined.slice(combined.length - REASON_CONTEXT_CHAR_LIMIT)
    : combined;
};

export type AgentTurnResult = {
  /** The turn's final user-facing text (direct answer, or the `finish` summary). */
  content: string;
  /** False when the turn ended via a failed `finish` or hit the iteration ceiling. */
  ok: boolean;
};

export type AgentTurnDeps = {
  ollama: IOllamaClient;
  config: IConfigManager;
  experienceRecorder: IExperienceRecorder;
};

export type AgentTurnParams = {
  taskId: string;
  taskText: string;
  contextHeader: string;
  skillBody: string;
  clientEnv: ClientEnv | undefined;
  perConn: PerConnection;
  modelOverrides: TaskModelOverrides | undefined;
  approvalMode: TaskApprovalMode;
  maxSubagents: MaxSubagentsParam;
  emit: (frame: TaskFrame) => void;
  emitToken: (text: string) => void;
  signal: AbortSignal;
  /**
   * The agent model's resolved context window (Ollama `num_ctx`), or `0`
   * when unresolved (an OpenAI-compatible role — that concept doesn't apply
   * there). Lets the loop bound its own conversation growth instead of
   * silently outgrowing the window mid-turn — see `contextCompaction.ts`.
   */
  contextWindow: number;
};

/** Resolves agent model/temperature/capability config, honoring per-task overrides. */
const resolveTurnConfig = async (
  config: IConfigManager,
  overrides: TaskModelOverrides | undefined,
): Promise<{
  agentModel: string;
  agentTemperature: number;
  configuredSupportsTools: boolean;
  /**
   * Ollama `keep_alive` duration (e.g. `"30m"`) — no per-task override exists
   * for this, unlike model/temperature/tool-support, since it's an operator
   * preference about local resource residency, not something a caller would
   * reasonably vary per task. Forwarded on every model call this loop makes
   * (see `ChatOptions.keepAlive`); harmlessly ignored by non-Ollama providers.
   */
  keepAlive: string | number;
  /**
   * How much the REASON phase re-deliberates before acting (`reasoner.ts`)
   * — no per-task override, same reasoning as `keepAlive` above.
   */
  effort: EffortLevel;
}> => {
  const agentModel =
    overrides?.agentModel?.trim() || (await config.getAgentModel());
  const agentTemperature =
    overrides?.agentTemp ?? (await config.getAgentTemperature());
  const configuredSupportsTools =
    overrides?.agentModelSupportsTools ??
    (await config.getAgentModelSupportsTools());
  const keepAlive = await config.getKeepAlive();
  const effort = await config.getEffort();
  return {
    agentModel,
    agentTemperature,
    configuredSupportsTools,
    keepAlive,
    effort,
  };
};

/**
 * The tool-calling ReAct loop shared by the top-level agent turn and by
 * every concurrent step `run_steps_parallel` dispatches.
 *
 * @remarks
 * Factored out so a "step" and "the whole turn" are the exact same
 * mechanism — native vs. legacy tool-call handling, reasoning-tag scanning,
 * malformed-call recovery, the iteration ceiling — with zero duplicated
 * protocol logic. The two call sites differ only in what they pass in:
 * the top-level turn gates its registry on plan-mode approval and streams
 * the final answer to the user, while a worker step gets a fixed registry
 * and every callback is a no-op so nothing it does is ever visible on its
 * own — the caller (`runStepsParallel`) is what surfaces the outcome, via
 * the checklist.
 *
 * @throws {@link AbortError} When `signal` is aborted mid-loop.
 */
const runToolCallLoop = async (params: {
  taskId: string;
  ollama: IOllamaClient;
  agentModel: string;
  agentTemperature: number;
  configuredSupportsTools: boolean;
  /** See `resolveTurnConfig` — forwarded on every model call this loop makes. */
  keepAlive: string | number;
  /**
   * See `resolveTurnConfig` — only consulted when `enableReasoning` is
   * true. A worker step passes its resolved value here too even though it's
   * unused, so this stays a plain required field rather than needing an
   * `enableReasoning`-gated optional.
   */
  effort: EffortLevel;
  messages: Message[];
  /** Re-invoked every iteration — lets the top-level turn's plan-mode gating flip mid-loop. */
  getActiveRegistry: () => ToolHandler[];
  buildToolContext: () => ToolHandlerContext;
  emit: (frame: TaskFrame) => void;
  emitToken: (text: string) => void;
  reportStatus: ToolHandlerContext["emitSubagentStatus"];
  signal: AbortSignal;
  /**
   * Consulted whenever the model tries to end the turn with plain text and
   * no tool call. Returns a corrective message naming what's still
   * outstanding (unfinished checklist step, unverified write), or `null`
   * when the turn is genuinely done. Omitted entirely for a
   * `run_steps_parallel` worker step — a step owns no checklist and gets no
   * gate, so its behavior here is unchanged from before this was added.
   */
  checkCompletion?: () => string | null;
  /** See `AgentTurnParams.contextWindow` — same meaning, threaded through to both the top-level turn and every worker step. */
  contextWindow: number;
  /**
   * How many messages at the START of `messages` are the seed (system
   * prompt, any carried-over conversation history, and the current task)
   * and must never be compacted away — see `contextCompaction.ts`'s
   * `selectCompactionRange`. The top-level turn passes the seed's actual
   * length (2 plus however many history messages were spliced in); a
   * worker step always passes 2 (`[system, task]`, no history).
   */
  protectedPrefixCount: number;
  /**
   * Whether to run the REASON phase (`reasoner.ts`) ahead of each model
   * call. `true` for the top-level turn, whose `conclude`/`Wait, I think`
   * text is worth showing the user; `false` for a `run_steps_parallel`
   * worker step, whose `emitToken`/`emit` are no-ops anyway — running it
   * there would only add latency for a display nothing ever surfaces.
   */
  enableReasoning: boolean;
  /**
   * Whether a given tool call is safe to run concurrently with adjacent
   * read-only calls from the same model response — see `runToolCalls`'s
   * doc comment for the concurrency rule this drives, and
   * `ToolHandler.readOnly`'s doc comment for what "safe" means here.
   * Defaults to checking `handler.readOnly` alone; the top-level turn
   * passes a version that also consults its MCP tools' `readOnly` flags
   * (`mcpReadOnlyByName`, built alongside the plan-mode registry filter).
   */
  isToolReadOnly?: (handler: ToolHandler) => boolean;
}): Promise<AgentTurnResult> => {
  const {
    taskId,
    ollama,
    agentModel,
    agentTemperature,
    configuredSupportsTools,
    keepAlive,
    effort,
    messages,
    getActiveRegistry,
    buildToolContext,
    emit,
    emitToken,
    reportStatus,
    signal,
    checkCompletion,
    contextWindow,
    protectedPrefixCount,
    enableReasoning,
    isToolReadOnly = (handler) => handler.readOnly === true,
  } = params;

  // Governs ONLY when compaction kicks in (below) — a generous, documented
  // fallback for the OpenAI-compatible case where the real window isn't
  // known (contextWindow === 0). The `usage` frame emitted per iteration
  // still uses the real `contextWindow` (via `clampUsage`, which returns
  // `null` — nothing emitted — for a non-positive window), so an unknown
  // window never gets reported to the user as a fabricated number.
  const compactionBudget =
    contextWindow > 0 ? contextWindow : DEFAULT_COMPACTION_BUDGET;

  // The Ollama-only `num_ctx` to send on the wire — `undefined` (omitted
  // from the request) rather than a fabricated value when the window isn't
  // known (contextWindow === 0, e.g. an OpenAI-compatible role). Without
  // this, Ollama serves every call at its own default context length while
  // this loop budgets compaction against the model's real, often much
  // larger window — so an uncompacted turn can silently overflow Ollama's
  // actual window and get truncated from the front, dropping the system
  // message that holds the tool catalog.
  const numCtx = contextWindow > 0 ? contextWindow : undefined;

  // Cumulative across the whole turn — a turn that never executes a tool
  // (a greeting, or a resumed turn whose new model answers without acting)
  // cannot have unverified writes or an unfinished checklist, so the
  // completion gate short-circuits to "no gap" whenever this is still 0.
  // This is what keeps the "hello" regression guard (and the plan-resume
  // test whose fake model never calls a tool) at exactly one model call.
  let toolCallsExecuted = 0;
  // Consecutive empty turns (model replies with plain text, no tool call)
  // while a completion gap is still open — see `resolveEmptyTurn`, the
  // "Continue automatically" driver. Tracked (and reset to 0 whenever any
  // tool executes) only so the escalating nudge wording — 1st stall gets
  // the plain gap, every stall after that gets the sharper "act now"
  // directive — can tell "just started stalling" apart from "been stalling
  // a while"; there is no cap here, and no stall count ever ends the turn.
  let stallsSinceProgress = 0;
  // Consecutive iterations that executed no tool due to a PROTOCOL error
  // (malformed legacy block, unknown tool name) — distinct from
  // `stallsSinceProgress`, which tracks empty turns specifically. Reset on
  // any iteration that runs at least one real tool handler.
  let unproductiveStreak = 0;
  // The most recent gap reported by resolveEmptyTurn/stopIfUnproductive's
  // caller-side check, so a stop can still say what was left outstanding
  // instead of just "no progress" — see stopIfUnproductive below.
  let lastKnownGap: string | null = null;

  const appendToolTurnToHistory = (
    content: string,
    call: ParsedToolCall,
    feedback: string,
  ): void => {
    if (configuredSupportsTools) {
      messages.push({
        role: "assistant",
        content,
        tool_calls: [{ function: { name: call.name, arguments: call.args } }],
      });
      messages.push({ role: "tool", tool_name: call.name, content: feedback });
      return;
    }
    messages.push({
      role: "assistant",
      content: `${content}\n${formatLegacyToolBlock(call)}`,
    });
    messages.push({ role: "user", content: feedback });
  };

  /**
   * Runs every tool call the model emitted in one response, appending one
   * assistant/tool (or assistant+`<<TOOL>>` in legacy mode) pair per call —
   * never one assistant turn carrying every `tool_calls` entry.
   * `providers/messageTranslation.ts` correlates a tool result back to its
   * call BY TOOL NAME, keeping only the most recent id per name; one
   * assistant message with two same-named calls (e.g. two `read_file`s)
   * followed by two results would map both results to the last id under
   * that scheme. Sequential pairs sidestep this entirely — the name→id map
   * is rebuilt fresh before each lookup — with zero changes needed to the
   * translator. History is always appended **in the model's original call
   * order**, regardless of execution order (see below) — `content` (the
   * model's prose) is attached to the first pair only so it isn't
   * duplicated into history for every call in the batch.
   *
   * @remarks
   * **Concurrency.** A maximal run of 2+ *consecutive* calls whose handlers
   * are read-only (`ToolHandler.readOnly`, or an MCP tool's own `readOnly`
   * flag via `isToolReadOnly`) executes concurrently via `Promise.all`,
   * then appends to history in original order once every call in the run
   * has settled — never interleaved with another run's results. This is
   * safe specifically because a read observes but never changes workspace,
   * checklist, or control-flow state, so nothing about running several
   * alongside each other can corrupt anything a sibling read or the next
   * mutating call depends on. Everything else — a lone read-only call, any
   * mutating or unknown call, and the boundary between two different runs —
   * executes exactly as before: one at a time, awaited, appended
   * immediately. A run is broken by ANY non-read-only or unknown call in
   * between, even if more read-only calls follow, so ordering relative to a
   * mutation is always preserved.
   *
   * Stops early on the first `done` result. Within a concurrent run, `done`
   * is resolved by original call order, not settle order, if a handler
   * marked read-only were ever to return `done: true` (not expected in
   * practice — see `ToolHandler.readOnly`'s doc comment). A `finish` call
   * that fails its own verification gate is not itself a stopping
   * condition — it's just another observation fed back to the model (see
   * `finishHandler.ts`), the same as any other rejected tool call; the
   * model keeps trying until it actually satisfies the gate or the turn's
   * iteration ceiling is hit.
   */
  const runToolCalls = async (
    content: string,
    calls: ParsedToolCall[],
    toolHandlers: Map<string, ToolHandler>,
  ): Promise<{
    done: boolean;
    ok?: boolean;
    summary: string;
    executed: number;
  }> => {
    let executed = 0;
    let index = 0;

    // Runs one call sequentially — the shared path for a mutating/unknown
    // call and for a read-only run of length 1 (no concurrency benefit, so
    // it stays on the exact same code path as every other single call).
    const runOne = async (
      call: ParsedToolCall,
      callIndex: number,
      handler: ToolHandler | undefined,
    ): Promise<{ done: boolean; ok?: boolean; summary: string } | null> => {
      const pairContent = callIndex === 0 ? content : "";
      if (!handler) {
        appendToolTurnToHistory(pairContent, call, `Unknown tool: ${call.name}`);
        return null;
      }
      const result = await handler.execute(call.args, buildToolContext());
      executed += 1;
      if (result.done) {
        return { done: true, ok: result.ok, summary: result.summary };
      }
      appendToolTurnToHistory(pairContent, call, result.feedback);
      return null;
    };

    while (index < calls.length) {
      if (signal.aborted) {
        throw new AbortError("Agent turn aborted");
      }
      const call = calls[index];
      if (!call) {
        index += 1;
        continue;
      }
      const handler = toolHandlers.get(call.name);

      if (!handler || !isToolReadOnly(handler)) {
        const outcome = await runOne(call, index, handler);
        if (outcome) {
          return { ...outcome, executed };
        }
        index += 1;
        continue;
      }

      // Gather the maximal consecutive run of known, read-only calls
      // starting here.
      const runStart = index;
      const run: { call: ParsedToolCall; handler: ToolHandler }[] = [];
      while (index < calls.length) {
        const nextCall = calls[index];
        if (!nextCall) {
          break;
        }
        const nextHandler = toolHandlers.get(nextCall.name);
        if (!nextHandler || !isToolReadOnly(nextHandler)) {
          break;
        }
        run.push({ call: nextCall, handler: nextHandler });
        index += 1;
      }

      if (run.length === 1) {
        const { call: soloCall, handler: soloHandler } = run[0]!;
        const outcome = await runOne(soloCall, runStart, soloHandler);
        if (outcome) {
          return { ...outcome, executed };
        }
        continue;
      }

      const results = await Promise.all(
        run.map(({ call: runCall, handler: runHandler }) =>
          runHandler.execute(runCall.args, buildToolContext()),
        ),
      );
      executed += results.length;

      const doneIndex = results.findIndex((r) => r.done);
      if (doneIndex !== -1) {
        const doneResult = results[doneIndex]!;
        return {
          done: true,
          ok: doneResult.ok,
          summary: doneResult.summary,
          executed,
        };
      }

      run.forEach(({ call: runCall }, runOffset) => {
        const pairContent = runStart + runOffset === 0 ? content : "";
        appendToolTurnToHistory(pairContent, runCall, results[runOffset]!.feedback);
      });
    }

    return { done: false, summary: "", executed };
  };

  type EmptyTurnOutcome =
    | { kind: "continue" }
    | { kind: "final"; content: string; ok: boolean };

  /**
   * Decides what happens when the model tries to end the turn with plain
   * text and no tool call. `historyContent` is what gets pushed to
   * conversation history if the turn continues (raw model output);
   * `displayContent` is the cleaned text shown to the user if it doesn't.
   *
   * @remarks
   * The "Continue automatically" edge: a completion gap (unfinished
   * checklist step, unverified write) is not accepted as a reason to stop —
   * there is no cap on how many times this may fire. `stallsSinceProgress`
   * escalates the wording rather than repeating the same nudge forever,
   * since a small local model tends to need a sharper instruction after the
   * first miss, not the same sentence on every retry:
   * - 1st stall: the plain gap message (what's outstanding).
   * - Every stall after that: a directive to act now, try a different
   *   approach if the obvious one won't work, and only mark the step failed
   *   (via `update_plan`) and move on once alternatives are exhausted.
   * The counter resets to 0 the instant any tool actually executes, so a
   * model that keeps making real progress never sees the escalated wording
   * at all — only a model stuck doing nothing does, and it keeps seeing it
   * for as long as it keeps doing nothing. The only way out of a genuinely
   * stuck turn is the iteration ceiling (`MAX_AGENT_TURN_ITERATIONS`) or the
   * user cancelling.
   */
  const resolveEmptyTurn = (
    historyContent: string,
    displayContent: string,
  ): EmptyTurnOutcome => {
    const gap =
      toolCallsExecuted > 0 && checkCompletion ? checkCompletion() : null;
    if (!gap) {
      return { kind: "final", content: displayContent, ok: true };
    }
    lastKnownGap = gap;
    stallsSinceProgress += 1;

    const followUp =
      stallsSinceProgress === 1
        ? gap
        : [
            "You replied without taking any action. Do not describe what you will do — call the tool for the next outstanding step now.",
            "If it will not work, try a different approach. Only once alternatives are exhausted, call update_plan marking that step failed with a one-line reason, then continue with the remaining steps.",
            "",
            gap,
          ].join("\n");
    messages.push({ role: "assistant", content: historyContent });
    messages.push({ role: "user", content: followUp });
    return { kind: "continue" };
  };

  /** Ends the turn with an honest failure once too many iterations in a row made no progress. */
  const stopIfUnproductive = (): AgentTurnResult | null => {
    if (
      !shouldStopForUnproductiveStreak(
        unproductiveStreak,
        MAX_UNPRODUCTIVE_ITERATIONS,
      )
    ) {
      return null;
    }
    const gapSuffix = lastKnownGap ? `\n${lastKnownGap}` : "";
    const message = `[agent stopped: ${MAX_UNPRODUCTIVE_ITERATIONS} turns in a row made no progress]${gapSuffix}`;
    emitToken(message);
    reportStatus("done", "⚠", "Done");
    return { content: message, ok: false };
  };

  reportStatus("thinking", "◌", "Thinking…");

  for (
    let iteration = 0;
    iteration < MAX_AGENT_TURN_ITERATIONS;
    iteration += 1
  ) {
    if (signal.aborted) {
      throw new AbortError("Agent turn aborted");
    }

    // Real usage, reported once per iteration from what's ABOUT to be sent
    // to the model — replaces the pipeline's coarse, loop-blind estimate
    // (taskText + contextHeader + skillBody + final content only) with a
    // number that actually reflects a long tool-calling turn. `clampUsage`
    // itself returns `null` (nothing emitted) when `contextWindow` isn't a
    // positive number, so an unresolved window is never reported as a
    // fabricated one.
    const estimatedTokens = estimateMessagesTokens(messages);
    const usage = clampUsage(estimatedTokens, contextWindow);
    if (usage) {
      emit({ kind: "usage", ...usage });
    }

    // Compact before the model call that would otherwise exceed its window.
    // See contextCompaction.ts's module doc for why this exists: an
    // uncompacted turn risks the provider silently truncating the PROMPT
    // FROM THE FRONT once it overflows — dropping the system message that
    // holds the tool catalog — which is what turned "does step 1, keeps
    // going" into "does step 1, drops".
    if (shouldCompact(estimatedTokens, compactionBudget)) {
      const range = selectCompactionRange(messages, protectedPrefixCount);
      if (range) {
        const middle = messages.slice(range.start, range.end);
        try {
          const summary = await ollama.chat(
            agentModel,
            buildCompactionRequest(middle),
            { temperature: 0, signal, numCtx, keepAlive },
          );
          if (summary.trim().length > 0) {
            applyCompaction(messages, range, summary.trim());
          } else {
            applyElisionFallback(messages, range);
          }
        } catch (error) {
          // Compaction must never be what ends a turn early — that would
          // reintroduce the exact bug this exists to fix. Fall back to
          // plain elision and keep going, aborting only on real cancellation.
          if (error instanceof AbortError) {
            throw error;
          }
          applyElisionFallback(messages, range);
        }
      }
    }

    // REASON phase: a lightweight, tool-free side channel that decides what
    // to do next before the real tool-calling call below carries it out.
    // Additive by design — see reasoner.ts's module remarks — so a provider
    // or test fixture with no `chat()` support just gets `null` here and the
    // loop proceeds exactly as it did before this existed. Only ever shown
    // to the user via `display` (the record's `conclude`, or a verification
    // pass's "Wait, I think ..." revision); the raw record never reaches
    // `messages`, so it changes nothing about what the model that actually
    // calls tools is shown.
    if (enableReasoning) {
      const reasonOutcome = await runReasoningPhase({
        ollama,
        model: agentModel,
        signal,
        numCtx,
        keepAlive,
        effort,
        contextText: buildReasonContext(messages),
      });
      if (reasonOutcome?.display) {
        emitToken(`${reasonOutcome.display}\n\n`);
      }
    }

    const activeRegistry = getActiveRegistry();
    const activeToolSchemas = getToolSchemas(activeRegistry);
    const activeToolHandlers = getToolHandlerMap(activeRegistry);

    let content = "";
    let toolCalls: ParsedToolCall[] = [];

    // Live-scans the CONTENT channel only for a recognized reasoning tag
    // (see REASONING_TAG_NAMES) so any inline "<think>..." a model emits
    // renders as a "thinking" block instead of leaking into the visible
    // answer. Content is NOT streamed to emitToken live, mid-generation,
    // here — unlike a scanner that only extracts think text (discarding
    // everything else, as subagent.ts's does), there's no cheap way to also
    // pass through non-think text live without risking a partial tag prefix
    // (e.g. "<th") reaching the user a moment before it turns out to be the
    // start of "<think>". The full response is available as soon as the
    // call resolves either way, so the cleaned text is flushed once,
    // immediately after — either as the final answer (toolCalls.length===0
    // branch below) or, in native mode, as narration ahead of the tool
    // call(s) it accompanies (further down, right before runToolCalls).
    //
    // The native REASONING channel (onThinkToken below) is NOT scanned —
    // it's passed straight through to thinkFrames. It's a separate wire
    // channel from the provider (not embedded in content), so there is no
    // tag to find: this loop's prompt never asks a model to wrap it in one,
    // and scanning it the same way as content would just discard every
    // reasoning token from a model that doesn't happen to emit a tag.
    const contentThinkScanner = createThinkTagScanner(REASONING_TAG_NAMES);
    const thinkFrames = createThinkFrameEmitter({ emit, agent: true });
    const pushThinkFrom =
      (scanner: ThinkTagScanner) =>
      (piece: string): void => {
        const delta = scanner.push(piece);
        if (delta.length > 0) {
          thinkFrames.delta(delta);
        }
      };

    try {
      if (configuredSupportsTools) {
        const result = await ollama.chatWithTools(
          agentModel,
          messages,
          activeToolSchemas,
          {
            temperature: agentTemperature,
            signal,
            numCtx,
            keepAlive,
            onThinkToken: (piece) => thinkFrames.delta(piece),
          },
          pushThinkFrom(contentThinkScanner),
        );
        content = result.content;
        toolCalls = result.toolCalls.map((call) => ({
          name: call.name,
          args: call.args,
        }));
      } else {
        let raw = "";
        for await (const token of ollama.chatStream(agentModel, messages, {
          temperature: agentTemperature,
          signal,
          numCtx,
          keepAlive,
        })) {
          if (signal.aborted) {
            throw new AbortError("Agent turn stream aborted");
          }
          raw += token;
          pushThinkFrom(contentThinkScanner)(token);
        }
        const parsed = parseAllToolCalls(raw, activeRegistry);
        if (parsed.calls.length === 0 && !parsed.hadMalformedBlock) {
          // No tool syntax at all — this is the model's plain-text answer.
          // Strip both markdown fences and any reasoning tag before it
          // reaches the user — a legacy-mode response may otherwise
          // contain an inline <<TOOL>>...<<END>> block or think tag that
          // must never surface verbatim. Still runs through the completion
          // gate below, same as native mode.
          const answer = stripReasoningTags(stripMarkdownFencesFromText(raw));
          const outcome = resolveEmptyTurn(raw, answer);
          if (outcome.kind === "continue") {
            const stopped = stopIfUnproductive();
            if (stopped) {
              return stopped;
            }
            continue;
          }
          emitToken(outcome.content);
          reportStatus("done", outcome.ok ? "✓" : "⚠", "Done");
          return { content: outcome.content, ok: outcome.ok };
        }
        content = raw;
        toolCalls = parsed.calls;
        if (parsed.calls.length === 0 && parsed.hadMalformedBlock) {
          unproductiveStreak += 1;
          messages.push({ role: "assistant", content: raw });
          messages.push({
            role: "user",
            content:
              "Your tool call was not valid JSON. Re-emit it as a single-line <<TOOL>>{...}<<END>> block.",
          });
          const stopped = stopIfUnproductive();
          if (stopped) {
            return stopped;
          }
          continue;
        }
      }
    } finally {
      // Safety net for abort/error paths that never reach a normal close
      // below — idempotent, so a no-op after one. Mirrors subagent.ts's
      // per-iteration think-frame handling.
      const flushed = contentThinkScanner.flush();
      if (flushed.length > 0) {
        thinkFrames.delta(flushed);
      }
      thinkFrames.finish(null);
    }

    if (toolCalls.length === 0) {
      // Native mode's direct-answer path: no tool call this turn. Runs
      // through the same completion gate the legacy branch above uses —
      // "no tool call" alone no longer means "the turn is finished".
      const answer = stripReasoningTags(content);
      const outcome = resolveEmptyTurn(content, answer);
      if (outcome.kind === "continue") {
        const stopped = stopIfUnproductive();
        if (stopped) {
          return stopped;
        }
        continue;
      }
      emitToken(outcome.content);
      reportStatus("done", outcome.ok ? "✓" : "⚠", "Done");
      return { content: outcome.content, ok: outcome.ok };
    }

    // Run every tool call the model emitted this turn, in order — see
    // runToolCalls's docstring for why this is NOT one assistant turn
    // carrying every `tool_calls` entry. A response with more calls than
    // the cap has the excess deferred back to the model instead of run.
    let callsToRun = toolCalls;
    let deferredCallNames: string[] = [];
    if (toolCalls.length > MAX_TOOL_CALLS_PER_ITERATION) {
      deferredCallNames = toolCalls
        .slice(MAX_TOOL_CALLS_PER_ITERATION)
        .map((call) => call.name);
      callsToRun = toolCalls.slice(0, MAX_TOOL_CALLS_PER_ITERATION);
    }

    // Narrate before acting. In native tool-calling mode `content` is pure
    // prose — tool calls are structured separately, never embedded in it —
    // so it's safe to show immediately instead of only at the final answer,
    // which is what previously made everything between tool calls invisible.
    // Legacy/text mode is deliberately excluded: there, `content` is the raw
    // response and still contains the <<TOOL>>...<<END>> block this
    // iteration is about to execute, so emitting it would leak that syntax.
    //
    // Skipped when the batch contains `finish`: its summary IS the
    // user-facing answer (emitted below once the batch resolves), so any
    // prose here would just be the same answer printed twice. Keyed on
    // `finish` specifically, not on `done` generally — `update_plan`'s
    // user-skip path also returns done:true but yields a fixed one-liner,
    // where narration ahead of it is still useful context.
    const batchEndsTurn = callsToRun.some((call) => call.name === "finish");
    if (configuredSupportsTools && !batchEndsTurn) {
      const narration = stripReasoningTags(content).trim();
      if (narration.length > 0) {
        emitToken(`${narration}\n\n`);
      }
    }

    const batchResult = await runToolCalls(
      content,
      callsToRun,
      activeToolHandlers,
    );
    toolCallsExecuted += batchResult.executed;
    unproductiveStreak =
      batchResult.executed === 0 ? unproductiveStreak + 1 : 0;
    if (batchResult.executed > 0) {
      stallsSinceProgress = 0;
    }

    if (batchResult.done) {
      const summary = stripReasoningTags(batchResult.summary);
      emitToken(summary);
      reportStatus("done", batchResult.ok === false ? "⚠" : "✓", "Done");
      return { content: summary, ok: batchResult.ok !== false };
    }

    if (deferredCallNames.length > 0) {
      messages.push({
        role: "user",
        content: `Only the first ${MAX_TOOL_CALLS_PER_ITERATION} tool calls in that response were run this turn. Skipped: ${deferredCallNames.join(", ")}. Re-issue any of those that are still needed.`,
      });
    }

    const stopped = stopIfUnproductive();
    if (stopped) {
      return stopped;
    }
  }

  logger.warn({ taskId }, "[AgentTurn] exceeded maximum iterations");
  const ceilingMessage =
    "[agent stopped: exceeded the maximum number of tool calls for one turn]";
  emitToken(ceilingMessage);
  reportStatus("done", "⚠", "Done");
  return {
    content: ceilingMessage,
    ok: false,
  };
};

/**
 * Runs one unified agent turn to completion.
 *
 * @throws {@link AbortError} When `params.signal` is aborted mid-turn.
 */
export const runAgentTurn = async (
  deps: AgentTurnDeps,
  params: AgentTurnParams,
): Promise<AgentTurnResult> => {
  const {
    taskId,
    taskText,
    contextHeader,
    skillBody,
    clientEnv,
    perConn,
    modelOverrides,
    approvalMode,
    maxSubagents,
    emit,
    emitToken,
    signal,
    contextWindow,
  } = params;
  const { ollama, config, experienceRecorder } = deps;

  const {
    agentModel,
    agentTemperature,
    configuredSupportsTools,
    keepAlive,
    effort,
  } = await resolveTurnConfig(config, modelOverrides);

  // Full toolset vs. the plan-mode-restricted subset: in plan mode, nothing
  // that mutates the workspace (write_file, edit_file, run_command,
  // run_steps_parallel) is offered to the model until a proposed plan is
  // actually approved via update_plan — read_file/update_plan/finish/search
  // stay available so the agent can still investigate and propose a plan.
  // This is what makes plan mode actually stop before executing, rather
  // than relying on the model to volunteer not to call those tools.
  const mcpSchemas = perConn.mcpTools?.map((entry) => entry.schema);
  const fullRegistry = createAgentTurnToolRegistry(mcpSchemas);
  const PLAN_MODE_ALLOWED_TOOLS = new Set([
    "read_file",
    "update_plan",
    "finish",
  ]);
  // MCP tools are read-only-eligible per-tool, not per-name-prefix — each
  // one's readOnly flag is resolved client-side (from the MCP spec's
  // annotations.readOnlyHint, or the server's configured default) and
  // synced alongside its schema. Missing from the map (a non-MCP tool)
  // falls through to `false`, which is correct: only PLAN_MODE_ALLOWED_TOOLS
  // and tools explicitly marked read-only are offered in plan mode.
  const mcpReadOnlyByName = new Map(
    (perConn.mcpTools ?? []).map((entry) => [
      entry.schema.function.name,
      entry.readOnly,
    ]),
  );
  const isPlanModeAllowed = (name: string): boolean =>
    PLAN_MODE_ALLOWED_TOOLS.has(name) || mcpReadOnlyByName.get(name) === true;
  const restrictedRegistry = fullRegistry.filter((tool) =>
    isPlanModeAllowed(tool.schema.function.name),
  );

  const resumeBlock = buildResumeBlock(perConn.activePlan ?? []);
  const systemText = buildAgentTurnSystemText({
    skillContent: skillBody,
    contextHeader,
    clientEnv,
    // The catalog/teaching block always describes the full toolset
    // (informational); which tools are actually offered per-call is gated
    // below. In legacy/text mode this is the model's ONLY source for the
    // <<TOOL>>{...}<<END>> wire syntax — see buildAgentTurnSystemText.
    toolSchemas: getToolSchemas(fullRegistry),
    configuredSupportsTools,
    resumeBlock: resumeBlock ?? undefined,
    planModeActive: approvalMode === "plan",
  });

  const messages: Message[] = [
    { role: "system", content: systemText },
    // Short, bounded history of past turns on this connection — see
    // conversationMemory.ts. Empty when there's no prior history (a fresh
    // connection, or right after `/new`), so this is a no-op in that case
    // and `messages` is exactly `[system, task]` as before.
    ...toHistoryMessages(perConn.conversation),
    { role: "user", content: taskText },
  ];
  // How much of `messages` is the seed (system + history + current task),
  // never eligible for compaction — see contextCompaction.ts's
  // selectCompactionRange. Captured right after the seed is built, before
  // any tool-call turn appends to it.
  const protectedPrefixCount = messages.length;

  const trackers: ToolHandlerContext["trackers"] = {
    filesReadThisTask: new Set(),
    filesWrittenThisTask: new Set(),
    filesVerifiedThisTask: new Set(),
    verifyCommandPassed: false,
    completedSetupCommands: new Set(),
    failedCommandAttempts: new Map(),
  };

  // In plan mode, every update_plan call is gated on user approval until one
  // is actually approved — a "revise" decision must re-gate the next
  // proposal, not wave it through. Once approved, mutating tools unlock
  // (see `planApproved` below) and further update_plan calls (marking steps
  // in_progress/done) just update state without re-prompting.
  let planApproved = approvalMode !== "plan";

  // The completion gate's own turn-local view of the checklist. Distinct
  // from `perConn.activePlan`: that field is cleared only by `/new` and
  // survives across unrelated tasks, so gating on it directly would nag a
  // later, unconnected message with a stale checklist. `planThisTurn` starts
  // seeded ONLY when this turn was actually told (via `resumeBlock`, in the
  // system prompt above) to continue a carried-over plan — otherwise it
  // starts `null` and is populated the first time this turn calls
  // `update_plan` itself, via `emitPlanUpdate`, the single write point both
  // `updatePlan` and `runStepsParallel` share.
  let planThisTurn: PlanStep[] | null = resumeBlock
    ? (perConn.activePlan ?? null)
    : null;

  const emitPlanUpdate = (steps: PlanStep[], note?: string): void => {
    perConn.activePlan = steps;
    planThisTurn = steps;
    emit({ kind: "plan-update", steps, note });
  };

  const updatePlan: NonNullable<
    ToolHandlerContext["planTools"]
  >["updatePlan"] = async (inputSteps, note) => {
    const steps: PlanStep[] = inputSteps.map((step) => ({
      id: step.id,
      text: step.text,
      status: step.status ?? "pending",
      dependsOn: step.dependsOn,
    }));
    emitPlanUpdate(steps, note);

    if (planApproved) {
      return { decision: "continue" };
    }
    const response = await perConn.planBroker.request({
      task: taskText,
      steps: steps.map((step) => step.text),
      risks: [],
      agents: [
        {
          id: 1,
          label: "plan",
          steps: steps.map((step) => step.text),
          dependsOn: [],
        },
      ],
      agentCount: 1,
      execution: "sequential",
      modeLabel: modeLabelFromMaxAgents(maxSubagents),
    });
    if (response.decision === "skip") {
      return { decision: "stop" };
    }
    if (response.decision === "edit") {
      return { decision: "revise", feedback: response.feedback ?? "" };
    }
    planApproved = true;
    return { decision: "continue" };
  };

  const emitSubagentStatus: ToolHandlerContext["emitSubagentStatus"] = (
    stage,
    icon,
    message,
  ) => {
    emit({
      kind: "status",
      source: "agent",
      stage: stage === "done" ? "ready" : "understanding",
      icon,
      message,
    });
  };

  // Tools and system prompt for one concurrent step dispatched by
  // run_steps_parallel — built once per turn, not per step, since neither
  // depends on which steps end up running.
  const workerRegistry = createWorkerToolRegistry(mcpSchemas);
  const workerSystemText = buildWorkerSystemText({
    clientEnv,
    toolSchemas: getToolSchemas(workerRegistry),
    configuredSupportsTools,
  });

  /** Completes one concurrent step through the exact same loop as the top-level turn. */
  const runWorkerStep = async (
    subtask: PlannedSubtask,
    sessionContext: string,
  ): Promise<ToolResultSummary> => {
    const workerMessages: Message[] = [
      { role: "system", content: workerSystemText },
      {
        role: "user",
        content:
          sessionContext.length > 0
            ? `${subtask.text}${sessionContext}`
            : subtask.text,
      },
    ];
    const workerTrackers: ToolHandlerContext["trackers"] = {
      filesReadThisTask: new Set(),
      filesWrittenThisTask: new Set(),
      filesVerifiedThisTask: new Set(),
      verifyCommandPassed: false,
      completedSetupCommands: new Set(),
      failedCommandAttempts: new Map(),
    };
    const buildWorkerToolContext = (): ToolHandlerContext => ({
      taskId,
      subtask: subtask.text,
      agentSource: { agentId: subtask.agentId, agentLabel: subtask.agentLabel },
      emitSubagentStatus: () => {},
      messages: workerMessages,
      workspace: perConn.workspace,
      terminal: perConn.terminal,
      recorder: experienceRecorder,
      escalationCount: 0,
      maxEscalations: 0,
      modelOverrides,
      trackers: workerTrackers,
      thinkText: null,
      commandPlan: emptyCommandPlan() as CommandPlan,
      // No planTools — a step doesn't own the parent's checklist and can't
      // recursively fan out its own parallel batch (see createWorkerToolRegistry).
    });

    // Fully hidden from the client: no think frames, no visible tokens, no
    // status pings — the checklist update in `runStepsParallel` below is
    // the only trace of this step that ever reaches the user.
    const result = await runToolCallLoop({
      taskId,
      ollama,
      agentModel,
      agentTemperature,
      configuredSupportsTools,
      effort,
      keepAlive,
      messages: workerMessages,
      getActiveRegistry: () => workerRegistry,
      buildToolContext: buildWorkerToolContext,
      emit: () => {},
      emitToken: () => {},
      reportStatus: () => {},
      signal,
      contextWindow,
      protectedPrefixCount: workerMessages.length,
      // A worker step's emit/emitToken are no-ops (see above) — reasoning
      // display would never reach the user, so skip the extra latency.
      enableReasoning: false,
    });

    return {
      summary: result.content,
      keyFindings: [],
      filesTouched: Array.from(workerTrackers.filesWrittenThisTask),
      ok: result.ok,
    };
  };

  const runStepsParallel: NonNullable<
    ToolHandlerContext["planTools"]
  >["runStepsParallel"] = async (stepIds) => {
    const currentPlan = perConn.activePlan ?? [];
    const targetSteps = currentPlan.filter((step) => stepIds.includes(step.id));
    if (targetSteps.length !== stepIds.length) {
      return {
        ok: false,
        summary:
          "Some stepIds were not found in the current checklist — call update_plan first to declare them.",
      };
    }

    const subtasks: PlannedSubtask[] = targetSteps.map((step, index) => ({
      id: step.id,
      text: step.text,
      // The checklist's real dependsOn, filtered to ids WITHIN this batch.
      // A dependency on a step outside stepIds is already satisfied — the
      // model only requests steps it considers ready — and must be dropped
      // rather than passed through: readyQueue.ts's createReadyQueue seeds
      // `ready` from dependsOn.length === 0 and dependenciesDone() checks
      // `completed.has(id)` for every dependency, so an id this pool never
      // tracks (because it's not one of this batch's own subtasks) would
      // never enter `completed` — that subtask would wait forever and trip
      // the deadlock guard below instead of ever running.
      dependsOn: (step.dependsOn ?? []).filter((id) => stepIds.includes(id)),
      agentId: index + 1,
      agentLabel: `step-${step.id}`,
    }));
    const plan: SubagentPlan = {
      subtasks,
      risks: [],
      commandPlan: emptyCommandPlan() as CommandPlan,
      execution: "parallel",
      agentCount: subtasks.length,
    };
    const resultMap = new Map<number, ToolResultSummary>();

    const applyResults = (): PlanStep[] =>
      currentPlan.map((step) => {
        const result = resultMap.get(step.id);
        return result
          ? {
              ...step,
              status: result.ok ? ("done" as const) : ("failed" as const),
            }
          : step;
      });

    try {
      const isLocalProvider = contextWindow > 0;
      // The user's explicit numParallel override, if any (ollama/runtimeTuning.ts)
      // — `undefined` otherwise, since Ollama's own OLLAMA_NUM_PARALLEL is
      // left unset by default so Ollama can self-detect a value for the
      // real device (see that module's remarks on why a machine-memory
      // guess here would be wrong on most non-unified-memory hardware).
      // When undefined, workerCountFor falls back to its own conservative
      // default rather than trying to match a number we don't know. A
      // config read is cheap, so recomputing per batch costs nothing and
      // always reflects the current config (a `/set numParallel` mid-session
      // takes effect immediately).
      const localProviderCeiling = isLocalProvider
        ? (await resolveOllamaTuning(config)).numParallel
        : undefined;
      const ordered = await runAgentPool({
        plan,
        // Respects the session's ::focus/::collab/::max concurrency cap —
        // the same maxSubagents this turn was given (see runAgentTurn's
        // params) — rather than always maximizing. workerCountFor still
        // gives every step its own worker up to that cap; a lower cap just
        // makes the batch run some steps sequentially instead of refusing
        // to dispatch them, so ::focus mode is still honored even if the
        // model calls this tool.
        maxSubagents,
        resultMap,
        runSubtask: runWorkerStep,
        // No frames from a running batch reach the client — the checklist
        // update below is the only visible trace of this batch running.
        emitStatus: () => {},
        signal,
        // `contextWindow > 0` is the same "is this role on Ollama" proxy
        // `numCtx` above uses — resolved once in orchestratorPipeline.ts as
        // `agentNumCtx` only when `agentProviderName === "ollama"`, 0
        // otherwise. Caps concurrent workers so a batch of independent
        // steps doesn't fire more simultaneous requests than one local GPU
        // can usefully serve — see `readyQueue.ts`'s `workerCountFor`.
        isLocalProvider,
        localProviderCeiling,
      });
      emitPlanUpdate(applyResults());
      return {
        ok: true,
        summary: ordered.map((r) => `Step ${r.id}: ${r.content}`).join("\n\n"),
      };
    } catch (error) {
      // A subtask failure throws from runAgentPool — resultMap is still
      // mutated in place with whatever completed before the throw (see its
      // own docstring), so the checklist can still reflect partial progress.
      emitPlanUpdate(applyResults());
      if (error instanceof AbortError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: `Parallel batch failed: ${message}` };
    }
  };

  const buildToolContext = (): ToolHandlerContext => ({
    taskId,
    subtask: taskText,
    agentSource: { agentId: 0, agentLabel: "agent" },
    emitSubagentStatus,
    messages,
    workspace: perConn.workspace,
    terminal: perConn.terminal,
    recorder: experienceRecorder,
    escalationCount: 0,
    maxEscalations: 0,
    modelOverrides,
    trackers,
    thinkText: null,
    commandPlan: emptyCommandPlan() as CommandPlan,
    planTools: { updatePlan, runStepsParallel },
  });

  const result = await runToolCallLoop({
    taskId,
    ollama,
    agentModel,
    agentTemperature,
    configuredSupportsTools,
    keepAlive,
    effort,
    messages,
    // Recomputed every iteration — `planApproved` can flip mid-turn (the
    // model's previous update_plan call may have just been approved), so
    // the very next model call must see the unlocked toolset immediately.
    getActiveRegistry: () => (planApproved ? fullRegistry : restrictedRegistry),
    buildToolContext,
    emit,
    emitToken,
    reportStatus: emitSubagentStatus,
    signal,
    checkCompletion: () => completionGap({ planSteps: planThisTurn, trackers }),
    contextWindow,
    protectedPrefixCount,
    // "low" effort skips the REASON phase entirely (1 model call per
    // iteration, the pre-reasoner behavior); every other level runs it with
    // that level's refinement/verification caps — see `reasoner.ts`.
    enableReasoning: effort !== "low",
    // Built-in tools carry readOnly on the handler itself; MCP tools carry
    // it separately on their perConn.mcpTools entry (mcpReadOnlyByName,
    // built above alongside the plan-mode registry filter) — this checks
    // both, so a read-only MCP tool batches concurrently the same as
    // read_file does.
    isToolReadOnly: (handler) =>
      handler.readOnly === true ||
      mcpReadOnlyByName.get(handler.schema.function.name) === true,
  });

  // Record this exchange for the next turn on this connection — see
  // conversationMemory.ts. Stored regardless of `ok`, so a follow-up like
  // "try that again" or "implement that plan" still has the failed attempt
  // to refer back to.
  perConn.conversation = recordExchange(
    perConn.conversation ?? [],
    taskText,
    result.content,
  );
  return result;
};
