/**
 * Shared TypeScript shapes for the orchestration layer.
 *
 * @remarks
 * Defines interfaces and types used by Agent, Subagent, and AgentOrchestrator
 * for message arrays, plan parsing, and Ollama message payloads. These shapes
 * are used throughout the orchestration layer to ensure type safety and
 * consistency.
 */

/**
 * Represents one authenticated RSocket session for orchestration logging.
 *
 * @remarks
 * Mirrors Router.Session shape. Used for per-user policy and logging.
 * Passed as the first parameter to AgentOrchestrator.runTask.
 */
export interface SessionInfo {
  /** Resolved user id after AuthMiddleware.validate */
  userId: string;

  /** Stable id for this TCP/RSocket connection */
  requesterId: string;
}

/**
 * Per-task model settings from the CLI.
 *
 * @remarks
 * Overrides server config when set. Allows users to specify different models
 * for agent and subagent, adjust temperature, enable native tool_calls, and
 * enable debug logging for a single task.
 */
export type TaskModelOverrides = {
  /** Override subagent model */
  agentModel?: string;
  /** Override subsubagent model */
  subagentModel?: string;
  /** Override the provider serving the agent role (e.g. "ollama", "vllm-gpu") */
  agentProvider?: string;
  /** Override the provider serving the subagent role */
  subagentProvider?: string;
  /** Override subagent temperature */
  agentTemp?: number;
  /** Override subsubagent temperature */
  subagentTemp?: number;
  /** When true, use native Ollama tool_calls for the subagent model */
  agentModelSupportsTools?: boolean;
  /** When true, use native Ollama tool_calls for the subsubagent model */
  subagentModelSupportsTools?: boolean;
  /** When true, subagent logs raw turns and parsed tools to stderr */
  debug?: boolean;
};

/**
 * One chat message in an Ollama /api/chat request body.
 *
 * @remarks
 * Used by IOllamaClient.chat and IOllamaClient.chatStream for the messages array.
 * Also used by Agent.plan, Agent.advise, and Agent.run for conversation
 * construction. Supports native tool_calls on assistant turns and tool results.
 */
export interface Message {
  /** Message role for the chat API */
  role: "system" | "user" | "assistant" | "tool";

  /** Plain text body for this turn */
  content: string;

  /** Native tool calls on assistant turns (Ollama /api/chat) */
  tool_calls?: {
    function: { name: string; arguments: Record<string, unknown> };
  }[];

  /** Tool name when role is tool (Ollama tool result shape) */
  tool_name?: string;
}

/**
 * Sampling options forwarded to Ollama for one generation.
 *
 * @remarks
 * Used by IOllamaClient.chat and IOllamaClient.chatStream as the options argument.
 * Includes temperature, abort signal, and thinking/reasoning token options for
 * models that support them.
 */
export interface ChatOptions {
  /** Sampling temperature (0 = deterministic, higher = more random) */
  temperature: number;
  /** When aborted, in-flight Ollama streaming requests are cancelled */
  signal?: AbortSignal;
  /**
   * When true, chatStream also yields reasoning tokens from message.thinking.
   * Used by the agent for models that emit plans in the thinking channel.
   * Automatically sets Ollama's `think` request field when unset.
   */
  includeThinking?: boolean;
  /**
   * Ollama think parameter (boolean or level). When includeThinking is true and
   * think is unset, the client defaults to `true`.
   */
  think?: boolean | "low" | "medium" | "high" | "max";
}

/**
 * One node in the agent-produced execution DAG.
 *
 * @remarks
 * Represents a single subtask with dependencies. The dependsOn array lists
 * prerequisite subtask ids that must finish before this one runs. Used by
 * AgentOrchestrator for topological waves and context stitching.
 */
export interface PlannedSubtask {
  /** Stable positive integer id unique within one plan */
  id: number;

  /** Action description for the agent */
  text: string;

  /** Prerequisite subtask ids; empty means this subtask can run in the first wave */
  dependsOn: number[];

  /** Agent group id for UI and status display */
  agentId: number;

  /** Human label for the agent group (setup, implementation, etc.) */
  agentLabel: string;
}

/**
 * Shell commands parsed from agent-think COMMAND PLAN.
 *
 * @remarks
 * Used for run_command classification. Contains lists of setup commands,
 * verify commands, and run-project commands (indefinite processes like dev servers).
 */
export interface CommandPlan {
  /** Commands for one-time environment setup */
  setupCommands: string[];
  /** Commands for test/validation that exit pass/fail */
  verifyCommands: string[];
  /** Commands that run indefinitely (must use background: true) */
  runProjectCommands: string[];
}

/**
 * Returns an empty command plan with no commands.
 *
 * @remarks
 * Used as a default value when no command plan is available.
 *
 * @returns Empty command plan
 */
export const emptyCommandPlan = (): CommandPlan => ({
  setupCommands: [],
  verifyCommands: [],
  runProjectCommands: [],
});

/**
 * Full decomposition of a user task into ordered DAG nodes for execution.
 *
 * @remarks
 * Produced by Agent.plan after JSON parse and validation. Used by
 * AgentOrchestrator to drive waves of Subagent.run calls. Contains subtasks,
 * risks, command plan, execution mode, and agent count.
 */
export interface SubagentPlan {
  /** Ordered list of planned subtasks (order is not execution order; dependsOn is) */
  subtasks: PlannedSubtask[];

  /** Risks parsed from agent-think VERIFY section (may be empty) */
  risks: string[];

  /** Commands for setup / verify / run-project classification (from agent-think) */
  commandPlan: CommandPlan;

  /** How subtasks run relative to each other */
  execution: "parallel" | "sequential" | "mixed";

  /** Unique agent group count in this plan */
  agentCount: number;
}

/**
 * User choice after viewing the plan panel (not subagent execution turns).
 *
 * @remarks
 * Determines whether to implement the plan as-is, skip it entirely,
 * or edit the steps before implementation.
 */
export type PlanDecision = "implement" | "skip" | "edit";

/**
 * Client answer for confirm-plan.
 *
 * @remarks
 * Contains the user's decision and, for an "edit" decision, the user's
 * free-text feedback about the plan (not edited step text — the agent
 * re-plans using this feedback rather than having its plan rewritten by hand).
 */
export type PlanReviewResponse = {
  /** User's decision about the plan */
  decision: PlanDecision;
  /** Free-text feedback the user typed when decision is "edit" */
  feedback?: string;
};

/**
 * Structured result from an agent subtask finish tool call.
 *
 * @remarks
 * Used by Agent.combine to format prior work for the final answer, and by
 * IExperienceRecorder.finish for persistence. Contains summary, key findings,
 * files touched, and success status.
 */
export interface ToolResultSummary {
  /** One-sentence accomplishment summary */
  summary: string;

  /** Short bullets for dependent subtasks */
  keyFindings: string[];

  /** Paths written during this subtask (auto-tracked, not model-provided) */
  filesTouched: string[];

  /** False when the agent exhausted retries/escalations or never successfully finished */
  ok: boolean;
}

/**
 * One completed subtask result keyed by plan id for combine and recording.
 *
 * @remarks
 * Produced by AgentOrchestrator after each Agent.run wave completes.
 * Contains the subtask id and full subagent output text.
 */
export interface SubtaskResult {
  /** Matches PlannedSubtask.id */
  id: number;

  /** Full subagent output text (may include failure summary after max retries) */
  content: string;
}

/**
 * Serializable bundle passed to ExperienceRecorder.finish after one task run.
 *
 * @remarks
 * Produced by AgentOrchestrator.runTask on both success and failure paths.
 * Used by IExperienceRecorder.finish for audit trail and downstream pattern
 * mining. Contains the plan, results, and optional error message.
 */
export interface OrchestrationOutcome {
  /** True when the DAG completed without cycle deadlock and finish emitted */
  ok: boolean;

  /** Agent plan used for execution (may be partial if planning failed early) */
  plan: SubagentPlan;

  /** Subtask results in ascending id order when ok; otherwise best-effort partial */
  results: SubtaskResult[];

  /** Human-readable error when ok is false (cycle, abort, planning error propagated) */
  error?: string;
}
