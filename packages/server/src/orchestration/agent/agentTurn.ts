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
import type { TaskApprovalMode } from "@atlasagents/shared";
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
import { buildAgentTurnSystemText, buildWorkerSystemText } from "./agentPrompt.js";
import { createThinkFrameEmitter, createThinkTagScanner } from "../thinkStream.js";
import type { ThinkTagScanner } from "../thinkStream.js";
import { runAgentPool } from "../orchestrator/orchestratorPipelineHelpers.js";
import { AbortError } from "../../errors/index.js";
import { logger } from "../../utils/logger.js";

/** Safety ceiling on tool-call turns in one agent turn. Most turns finish well under this. */
const MAX_AGENT_TURN_ITERATIONS = 60;

/**
 * Recognized reasoning-tag names to scan for in model output.
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
};

/** Resolves agent model/temperature/capability config, honoring per-task overrides. */
const resolveTurnConfig = async (
  config: IConfigManager,
  overrides: TaskModelOverrides | undefined,
): Promise<{
  agentModel: string;
  agentTemperature: number;
  configuredSupportsTools: boolean;
}> => {
  const agentModel = overrides?.agentModel?.trim() || (await config.getAgentModel());
  const agentTemperature =
    overrides?.agentTemp ?? (await config.getAgentTemperature());
  const configuredSupportsTools =
    overrides?.agentModelSupportsTools ??
    (await config.getAgentModelSupportsTools());
  return { agentModel, agentTemperature, configuredSupportsTools };
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
  messages: Message[];
  /** Re-invoked every iteration — lets the top-level turn's plan-mode gating flip mid-loop. */
  getActiveRegistry: () => ToolHandler[];
  buildToolContext: () => ToolHandlerContext;
  emit: (frame: TaskFrame) => void;
  emitToken: (text: string) => void;
  reportStatus: ToolHandlerContext["emitSubagentStatus"];
  signal: AbortSignal;
}): Promise<AgentTurnResult> => {
  const {
    taskId,
    ollama,
    agentModel,
    agentTemperature,
    configuredSupportsTools,
    messages,
    getActiveRegistry,
    buildToolContext,
    emit,
    emitToken,
    reportStatus,
    signal,
  } = params;

  const executeTool = async (
    call: ParsedToolCall,
    toolHandlers: Map<string, ToolHandler>,
  ): Promise<{
    done: boolean;
    ok?: boolean;
    summary: string;
    feedback: string;
  }> => {
    const handler = toolHandlers.get(call.name);
    if (!handler) {
      return { done: false, summary: "", feedback: `Unknown tool: ${call.name}` };
    }
    return handler.execute(call.args, buildToolContext());
  };

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

  reportStatus("thinking", "◌", "Thinking…");

  for (
    let iteration = 0;
    iteration < MAX_AGENT_TURN_ITERATIONS;
    iteration += 1
  ) {
    if (signal.aborted) {
      throw new AbortError("Agent turn aborted");
    }

    const activeRegistry = getActiveRegistry();
    const activeToolSchemas = getToolSchemas(activeRegistry);
    const activeToolHandlers = getToolHandlerMap(activeRegistry);

    let content = "";
    let toolCalls: ParsedToolCall[] = [];

    // Live-scans both channels for a recognized reasoning tag (see
    // REASONING_TAG_NAMES) so any inline "<think>..." a model emits renders
    // as a "thinking" block instead of leaking into the visible answer.
    // Content is NOT streamed to emitToken live here — unlike a scanner
    // that only extracts think text (discarding everything else, as
    // subagent.ts's does), there's no cheap way to also pass through
    // non-think text live without risking a partial tag prefix (e.g. "<th")
    // reaching the user a moment before it turns out to be the start of
    // "<think>". The full response is available as soon as the call
    // resolves either way, so the answer is flushed once, cleaned, right
    // below instead — see the toolCalls.length === 0 branch.
    const contentThinkScanner = createThinkTagScanner(REASONING_TAG_NAMES);
    const reasoningThinkScanner = createThinkTagScanner(REASONING_TAG_NAMES);
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
            onThinkToken: pushThinkFrom(reasoningThinkScanner),
          },
          pushThinkFrom(contentThinkScanner),
        );
        content = result.content;
        toolCalls = result.toolCalls.map((call) => ({ name: call.name, args: call.args }));
      } else {
        let raw = "";
        for await (const token of ollama.chatStream(agentModel, messages, {
          temperature: agentTemperature,
          signal,
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
          // must never surface verbatim.
          const answer = stripReasoningTags(
            stripMarkdownFencesFromText(raw),
          );
          emitToken(answer);
          reportStatus("done", "✓", "Done");
          return { content: answer, ok: true };
        }
        content = raw;
        toolCalls = parsed.calls;
        if (parsed.calls.length === 0 && parsed.hadMalformedBlock) {
          messages.push({ role: "assistant", content: raw });
          messages.push({
            role: "user",
            content:
              "Your tool call was not valid JSON. Re-emit it as a single-line <<TOOL>>{...}<<END>> block.",
          });
          continue;
        }
      }
    } finally {
      // Safety net for abort/error paths that never reach a normal close
      // below — idempotent, so a no-op after one. Mirrors subagent.ts's
      // per-iteration think-frame handling.
      for (const scanner of [contentThinkScanner, reasoningThinkScanner]) {
        const flushed = scanner.flush();
        if (flushed.length > 0) {
          thinkFrames.delta(flushed);
        }
      }
      thinkFrames.finish(null);
    }

    if (toolCalls.length === 0) {
      // Native mode's direct-answer path: no tool call this turn — flush
      // the complete answer now, with any reasoning tag stripped as a
      // defensive safety net (the live scanner above already caught the
      // common case; this covers a tag it wasn't watching for or one that
      // was never actually closed).
      const answer = stripReasoningTags(content);
      emitToken(answer);
      reportStatus("done", "✓", "Done");
      return { content: answer, ok: true };
    }

    if (toolCalls.length > 1) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: "You called more than one tool. Call exactly one tool per turn.",
      });
      continue;
    }

    const call = toolCalls[0];
    if (!call) {
      continue;
    }

    const result = await executeTool(call, activeToolHandlers);
    if (result.done) {
      reportStatus("done", result.ok === false ? "⚠" : "✓", "Done");
      return { content: result.summary, ok: result.ok !== false };
    }
    appendToolTurnToHistory(content, call, result.feedback);
  }

  logger.warn({ taskId }, "[AgentTurn] exceeded maximum iterations");
  return {
    content:
      "[agent stopped: exceeded the maximum number of tool calls for one turn]",
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
  } = params;
  const { ollama, config, experienceRecorder } = deps;

  const { agentModel, agentTemperature, configuredSupportsTools } =
    await resolveTurnConfig(config, modelOverrides);

  // Full toolset vs. the plan-mode-restricted subset: in plan mode, nothing
  // that mutates the workspace (write_file, edit_file, run_command,
  // run_steps_parallel) is offered to the model until a proposed plan is
  // actually approved via update_plan — read_file/update_plan/finish/search
  // stay available so the agent can still investigate and propose a plan.
  // This is what makes plan mode actually stop before executing, rather
  // than relying on the model to volunteer not to call those tools.
  const mcpSchemas = perConn.mcpTools?.map((entry) => entry.schema);
  const fullRegistry = createAgentTurnToolRegistry(mcpSchemas);
  const PLAN_MODE_ALLOWED_TOOLS = new Set(["read_file", "update_plan", "finish"]);
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
    { role: "user", content: taskText },
  ];

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

  const emitPlanUpdate = (steps: PlanStep[], note?: string): void => {
    perConn.activePlan = steps;
    emit({ kind: "plan-update", steps, note });
  };

  const updatePlan: NonNullable<ToolHandlerContext["planTools"]>["updatePlan"] =
    async (inputSteps, note) => {
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
          { id: 1, label: "plan", steps: steps.map((step) => step.text), dependsOn: [] },
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
      messages: workerMessages,
      getActiveRegistry: () => workerRegistry,
      buildToolContext: buildWorkerToolContext,
      emit: () => {},
      emitToken: () => {},
      reportStatus: () => {},
      signal,
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
      dependsOn: [],
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
          ? { ...step, status: result.ok ? ("done" as const) : ("failed" as const) }
          : step;
      });

    try {
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

  return runToolCallLoop({
    taskId,
    ollama,
    agentModel,
    agentTemperature,
    configuredSupportsTools,
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
  });
};
