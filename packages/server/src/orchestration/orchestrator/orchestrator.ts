/**
 * Orchestrates end-user task execution through the agent-subagent pipeline.
 *
 * @remarks
 * This class conducts a complete task execution workflow including:
 * - Memory context building
 * - Skill selection
 * - Agent DAG planning
 * - Worker-pool subagent execution
 * - Optional result combination
 * - Experience recording
 *
 * Implements IOrchestrator and is transport-agnostic — wired into the
 * router via RouterBuilderDeps.orchestrator, not a per-route handler.
 * The actual pipeline logic is extracted to runOrchestratorPipeline for
 * better testability and separation of concerns.
 *
 * @example
 * ```ts
 * const orchestrator = new AgentOrchestrator({
 *   contextBuilder,
 *   skillManager,
 *   sessionManager,
 *   experienceRecorder,
 *   agent,
 *   ollama,
 *   config,
 * });
 *
 * await orchestrator.runTask(
 *   session,
 *   "Implement a REST API endpoint",
 *   emit,
 *   signal,
 *   perConn,
 *   modelOverrides,
 *   3 // maxSubagents
 * );
 * ```
 */

import type { PerConnection } from "../../container/types.js";
import type { TaskFrame } from "../../transport/frames.js";
import { Agent } from "../agent/agent.js";
import type {
  IContextBuilder,
  IExperienceRecorder,
  IConfigManager,
  ISessionManager,
  ISkillManager,
} from "../interfaces.js";
import type { IProviderRegistry } from "../../providers/providerRegistry.js";
import type { MaxSubagentsParam } from "../maxSubagents.js";
import type { SessionInfo, TaskModelOverrides } from "../types.js";
import { runOrchestratorPipeline } from "./orchestratorPipeline.js";
import type { IModelPlacementReporter } from "../../ollama/modelPlacement.js";

export class AgentOrchestrator {
  /**
   * Creates a new AgentOrchestrator with the required dependencies.
   *
   * @param deps - Orchestrator dependencies including context builder,
   *   skill manager, session manager, experience recorder, agent,
   *   Ollama client, and configuration manager
   */
  constructor(
    private readonly deps: {
      contextBuilder: IContextBuilder;
      skillManager: ISkillManager;
      sessionManager: ISessionManager;
      experienceRecorder: IExperienceRecorder;
      agent: Agent;
      providerRegistry: IProviderRegistry;
      config: IConfigManager;
      modelPlacementReporter?: IModelPlacementReporter;
    },
  ) {}

  /**
   * Runs the full agent-subagent pipeline for a natural-language task.
   *
   * @remarks
   * Delegates to runOrchestratorPipeline which handles all phases:
   * context building, skill selection, agent planning, subagent pool execution,
   * result combination, and experience recording. The pipeline supports
   * cancellation via the AbortSignal and emits progress updates to the client.
   *
   * @param session - Authenticated connection identity for auditing
   * @param taskText - User task description to execute
   * @param emit - Callback to emit task frames (tokens, status, errors) to the client
   * @param signal - AbortSignal for cancellation support between subtasks or inside streams
   * @param perConn - Optional per-connection resources (workspace, terminal, plan broker)
   * @param modelOverrides - Optional model selection overrides for agent and subagent
   * @param maxSubagents - Maximum number of concurrent subagent workers (default: 3)
   *
   @throws {@link AbortError} When the operation is cancelled via the AbortSignal
   * @throws {@link NotFoundError} When per-connection context is missing
   * @throws {@link OrchestrationError} When subtask execution fails or deadlock occurs
   *
   * @returns Completes after task execution and optional result emission
   */
  runTask = async (
    session: SessionInfo,
    taskText: string,
    emit: (frame: TaskFrame) => void,
    signal: AbortSignal,
    perConn?: PerConnection,
    modelOverrides?: TaskModelOverrides,
    maxSubagents: MaxSubagentsParam = 3,
  ): Promise<void> => {
    await runOrchestratorPipeline(
      {
        contextBuilder: this.deps.contextBuilder,
        skillManager: this.deps.skillManager,
        sessionManager: this.deps.sessionManager,
        experienceRecorder: this.deps.experienceRecorder,
        agent: this.deps.agent,
        providerRegistry: this.deps.providerRegistry,
        config: this.deps.config,
        modelPlacementReporter: this.deps.modelPlacementReporter,
      },
      {
        session,
        taskText,
        emit,
        signal,
        perConn,
        modelOverrides,
        maxSubagents,
      },
    );
  };
}
