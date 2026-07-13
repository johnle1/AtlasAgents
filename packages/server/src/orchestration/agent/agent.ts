/**
 * Executes subtasks via Ollama tool calls (native or legacy text protocol).
 */

import type { Advisor } from "../advisor/advisor.js";
import { hasCommandPlanSection } from "../commandClassifier.js";
import type {
  IConfigManager,
  IExperienceRecorder,
  IOllamaClient,
} from "../interfaces.js";
import type { CommandPlan, Message, TaskModelOverrides, ToolResultSummary } from "../types.js";
import { emptyCommandPlan } from "../types.js";
import {
  extractThinking,
  parseAllToolCalls,
  stripMarkdownFencesFromText,
  TOOL_END,
  TOOL_START,
  type ParsedToolCall,
} from "../toolProtocol.js";
import type { TaskFrame } from "../../transport/frames.js";
import type { TerminalExecutor } from "../../workspace/execution/terminalExecutor.js";
import type { WorkspaceManager } from "../../workspace/manager/workspaceManager.js";
import {
  createToolRegistry,
  getToolHandlerMap,
  getToolSchemas,
} from "../tools/registry.js";
import type { ToolHandler, ToolHandlerContext } from "../tools/toolHandler.js";
import type { ToolSchema } from "../tools/toolHandler.js";
import { buildAgentMessages } from "./agentMessageBuilder.js";
import { handleAgentRetry } from "./agentRetryHandler.js";
import { AbortError } from "../../errors/index.js";

const MAX_TOOL_ITERATIONS = 16;

export type AgentRunParams = {
  taskId: string;
  subtask: string;
  agentId: number;
  agentLabel: string;
  skillContent: string;
  sessionContext: string;
  workspace: WorkspaceManager;
  terminal: TerminalExecutor;
  recorder: IExperienceRecorder;
  emit: (frame: TaskFrame) => void;
  signal: AbortSignal;
  modelOverrides?: TaskModelOverrides;
  commandPlan?: CommandPlan;
  debug?: boolean;
};

type TaskTrackers = {
  filesWrittenThisTask: Set<string>;
  filesVerifiedThisTask: Set<string>;
  filesReadThisTask: Set<string>;
  verifyCommandPassed: boolean;
  completedSetupCommands: Set<string>;
  firstThinkSeen: boolean;
  commandPlanRetryUsed: boolean;
  lastThinkText: string | null;
};

type ChatResult = {
  content: string;
  toolCalls: ParsedToolCall[];
  hadMalformedToolBlock: boolean;
};

const agentDebugLog = (debug: boolean, label: string, data: unknown): void => {
  if (!debug) {
    return;
  }
  console.error(`[Agent] ${label}`, data);
};

const formatLegacyToolBlock = (call: ParsedToolCall): string =>
  `${TOOL_START}${JSON.stringify({ tool: call.name, ...call.args })}${TOOL_END}`;

export class Agent {
  private readonly toolRegistry: ToolHandler[];
  private readonly toolHandlers: Map<string, ToolHandler>;

  constructor(
    private readonly dependencies: {
      ollama: IOllamaClient;
      config: IConfigManager;
      advisor: Advisor;
      extraTools?: ToolSchema[];
    },
  ) {
    this.toolRegistry = createToolRegistry(
      dependencies.advisor,
      dependencies.extraTools ?? [],
    );
    this.toolHandlers = getToolHandlerMap(this.toolRegistry);
  }

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

    const emitAgentStatus = (
      stage:
        | "reading"
        | "writing"
        | "searching"
        | "running"
        | "escalating"
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

    const agentModel =
      modelOverrides?.agentModel?.trim() ||
      (await this.dependencies.config.getAgentModel());
    const agentTemperature =
      modelOverrides?.agentTemp ??
      (await this.dependencies.config.getAgentTemperature());
    const configuredSupportsTools =
      modelOverrides?.agentModelSupportsTools ??
      (await this.dependencies.config.getAgentModelSupportsTools());
    const configuredMaxRetries = await this.dependencies.config.getMaxRetries();
    const maxEscalations = Math.max(1, Math.floor(configuredMaxRetries));

    const messages = buildAgentMessages(
      subtask,
      skillContent,
      sessionContext,
      commandPlan,
      configuredSupportsTools,
      toolSchemas,
    );

    const trackers: TaskTrackers = {
      filesWrittenThisTask: new Set(),
      filesVerifiedThisTask: new Set(),
      filesReadThisTask: new Set(),
      verifyCommandPassed: false,
      completedSetupCommands: new Set(),
      firstThinkSeen: false,
      commandPlanRetryUsed: false,
      lastThinkText: null,
    };

    let escalationCount = 0;
    let thinkRetryCount = 0;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      if (signal.aborted) {
        throw new AbortError("Agent execution aborted");
      }

      const chatResult = await this.fetchModelTurn(
        agentModel,
        messages,
        toolSchemas,
        configuredSupportsTools,
        agentTemperature,
        signal,
      );

      const thinkText = extractThinking(chatResult.content);
      if (thinkText) {
        const displayThinkText = stripMarkdownFencesFromText(thinkText);
        emit({ kind: "think", text: displayThinkText, advisor: false });
        trackers.lastThinkText = thinkText;

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
            continue;
          }
        }
      }

      agentDebugLog(debug, "turn", {
        iteration,
        think: Boolean(thinkText),
        tools: chatResult.toolCalls.length,
        native: configuredSupportsTools,
      });

      const retryResult = handleAgentRetry(
        chatResult.content,
        thinkText,
        chatResult.toolCalls.length,
        chatResult.hadMalformedToolBlock,
        thinkRetryCount,
        maxEscalations,
      );

      if (retryResult.shouldRetry) {
        if (retryResult.shouldEscalate) {
          const escalationResult = await this.executeTool(
            { name: "escalate", args: { reason: retryResult.escalationReason ?? "Unknown reason" } },
            {
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
              supportsTools: configuredSupportsTools,
            },
          );
          escalationCount = escalationResult.escalationCount;
          if (escalationResult.done) {
            return {
              summary: escalationResult.summary,
              keyFindings: [],
              filesTouched: [...trackers.filesWrittenThisTask],
            };
          }
          messages.push({ role: "user", content: escalationResult.feedback });
          thinkRetryCount = 0;
          continue;
        }

        messages.push(...retryResult.updatedMessages);
        thinkRetryCount = retryResult.updatedThinkRetryCount;
        continue;
      }

      if (chatResult.toolCalls.length > 1) {
        messages.push({ role: "assistant", content: chatResult.content });
        messages.push({
          role: "user",
          content:
            "You called more than one tool. Call exactly one tool per turn.",
        });
        continue;
      }

      const toolCall = chatResult.toolCalls[0];
      if (!toolCall) {
        continue;
      }

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
        supportsTools: configuredSupportsTools,
      });
      escalationCount = toolResult.escalationCount;
      if (toolResult.done) {
        return {
          summary: toolResult.summary,
          keyFindings: toolResult.keyFindings ?? [],
          filesTouched: [...trackers.filesWrittenThisTask],
        };
      }

      this.appendToolTurnToHistory(
        messages,
        chatResult.content,
        toolCall,
        toolResult.feedback,
        configuredSupportsTools,
      );
      thinkRetryCount = 0;
    }

    return {
      summary: "[agent failed: exceeded maximum tool iterations]",
      keyFindings: [],
      filesTouched: [...trackers.filesWrittenThisTask],
    };
  };

  private fetchModelTurn = async (
    agentModel: string,
    messages: Message[],
    toolSchemas: ReturnType<typeof getToolSchemas>,
    supportsTools: boolean,
    temperature: number,
    signal: AbortSignal,
  ): Promise<ChatResult> => {
    if (supportsTools) {
      if (signal.aborted) {
        throw new AbortError("Agent stream aborted");
      }
      const result = await this.dependencies.ollama.chatWithTools(
        agentModel,
        messages,
        toolSchemas,
        { temperature, signal },
      );
      return {
        content: result.content,
        toolCalls: result.toolCalls.map((call) => ({
          name: call.name,
          args: call.args,
        })),
        hadMalformedToolBlock: false,
      };
    }

    let assistantResponseText = "";
    for await (const token of this.dependencies.ollama.chatStream(
      agentModel,
      messages,
      { temperature, signal },
    )) {
      if (signal.aborted) {
        throw new AbortError("Agent stream aborted");
      }
      assistantResponseText += token;
    }

    const { calls: toolCalls, hadMalformedBlock: hadMalformedToolBlock } =
      parseAllToolCalls(assistantResponseText, this.toolRegistry);
    return { content: assistantResponseText, toolCalls, hadMalformedToolBlock };
  };

  private appendToolTurnToHistory = (
    messages: Message[],
    content: string,
    call: ParsedToolCall,
    feedback: string,
    supportsTools: boolean,
  ): void => {
    if (supportsTools) {
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
      messages.push({
        role: "tool",
        tool_name: call.name,
        content: feedback,
      });
      return;
    }

    messages.push({
      role: "assistant",
      content: `${content}\n${formatLegacyToolBlock(call)}`,
    });
    messages.push({ role: "user", content: feedback });
  };

  private executeTool = async (
    call: ParsedToolCall,
    context: ToolHandlerContext & { supportsTools: boolean },
  ): Promise<{
    done: boolean;
    summary: string;
    keyFindings?: string[];
    feedback: string;
    escalationCount: number;
  }> => {
    const toolHandler = this.toolHandlers.get(call.name);

    if (!toolHandler) {
      return {
        done: false,
        summary: "",
        feedback: `Unknown tool: ${call.name}`,
        escalationCount: context.escalationCount,
      };
    }

    const { supportsTools: _supportsTools, ...handlerContext } = context;
    const result = await toolHandler.execute(call.args, handlerContext);
    return result;
  };
}
