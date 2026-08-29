/**
 * Provides escalation guidance and result synthesis using the agent model.
 *
 * @remarks
 * The Agent class is what remains of the lead-agent role now that planning
 * and execution are unified into one loop (see `agentTurn.ts`, which is the
 * default entry point for a task). Neither responsibility below is called
 * by that default pipeline — a `run_steps_parallel` step has no `escalate`
 * tool (it reports failure via `finish`'s `ok: false` instead — see
 * `finishHandler.ts`), and the top-level turn does its own synthesis
 * in-loop, since it's still there to read the results, unlike the old
 * planner. Both are kept as documented, tested extension points for a
 * caller that wants a distinct escalation target or an explicit synthesis
 * pass over a batch of results:
 * 1. **Escalation guidance** — `advise()` gives blocking advice to whatever
 *    caller wires up `escalateHandler.ts`'s `escalate` tool (e.g. the
 *    standalone `Subagent` class, itself not currently constructed by the
 *    default pipeline either).
 * 2. **Result synthesis** — `combine()` streams a final user-facing answer
 *    that merges multiple subtask results into one coherent reply.
 *
 * The agent uses the Ollama inference API and never manages RSocket or TCP
 * connections directly.
 *
 * @example
 * ```ts
 * const agent = new Agent({ ollama: client, config: configManager });
 * const guidance = await agent.advise(subtask, reason, history);
 * ```
 */

import type { IConfigManager, IOllamaClient } from "../interfaces.js";
import type { Message, SubtaskResult, TaskModelOverrides } from "../types.js";

/** Resolved model and temperature for one advise/combine call. */
type ModelAndTemperature = {
  /** Ollama model identifier to use. */
  agentModel: string;
  /** Sampling temperature to use. */
  agentTemperature: number;
};

/**
 * Resolves the effective model and temperature from config, preferring per-task overrides.
 *
 * @param config - Config manager providing default settings.
 * @param overrides - Optional per-task model/temperature overrides.
 * @returns Resolved model and temperature.
 */
const resolveModelAndTemperature = async (
  config: IConfigManager,
  overrides: TaskModelOverrides | undefined,
): Promise<ModelAndTemperature> => {
  const agentModel =
    overrides?.agentModel?.trim() || (await config.getAgentModel());
  const agentTemperature =
    overrides?.agentTemp ?? (await config.getAgentTemperature());
  return { agentModel, agentTemperature };
};

/**
 * Provides escalation guidance and result synthesis for the agent role.
 */
export class Agent {
  /**
   * Creates a new Agent instance with required dependencies.
   *
   * @param dependencies - Ollama client for inference and config manager for settings.
   */
  constructor(
    private readonly dependencies: {
      /** Ollama HTTP client for chat completions. */
      ollama: IOllamaClient;
      /** Config manager providing model names and temperatures. */
      config: IConfigManager;
      /**
       * Resolved Ollama runtime context window for this task's agent model
       * (see {@link ContextWindowResolver}). Omitted (or the role isn't on
       * the "ollama" provider) means don't send `num_ctx` at all — the
       * caller (`orchestratorPipeline.ts`) resolves this once per task, not
       * per call, since the model tag is fixed for this instance's lifetime.
       */
      numCtx?: number;
      /** Ollama `keep_alive` duration for this role (see {@link ChatOptions.keepAlive}). */
      keepAlive?: string | number;
    },
  ) {}

  /**
   * Runtime-tuning fields (`num_ctx`, `keep_alive`) shared by every model
   * call this instance makes.
   *
   * @remarks
   * Spread into each `ChatOptions` object alongside `temperature`. Both
   * fields are optional on `ChatOptions` and ignored by non-Ollama
   * providers, so this is safe to spread unconditionally even when unset.
   */
  private runtimeChatOptions = (): {
    numCtx?: number;
    keepAlive?: string | number;
  } => ({
    numCtx: this.dependencies.numCtx,
    keepAlive: this.dependencies.keepAlive,
  });

  /**
   * Provides blocking guidance to a worker subagent that has escalated.
   *
   * @remarks
   * Called when a worker subagent (dispatched by `run_steps_parallel`) hits
   * an issue it cannot resolve and calls ESCALATE. This method generates
   * targeted guidance from the lead agent by:
   * 1. Formatting the escalation reason and conversation history into a readable transcript.
   * 2. Calling the agent model with context about the stuck subtask and prior attempts.
   * 3. Returning concise, actionable guidance for the subagent to use.
   *
   * This is a blocking operation — the subagent waits for guidance before retrying.
   *
   * @param subtask - The text of the subtask the subagent was executing when it escalated.
   * @param reason - The escalation reason (text following the ESCALATE signal).
   * @param history - Message history showing the subagent's prior attempts.
   * @param overrides - Optional per-task model/temperature overrides.
   * @returns Concise guidance text for the subagent to incorporate and retry.
   *
   * @example
   * ```ts
   * const guidance = await agent.advise(
   *   "Write unit tests for the login module",
   *   "Test framework not installed; unclear which to use",
   *   conversationHistory
   * );
   * // Returns e.g.: "Install Jest: npm install --save-dev jest. See package.json for scripts."
   * ```
   */
  advise = async (
    subtask: string,
    reason: string,
    history: Message[],
    overrides?: TaskModelOverrides,
  ): Promise<string> => {
    const { agentModel, agentTemperature } =
      await resolveModelAndTemperature(this.dependencies.config, overrides);

    // Flatten the agent's message list so the agent sees the whole attempt in one user blob
    const conversationTranscript = history
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n");

    const userPromptContent = `The agent is stuck on this subtask:\n${subtask}\n\nReason for escalation:\n${reason}\n\nConversation so far:\n${conversationTranscript}\n\nReply with concise actionable guidance for the agent's next attempt. Do not repeat the ESCALATE protocol.`;

    const agentMessages: Message[] = [
      {
        role: "system",
        content:
          "You are a senior technical agent helping a coding agent unblock. Be direct and specific.",
      },
      { role: "user", content: userPromptContent },
    ];

    // Blocking: the agent waits on this before appending guidance and retrying chatStream
    return this.dependencies.ollama.chat(agentModel, agentMessages, {
      temperature: agentTemperature,
      ...this.runtimeChatOptions(),
    });
  };

  /**
   * Streams a final user-facing answer that integrates subtask results with the original task.
   *
   * @remarks
   * Used when a batch of subtask results needs to be synthesized into one
   * coherent answer. Streams tokens as they arrive, enabling real-time
   * output to the client.
   *
   * @param originalTask - The original user task description for context.
   * @param results - Array of completed subtask results in display order.
   * @param overrides - Optional per-task model/temperature overrides.
   * @returns Async generator yielding response tokens for streaming to the client.
   *
   * @example
   * ```ts
   * for await (const token of agent.combine(userTask, subtaskResults)) {
   *   process.stdout.write(token);
   * }
   * // Streams the integrated final answer
   * ```
   */
  async *combine(
    originalTask: string,
    results: SubtaskResult[],
    overrides?: TaskModelOverrides,
  ): AsyncGenerator<string> {
    // combine uses the same model as advise
    const { agentModel, agentTemperature } =
      await resolveModelAndTemperature(this.dependencies.config, overrides);

    // One section per completed subtask so the model can merge / dedupe / summarise
    const resultsBlock = results
      .map((result) => `### Subtask ${result.id}\n${result.content}`)
      .join("\n\n");

    const userPromptContent = `Original task:\n${originalTask}\n\nSubtask results:\n${resultsBlock}\n\nWrite one coherent final answer for the user that integrates the results. Do not mention internal subtask ids unless helpful.`;

    const agentMessages: Message[] = [
      {
        role: "system",
        content:
          "You are the lead assistant delivering the final response to the user based on prior sub-work.",
      },
      { role: "user", content: userPromptContent },
    ];
    for await (const token of this.dependencies.ollama.chatStream(
      agentModel,
      agentMessages,
      {
        temperature: agentTemperature,
        ...this.runtimeChatOptions(),
      },
    )) {
      yield token;
    }
  }
}
