/**
 * Type definitions for the agent tool registry.
 *
 * @remarks
 * Centralizes every type used across the `tools/` module — the tool schema
 * shape sent to Ollama, the execution context/result shapes every handler
 * shares, the `ToolHandler` contract itself, and small handler-local types —
 * so they have one discoverable home instead of being scattered across each
 * handler file.
 */

import type { Message } from "../types.js";
import type { CommandPlan } from "../types.js";
import type { TaskModelOverrides } from "../types.js";
import type { IExperienceRecorder } from "../interfaces.js";
import type { WorkspaceManager } from "../../workspace/manager/workspaceManager.js";
import type { TerminalExecutor } from "../../workspace/execution/terminalExecutor.js";

/**
 * JSON-schema shape sent to Ollama's native tools API to describe one callable tool.
 *
 * @remarks
 * Mirrors the OpenAI-style function-calling schema Ollama expects. In
 * text-based fallback mode (models without native tool support), the same
 * schema is rendered into a prompt block instead — see
 * {@link "./promptText.js".schemaToPromptLine | schemaToPromptLine}.
 */
export type ToolSchema = {
  type: "function";
  function: {
    /** Tool name the model must use verbatim in its tool call, e.g. `"read_file"`. */
    name: string;
    /** Human-readable description shown to the model to explain when/why to call this tool. */
    description: string;
    parameters: {
      type: "object";
      /** Per-argument JSON-schema property definitions (type + description). */
      properties: Record<string, unknown>;
      /** Names of arguments the model must always supply. */
      required: string[];
    };
  };
};

/**
 * Execution context passed to every tool handler's `execute` method.
 *
 * @remarks
 * Built once per subagent run (see `Subagent.run` in `../subagent/subagent.ts`)
 * and threaded through every tool call in that run. `messages` and `trackers`
 * are mutable references shared across the whole run — a handler that pushes
 * onto `messages` or updates `trackers` is visible to every later turn.
 */
export type ToolHandlerContext = {
  /** Identifier of the parent task this subtask belongs to (used for logging/recording). */
  taskId: string;
  /** The subtask description the agent is working on. */
  subtask: string;
  /** Identifies which agent instance is executing, for UI attribution. */
  agentSource: { agentId: number; agentLabel: string };
  /**
   * Emits a status update to the UI describing what the agent is doing right now
   * (e.g. "reading", "writing"). Handlers call this before/after slow operations
   * so the user sees live progress instead of a silent pause.
   */
  emitSubagentStatus: (
    stage:
      | "reading"
      | "writing"
      | "searching"
      | "running"
      | "escalating"
      | "thinking"
      | "done",
    icon: "◌" | "✓" | "⚠",
    message: string,
  ) => void;
  /** Conversation history for this subtask. Handlers rarely mutate this directly. */
  messages: Message[];
  /** Workspace manager for file reads/writes and MCP (TokenSave) tool calls. */
  workspace: WorkspaceManager;
  /** Terminal executor for running shell commands. */
  terminal: TerminalExecutor;
  /** Recorder for persisting experience data (escalations, file edits, commands run). */
  recorder: IExperienceRecorder;
  /** Escalations used so far this run. Compared against `maxEscalations` by the escalate tool. */
  escalationCount: number;
  /** Maximum escalations allowed before the task is reported as failed. */
  maxEscalations: number;
  /** Optional per-task model/temperature overrides, forwarded to escalation guidance calls. */
  modelOverrides?: TaskModelOverrides;
  /** Mutable bookkeeping for this task, used to enforce read-before-edit and verify-before-finish rules. */
  trackers: {
    /** Paths read via `read_file` this task (required before `edit_file` on the same path). */
    filesReadThisTask: Set<string>;
    /** Paths written via `write_file`/`edit_file` this task. */
    filesWrittenThisTask: Set<string>;
    /** Paths that were both written and subsequently read back (counts as verification). */
    filesVerifiedThisTask: Set<string>;
    /** True once a `purpose: "verify"` command has exited 0. */
    verifyCommandPassed: boolean;
    /** Normalized setup commands already run successfully (prevents re-running). */
    completedSetupCommands: Set<string>;
    /** Consecutive failure count per normalized command (triggers an escalation hint after repeated failures). */
    failedCommandAttempts: Map<string, number>;
  };
  /** The agent's current thinking-block text for this turn, if any. */
  thinkText: string | null;
  /** The parent task's setup/verify/off-limits command breakdown. */
  commandPlan: CommandPlan;
  /**
   * Present only in the top-level agent turn (never for a dispatched
   * subagent) — backs the `update_plan` and `run_steps_parallel` tools.
   * Absent from a subagent's context, since neither tool is offered there.
   */
  planTools?: {
    /**
     * Persists/emits the checklist and, in plan-review mode, blocks on user
     * approval. Returns the decision so `update_plan`'s handler can report
     * it back to the model (continue, stop, or revise with feedback).
     */
    updatePlan: (
      steps: PlanStepInput[],
      note?: string,
    ) => Promise<PlanToolDecision>;
    /**
     * Runs a batch of independent step ids through the hidden subagent pool
     * and marks them done/failed on the live checklist.
     */
    runStepsParallel: (stepIds: number[]) => Promise<{
      ok: boolean;
      summary: string;
    }>;
  };
};

/** Input shape for one `update_plan` step, before status defaults are applied. */
export type PlanStepInput = {
  id: number;
  text: string;
  status?: "pending" | "in_progress" | "done" | "failed";
  dependsOn?: number[];
};

/** Outcome of an `update_plan` call once `planTools.updatePlan` resolves. */
export type PlanToolDecision =
  | { decision: "continue" }
  | { decision: "stop" }
  | { decision: "revise"; feedback: string };

/**
 * Outcome of one tool execution, fed back into the agent loop.
 */
export type ToolExecutionResult = {
  /** True when the subtask is finished (via `finish`) or execution can't continue (e.g. escalation budget exhausted). */
  done: boolean;
  /** Final summary of what was accomplished. Only meaningful when `done` is true. */
  summary: string;
  /** Short bullet points a dependent subtask needs to know. Only meaningful when `done` is true. */
  keyFindings?: string[];
  /** Text appended to conversation history so the model sees the result of its tool call. */
  feedback: string;
  /** Updated escalation count (unchanged unless this call was the escalate tool). */
  escalationCount: number;
  /** Set when done=true — whether the subtask actually succeeded. */
  ok?: boolean;
};

/**
 * One registered tool: the schema describing it to the model, plus the handler that executes it.
 *
 * @remarks
 * Implement this interface to add a new tool. Register the instance in
 * `../tools/registry.js` so it's included in the tool set built for every
 * subagent run.
 *
 * @example
 * ```ts
 * const myTool: ToolHandler = {
 *   schema: {
 *     type: "function",
 *     function: {
 *       name: "my_tool",
 *       description: "Does something useful.",
 *       parameters: { type: "object", properties: {}, required: [] },
 *     },
 *   },
 *   async execute(args, ctx) {
 *     return { done: false, summary: "", feedback: "ok", escalationCount: ctx.escalationCount };
 *   },
 * };
 * ```
 */
export interface ToolHandler {
  schema: ToolSchema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolHandlerContext,
  ): Promise<ToolExecutionResult>;
}

/**
 * Pure classification of a finished {@link CommandResult} for feedback formatting.
 *
 * @remarks
 * Used internally by `runCommandHandler.ts` to distinguish the mutually
 * exclusive outcomes its agent-facing feedback message needs to describe.
 */
export type CommandExecutionSummary = {
  /** User picked "Revise" instead of running the command. */
  wasRevised: boolean;
  /** User picked "Skip" instead of running the command. */
  wasSkipped: boolean;
  /** Either declined outcome above — the command never actually ran. */
  wasNotExecuted: boolean;
  /** Ran, but exited non-zero. */
  commandFailed: boolean;
  /** One-line status shown above the captured stdout/stderr. */
  statusMessage: string;
};
