/**
 * <Summary>
 * What it does:
 *   Shared TypeScript shapes for the orchestration layer (Advisor, Agent,
 *   AdvisorOrchestrator) and their Ollama message payloads.
 *
 * Used by:
 *   - Advisor, Agent, AdvisorOrchestrator — message arrays and plan parsing.
 *   - interfaces.ts — method signatures on IOllamaClient and collaborators.
 *
 * Produced by:
 *   - Advisor.plan — builds AdvisorPlan from model JSON.
 *   - AdvisorOrchestrator.runTask — builds OrchestrationOutcome for recording.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Represents one authenticated RSocket session for orchestration logging
 *   and future per-user policy; mirrors Router.Session shape.
 *
 * Used by:
 *   - AdvisorOrchestrator.runTask — first parameter.
 *
 * Produced by:
 *   - RSocketServer — same fields as packages/server/src/routing/router.ts Session.
 * </Summary>
 */
export interface SessionInfo {
  /** Resolved user id after AuthMiddleware.validate. */
  userId: string

  /** Stable id for this TCP/RSocket connection. */
  requesterId: string
}

/** Per-task model settings from the CLI (overrides server config when set). */
export type TaskModelOverrides = {
  advisorModel?: string
  agentModel?: string
  advisorTemp?: number
  agentTemp?: number
  /** When true, use native Ollama tool_calls for the agent model. */
  agentModelSupportsTools?: boolean
  /** When true, agent logs raw turns and parsed tools to stderr. */
  debug?: boolean
}

/**
 * <Summary>
 * What it does:
 *   One chat message in an Ollama /api/chat request body.
 *
 * Used by:
 *   - IOllamaClient.chat, IOllamaClient.chatStream — messages array.
 *   - Advisor.plan, Advisor.advise, Agent.run — conversation construction.
 *
 * Produced by:
 *   - Advisor, Agent — assemble role/content pairs before calling Ollama.
 * </Summary>
 */
export interface Message {
  /** Message role for the chat API. */
  role: 'system' | 'user' | 'assistant' | 'tool'

  /** Plain text body for this turn. */
  content: string

  /** Native tool calls on assistant turns (Ollama /api/chat). */
  tool_calls?: {
    function: { name: string; arguments: Record<string, unknown> }
  }[]

  /** Tool name when role is tool (Ollama tool result shape). */
  tool_name?: string
}

/**
 * <Summary>
 * What it does:
 *   Sampling options forwarded to Ollama for one generation.
 *
 * Used by:
 *   - IOllamaClient.chat, IOllamaClient.chatStream — options argument.
 *
 * Produced by:
 *   - Advisor, Agent — from IConfigManager temperature getters.
 * </Summary>
 */
export interface ChatOptions {
  /** Sampling temperature (0 = deterministic, higher = more random). */
  temperature: number;
  /** When aborted, in-flight Ollama streaming requests are cancelled. */
  signal?: AbortSignal;
}

/**
 * <Summary>
 * What it does:
 *   One node in the advisor-produced execution DAG; dependsOn lists
 *   prerequisite subtask ids that must finish before this one runs.
 *
 * Used by:
 *   - AdvisorOrchestrator — topological waves and context stitching.
 *
 * Produced by:
 *   - Advisor.plan — parsed from strict JSON model output.
 * </Summary>
 */
export interface PlannedSubtask {
  /** Stable positive integer id unique within one plan. */
  id: number

  /** Action description for the agent. */
  text: string

  /** Prerequisite subtask ids; empty means this subtask can run in the first wave. */
  dependsOn: number[]

  /** Agent group id for UI and status display. */
  agentId: number

  /** Human label for the agent group (setup, implementation, etc.). */
  agentLabel: string
}

/**
 * <Summary>
 * What it does:
 *   Full decomposition of a user task into ordered DAG nodes for execution.
 *
 * Used by:
 *   - AdvisorOrchestrator — drives waves of Agent.run calls.
 *
 * Produced by:
 *   - Advisor.plan — after JSON parse and validation.
 * </Summary>
 */
/** Shell commands parsed from advisor-think COMMAND PLAN (used for run_command classification). */
export interface CommandPlan {
  setupCommands: string[];
  verifyCommands: string[];
  runProjectCommands: string[];
}

export const emptyCommandPlan = (): CommandPlan => ({
  setupCommands: [],
  verifyCommands: [],
  runProjectCommands: [],
});

export interface AdvisorPlan {
  /** Ordered list of planned subtasks (order is not execution order; dependsOn is). */
  subtasks: PlannedSubtask[]

  /** Risks parsed from advisor-think VERIFY section (may be empty). */
  risks: string[]

  /** Commands for setup / verify / run-project classification (from advisor-think). */
  commandPlan: CommandPlan

  /** How subtasks run relative to each other. */
  execution: 'parallel' | 'sequential' | 'mixed'

  /** Unique agent group count in this plan. */
  agentCount: number
}

/** User choice after viewing the plan panel (not agent execution turns). */
export type PlanDecision = "implement" | "skip" | "edit"

/**
 * Client answer for confirm-plan. `steps` = final plan line strings (subtask descriptions).
 */
export type PlanReviewResponse = {
  decision: PlanDecision
  steps?: string[]
}

/**
 * <Summary>
 * What it does:
 *   One completed subtask result keyed by plan id for combine and recording.
 *
 * Used by:
 *   - Advisor.combine — formats prior work for the final answer.
 *   - IExperienceRecorder.finish — persistence payload.
 *
 * Produced by:
 *   - AdvisorOrchestrator — after each Agent.run wave completes.
 * </Summary>
 */
/** Structured result from an agent subtask finish tool call. */
export interface ToolResultSummary {
  /** One-sentence accomplishment summary. */
  summary: string

  /** Short bullets for dependent subtasks. */
  keyFindings: string[]

  /** Paths written during this subtask (auto-tracked, not model-provided). */
  filesTouched: string[]
}

export interface SubtaskResult {
  /** Matches PlannedSubtask.id. */
  id: number

  /** Full agent output text (may include failure summary after max retries). */
  content: string
}

/**
 * <Summary>
 * What it does:
 *   Serializable bundle passed to ExperienceRecorder.finish after one task run.
 *
 * Used by:
 *   - IExperienceRecorder.finish — audit trail and downstream pattern mining.
 *
 * Produced by:
 *   - AdvisorOrchestrator.runTask — success or failure path before return.
 * </Summary>
 */
export interface OrchestrationOutcome {
  /** True when the DAG completed without cycle deadlock and finish emitted. */
  ok: boolean

  /** Advisor plan used for execution (may be partial if planning failed early). */
  plan: AdvisorPlan

  /** Subtask results in ascending id order when ok; otherwise best-effort partial. */
  results: SubtaskResult[]

  /** Human-readable error when ok is false (cycle, abort, planning error propagated). */
  error?: string
}
