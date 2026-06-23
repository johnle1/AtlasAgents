/**
 * <Summary>
 * What it does:
 *   Executes subtasks via Ollama tool calls (read/write/edit/run/escalate/finish).
 *
 * How it fits in the system:
 *   The Agent is the worker that executes individual subtasks from the advisor's plan.
 *   It interacts with the Ollama model through streaming chat, parses tool calls from
 *   the response, executes them through specialized handlers, and tracks verification
 * requirements. It manages retry logic for common model mistakes and can escalate
 *   to the advisor when stuck. The agent enforces command classification rules
 *   (setup/verify/run-project) from the advisor's command plan.
 * </Summary>
 */

import type { Advisor } from "../advisor/advisor.js";
import { hasCommandPlanSection } from "../commandClassifier.js";
import type {
  IConfigManager,
  IExperienceRecorder,
  IOllamaClient,
} from "../interfaces.js";
import type { CommandPlan, Message, TaskModelOverrides } from "../types.js";
import { emptyCommandPlan } from "../types.js";
import {
  extractThinking,
  extractToolFromText,
  parseAllToolCalls,
  stripThinking,
  ToolStreamParser,
  type AgentToolCall,
} from "../toolProtocol.js";
import type { TaskFrame } from "../../transport/frames.js";
import type { TerminalExecutor } from "../../workspace/execution/terminalExecutor.js";
import type { WorkspaceManager } from "../../workspace/manager/workspaceManager.js";
import { ReadFileHandler } from "../tools/readFileHandler.js";
import { WriteFileHandler } from "../tools/writeFileHandler.js";
import { EditFileHandler } from "../tools/editFileHandler.js";
import { RunCommandHandler } from "../tools/runCommandHandler.js";
import { EscalateHandler } from "../tools/escalateHandler.js";
import { FinishHandler } from "../tools/finishHandler.js";
import type { IToolHandler } from "../tools/toolHandler.js";
import { buildAgentMessages } from "./agentMessageBuilder.js";
import { handleAgentRetry } from "./agentRetryHandler.js";
import { AbortError } from "../../errors/index.js";

/**
 * <Summary>
 * What it does:
 *   Maximum number of tool call iterations allowed per subtask.
 *
 * How it fits in the system:
 *   Prevents infinite loops when the agent gets stuck or makes repeated mistakes.
 *   After this many tool call attempts, the agent fails with a timeout error.
 * </Summary>
 */
const MAX_TOOL_ITERATIONS = 16;

/**
 * <Summary>
 * What it does:
 *   Parameters required to run an agent on a subtask.
 *
 * How it fits in the system:
 *   Contains all the context and dependencies needed for agent execution,
 * including the subtask description, workspace access, terminal executor,
 * model configuration, and command plan for shell command classification.
 *
 * Fields:
 *   taskId — Unique identifier for the task execution.
 *   subtask — The subtask description to execute.
 *   agentId — The agent group ID for tracking/display.
 *   agentLabel — Human-readable label for the agent group.
 *   skillContent — Selected skill documentation (may be empty).
 *   sessionContext — Session context header (may be empty).
 *   workspace — Workspace manager for file operations.
 *   terminal — Terminal executor for command execution.
 *   recorder — Experience recorder for logging.
 *   emit — Function to emit task frames to client.
 *   signal — AbortSignal for cancellation support.
 *   modelOverrides — Optional model/temperature overrides.
 *   commandPlan — Command plan for shell classification.
 *   debug — Whether to emit debug logs to stderr.
 * </Summary>
 */
export type AgentRunParams = {
  /** Unique identifier for the task execution. */
  taskId: string;

  /** The subtask description to execute. */
  subtask: string;

  /** The agent group ID for tracking/display. */
  agentId: number;

  /** Human-readable label for the agent group. */
  agentLabel: string;

  /** Selected skill documentation (may be empty). */
  skillContent: string;

  /** Session context header (may be empty). */
  sessionContext: string;

  /** Workspace manager for file operations. */
  workspace: WorkspaceManager;

  /** Terminal executor for command execution. */
  terminal: TerminalExecutor;

  /** Experience recorder for logging. */
  recorder: IExperienceRecorder;

  /** Function to emit task frames to client. */
  emit: (frame: TaskFrame) => void;

  /** AbortSignal for cancellation support. */
  signal: AbortSignal;

  /** Optional model/temperature overrides. */
  modelOverrides?: TaskModelOverrides;

  /** Command plan for shell classification. */
  commandPlan?: CommandPlan;

  /** Whether to emit debug logs to stderr. */
  debug?: boolean;
};

/**
 * <Summary>
 * What it does:
 *   Emits debug logs to stderr when debug mode is enabled.
 *
 * How it does it (step by step):
 *   1. Check if debug mode is enabled.
 *   2. If disabled, return immediately.
 *   3. If enabled, emit formatted debug message to stderr.
 *
 * Parameters:
 *   @param debug - Whether debug mode is enabled.
 *   @param label - Label for the debug message.
 *   @param data - Data to log.
 * </Summary>
 */
const agentDebugLog = (debug: boolean, label: string, data: unknown): void => {
  // Step 1: Check if debug mode is enabled
  if (!debug) {
    return;
  }

  // Step 2-3: If enabled, emit formatted debug message to stderr
  console.error(`[Agent] ${label}`, data);
};

/**
 * <Summary>
 * What it does:
 *   Formats a tool result as an observation message for the agent.
 *
 * How it does it (step by step):
 *   1. Build argument string based on tool type (path or command).
 *   2. Format observation header with tool name and arguments.
 *   3. Include the result text.
 *   4. Add prompt for next action.
 *
 * Parameters:
 *   @param tool - The tool call that produced the result.
 *   @param result - The result string from tool execution.
 *
 * Returns:
 *   {string} — Formatted observation message.
 * </Summary>
 */
const formatObservation = (tool: AgentToolCall, result: string): string => {
  // Step 1: Build argument string based on tool type
  const toolArguments =
    tool.tool === "read_file"
      ? `(${tool.path})`
      : tool.tool === "write_file" || tool.tool === "edit_file"
        ? `(${tool.path})`
        : tool.tool === "run_command"
          ? `(${tool.command})`
          : "";

  // Step 2-4: Format observation header with tool name, result, and next action prompt
  return `[Observation from ${tool.tool}${toolArguments}]:\n${result}\n\nThink about what this means and what to do next.`;
};

/**
 * <Summary>
 * What it does:
 *   Internal tracking state for a single agent subtask execution.
 *
 * How it fits in the system:
 *   Tracks files written, verified, and read during the task to enforce
 *   verification requirements. Also tracks whether the agent has included
 *   the required command plan section in its first think block.
 *
 * Fields:
 *   filesWrittenThisTask — Set of file paths written during this task.
 *   filesVerifiedThisTask — Set of file paths verified during this task.
 *   filesReadThisTask — Set of file paths read during this task.
 *   verifyCommandPassed — Whether a verify command passed with exit code 0.
 *   firstThinkSeen — Whether the first think block has been seen.
 *   commandPlanRetryUsed — Whether command plan retry has been used.
 *   lastThinkText — The most recent think block text.
 * </Summary>
 */
type TaskTrackers = {
  /** Set of file paths written during this task. */
  filesWrittenThisTask: Set<string>;

  /** Set of file paths verified during this task. */
  filesVerifiedThisTask: Set<string>;

  /** Set of file paths read during this task. */
  filesReadThisTask: Set<string>;

  /** Whether a verify command passed with exit code 0. */
  verifyCommandPassed: boolean;

  /** Whether the first think block has been seen. */
  firstThinkSeen: boolean;

  /** Whether command plan retry has been used. */
  commandPlanRetryUsed: boolean;

  /** The most recent think block text. */
  lastThinkText: string | null;
};

/**
 * <Summary>
 * What it does:
 *   Agent class that executes subtasks via Ollama tool calls.
 *
 * How it fits in the system:
 *   The Agent is the worker that executes individual subtasks from the advisor's plan.
 *   It streams responses from the model, parses tool calls, executes them through
 *   specialized handlers, manages retry logic for common mistakes, and tracks
 *   verification requirements. It can escalate to the advisor when stuck.
 * </Summary>
 */
export class Agent {
  /** Map of tool names to their handler instances. */
  private readonly toolHandlers: Map<string, IToolHandler>;

  /**
   * Constructor
   *
   * How it does it (step by step):
   *   1. Store dependencies (ollama, config, advisor) as private readonly field.
   *   2. Initialize tool handler map with all available tool handlers.
   *   3. Inject advisor dependency into escalate handler.
   *
   * @param dependencies - Dependencies for model IO and escalation.
   */
  constructor(
    private readonly dependencies: {
      ollama: IOllamaClient;
      config: IConfigManager;
      advisor: Advisor;
    },
  ) {
    // Step 2-3: Initialize tool handler map with all available tool handlers
    this.toolHandlers = new Map([
      ["read_file", new ReadFileHandler()],
      ["write_file", new WriteFileHandler()],
      ["edit_file", new EditFileHandler()],
      ["run_command", new RunCommandHandler()],
      ["escalate", new EscalateHandler(dependencies.advisor)],
      ["finish", new FinishHandler()],
    ]);
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Executes a subtask by streaming model responses, parsing tool calls,
   *   executing them, and tracking verification requirements.
   *
   * How it does it (step by step):
   *   1. Extract parameters from AgentRunParams with defaults.
   *   2. Read model configuration (model, temperature, max retries).
   *   3. Build initial messages with command plan and context.
   *   4. Initialize trackers for files, verification, and retry counts.
   *   5. Enter main execution loop (up to MAX_TOOL_ITERATIONS).
   *   6. For each iteration: stream response, parse tools, execute tools.
   *   7. Handle retry logic for common mistakes (markdown, no tools, no thinking).
   *   8. Handle escalation when agent is stuck.
   *   9. Return final result or failure message on timeout.
   *
   * Parameters:
   *   @param params - All parameters for agent execution.
   *
   * Returns:
   *   @returns Final result summary or failure message.
   *
   * Throws:
   *   @throws {AbortError} — When execution is aborted via signal.
   * </Summary>
   */
  run = async (params: AgentRunParams): Promise<string> => {
    // Step 1: Extract parameters from AgentRunParams with defaults
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

    // Helper function to emit agent status frames to client
    const emitAgentStatus = (
      stage: "reading" | "writing" | "running" | "escalating" | "done",
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

    // Step 2: Read model configuration (model, temperature, max retries)
    const agentModel =
      modelOverrides?.agentModel?.trim() ||
      (await this.dependencies.config.getAgentModel());
    const agentTemperature =
      modelOverrides?.agentTemp ??
      (await this.dependencies.config.getAgentTemperature());
    const configuredMaxRetries = await this.dependencies.config.getMaxRetries();
    const maxEscalations = Math.max(1, Math.floor(configuredMaxRetries));

    // Step 3: Build initial messages with command plan and context
    const messages = buildAgentMessages(
      subtask,
      skillContent,
      sessionContext,
      commandPlan,
    );

    // Step 4: Initialize trackers for files, verification, and retry counts
    const trackers: TaskTrackers = {
      filesWrittenThisTask: new Set(),
      filesVerifiedThisTask: new Set(),
      filesReadThisTask: new Set(),
      verifyCommandPassed: false,
      firstThinkSeen: false,
      commandPlanRetryUsed: false,
      lastThinkText: null,
    };

    let escalationCount = 0;
    let markdownRetryCount = 0;
    let thinkRetryCount = 0;

    // Step 5: Enter main execution loop (up to MAX_TOOL_ITERATIONS)
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      // Check for abort signal
      if (signal.aborted) {
        throw new AbortError("Agent execution aborted");
      }

      const streamParser = new ToolStreamParser();
      let assistantResponseText = "";

      // Step 6: Stream response from model and parse tool calls in real-time
      for await (const token of this.dependencies.ollama.chatStream(
        agentModel,
        messages,
        {
          temperature: agentTemperature,
        },
      )) {
        // Check for abort signal during streaming
        if (signal.aborted) {
          throw new AbortError("Agent stream aborted");
        }
        assistantResponseText += token;
        streamParser.feed(token, () => {});
      }

      // Extract think block from response
      const thinkText = extractThinking(assistantResponseText);
      if (thinkText) {
        emit({ kind: "think", text: thinkText, advisor: false });
        trackers.lastThinkText = thinkText;

        // Validate first think block includes command plan section
        if (!trackers.firstThinkSeen) {
          trackers.firstThinkSeen = true;
          if (
            !hasCommandPlanSection(thinkText) &&
            !trackers.commandPlanRetryUsed
          ) {
            trackers.commandPlanRetryUsed = true;
            messages.push({
              role: "assistant",
              content: assistantResponseText,
            });
            messages.push({
              role: "user",
              content:
                "Your first think block must include setup commands, verify commands, and off-limits (run-project) sections before any tool call.",
            });
            continue;
          }
        }
      }

      // Strip thinking blocks and parse tool calls
      const cleanResponse = stripThinking(assistantResponseText);
      let toolCalls = parseAllToolCalls(cleanResponse);
      if (toolCalls.length === 0) {
        // Try to recover tool call from text if parsing failed
        const recoveredTool = extractToolFromText(cleanResponse);
        if (recoveredTool) {
          toolCalls = [recoveredTool];
        }
      }

      // Log debug information if debug mode enabled
      agentDebugLog(debug, "turn", {
        iteration,
        think: Boolean(thinkText),
        tools: toolCalls.length,
      });

      // Step 7: Handle retry logic for common mistakes
      const retryResult = handleAgentRetry(
        assistantResponseText,
        thinkText,
        toolCalls.length,
        markdownRetryCount,
        thinkRetryCount,
        maxEscalations,
      );

      if (retryResult.shouldRetry) {
        if (retryResult.shouldEscalate) {
          // Step 8: Handle escalation when agent is stuck
          const escalationTool: AgentToolCall = {
            tool: "escalate",
            reason: retryResult.escalationReason ?? "Unknown reason",
          };
          const escalationResult = await this.executeTool(escalationTool, {
            taskId,
            subtask,
            agentSource,
            emitAgentStatus,
            messages,
            workspace,
            terminal,
            recorder,
            escalationCount,
            maxEscalations,
            modelOverrides,
            trackers,
            thinkText,
            commandPlan,
          });
          escalationCount = escalationResult.escalationCount;
          if (escalationResult.done) {
            return escalationResult.summary;
          }
          messages.push({ role: "user", content: escalationResult.feedback });
          thinkRetryCount = 0;
          continue;
        }

        // Apply retry messages and update counters
        messages.push(...retryResult.updatedMessages);
        markdownRetryCount = retryResult.updatedMarkdownRetryCount;
        thinkRetryCount = retryResult.updatedThinkRetryCount;
        continue;
      }

      // Execute the first tool call (agent should only call one at a time)
      const toolCall = toolCalls[0];
      if (!toolCall) {
        continue;
      }

      // Step 6: Execute tool and handle result
      const toolResult = await this.executeTool(toolCall, {
        taskId,
        subtask,
        agentSource,
        emitAgentStatus,
        messages,
        workspace,
        terminal,
        recorder,
        escalationCount,
        maxEscalations,
        modelOverrides,
        trackers,
        thinkText,
        commandPlan,
      });
      escalationCount = toolResult.escalationCount;
      if (toolResult.done) {
        return toolResult.summary;
      }
      messages.push({ role: "assistant", content: assistantResponseText });
      messages.push({ role: "user", content: toolResult.feedback });
      thinkRetryCount = 0;
    }

    // Step 9: Return failure message on timeout
    return "[agent failed: exceeded maximum tool iterations]";
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Executes a single tool call using the appropriate handler.
   *
   * How it does it (step by step):
   *   1. Get the handler for the tool type from the handlers map.
   *   2. If handler not found, return error observation.
   *   3. Delegate to handler's execute method with context.
   *   4. Return the handler's result.
   *
   * Parameters:
   *   @param tool - The tool call to execute.
   *   @param context - Execution context with all dependencies.
   *
   * Returns:
   *   @returns Execution result.
   * </Summary>
   */
  private executeTool = async (
    tool: AgentToolCall,
    context: {
      taskId: string;
      subtask: string;
      agentSource: { agentId: number; agentLabel: string };
      emitAgentStatus: (
        stage: "reading" | "writing" | "running" | "escalating" | "done",
        icon: "◌" | "✓" | "⚠",
        message: string,
      ) => void;
      messages: Message[];
      workspace: WorkspaceManager;
      terminal: TerminalExecutor;
      recorder: IExperienceRecorder;
      escalationCount: number;
      maxEscalations: number;
      modelOverrides?: TaskModelOverrides;
      trackers: TaskTrackers;
      thinkText: string | null;
      commandPlan: CommandPlan;
    },
  ): Promise<{
    done: boolean;
    summary: string;
    feedback: string;
    escalationCount: number;
  }> => {
    // Step 1: Get the handler for the tool type from the handlers map
    const toolHandler = this.toolHandlers.get(tool.tool);

    // Step 2: If handler not found, return error observation
    if (!toolHandler) {
      return {
        done: false,
        summary: "",
        feedback: formatObservation(tool, "Unknown tool"),
        escalationCount: context.escalationCount,
      };
    }

    // Step 3-4: Delegate to handler's execute method with context
    return toolHandler.execute(tool, context);
  };
}
