/**
 * <Summary>
 * What it does:
 *   Interface for tool execution handlers in the strategy pattern.
 *
 * How it does it (step by step):
 *   1. Defines contract for tool execution.
 *   2. Each tool type implements this interface.
 *   3. Agent uses handler map instead of switch statement.
 *
 * Parameters:
 *   @param tool - Tool call to execute.
 *   @param ctx - Execution context with dependencies.
 *
 * Returns:
 *   @returns Result of tool execution.
 * </Summary>
 */

import type { AgentToolCall, CommandPurpose } from "../toolProtocol.js";
import type { Message } from "../types.js";
import type { CommandPlan } from "../types.js";
import type { TaskModelOverrides } from "../types.js";
import type { IExperienceRecorder } from "../interfaces.js";
import type { WorkspaceManager } from "../../workspace/manager/workspaceManager.js";
import type { TerminalExecutor } from "../../workspace/execution/terminalExecutor.js";

/**
 * <Summary>
 * What it does:
 *   Context passed to tool handlers during execution.
 *
 * How it fits in the system:
 *   Contains all the dependencies and state needed for tool execution,
 *   including workspace access, terminal executor, recorder, trackers,
 *   and emission callbacks for status updates.
 *
 * Fields:
 *   taskId — Unique identifier for the current task.
 *   subtask — Description of the current subtask.
 *   agentSource — Agent ID and label executing the tool.
 *   emitAgentStatus — Callback to emit status updates to client.
 *   messages — Message history for the current session.
 *   workspace — Workspace manager for file operations.
 *   terminal — Terminal executor for command operations.
 *   recorder — Experience recorder for logging.
 *   escalationCount — Current escalation count.
 *   maxEscalations — Maximum allowed escalations.
 *   modelOverrides — Optional model selection overrides.
 *   trackers — Trackers for files read, written, verified, and command verification.
 *   thinkText — Agent's thinking block text.
 *   commandPlan — Command plan from advisor.
 * </Summary>
 */
export type ToolHandlerContext = {
  /** Unique identifier for the current task. */
  taskId: string;

  /** Description of the current subtask. */
  subtask: string;

  /** Agent ID and label executing the tool. */
  agentSource: { agentId: number; agentLabel: string };

  /** Callback to emit status updates to client. */
  emitAgentStatus: (
    stage: "reading" | "writing" | "running" | "escalating" | "done",
    icon: "◌" | "✓" | "⚠",
    message: string,
  ) => void;

  /** Message history for the current session. */
  messages: Message[];

  /** Workspace manager for file operations. */
  workspace: WorkspaceManager;

  /** Terminal executor for command operations. */
  terminal: TerminalExecutor;

  /** Experience recorder for logging. */
  recorder: IExperienceRecorder;

  /** Current escalation count. */
  escalationCount: number;

  /** Maximum allowed escalations. */
  maxEscalations: number;

  /** Optional model selection overrides. */
  modelOverrides?: TaskModelOverrides;

  /** Trackers for files read, written, verified, and command verification. */
  trackers: {
    filesReadThisTask: Set<string>;
    filesWrittenThisTask: Set<string>;
    filesVerifiedThisTask: Set<string>;
    verifyCommandPassed: boolean;
  };

  /** Agent's thinking block text. */
  thinkText: string | null;

  /** Command plan from advisor. */
  commandPlan: CommandPlan;
};

/**
 * <Summary>
 * What it does:
 *   Result of tool execution.
 *
 * How it fits in the system:
 *   Returned by tool handlers to indicate execution outcome.
 *   The done field signals whether the task is complete (finish tool).
 *   Feedback contains the observation to send back to the agent.
 *
 * Fields:
 *   done — True if task is complete (finish tool), false otherwise.
 *   summary — Task summary (only used when done is true).
 *   feedback — Observation message to send back to the agent.
 *   escalationCount — Current escalation count.
 * </Summary>
 */
export type ToolExecutionResult = {
  /** True if task is complete (finish tool), false otherwise. */
  done: boolean;

  /** Task summary (only used when done is true). */
  summary: string;

  /** Observation message to send back to the agent. */
  feedback: string;

  /** Current escalation count. */
  escalationCount: number;
};

/**
 * <Summary>
 * What it does:
 *   Interface for tool execution handlers.
 *
 * How it fits in the system:
 *   Defines the contract that all tool handlers must implement.
 *   Each tool type (read_file, write_file, edit_file, run_command, finish)
 *   has its own handler class implementing this interface.
 *   The strategy pattern allows Agent.executeTool to dispatch
 *   to the appropriate handler without switch statements.
 * </Summary>
 */
export interface IToolHandler {
  /**
   * <Summary>
   * What it does:
   *   Executes a tool call and returns the result.
   *
   * How it does it (step by step):
   *   1. Validate tool type matches handler.
   *   2. Perform the tool operation (read, write, edit, run, finish).
   *   3. Track relevant state (files read/written/verified).
   *   4. Return execution result with observation.
   *
   * Parameters:
   *   @param tool - Tool call to execute.
   *   @param ctx - Execution context with dependencies.
   *
   * Returns:
   *   Result of tool execution.
   * </Summary>
   */
  execute(
    tool: AgentToolCall,
    ctx: ToolHandlerContext,
  ): Promise<ToolExecutionResult>;
}
