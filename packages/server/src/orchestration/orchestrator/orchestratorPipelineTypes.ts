/**
 * Type definitions for the orchestrator pipeline.
 *
 * @remarks
 * Provides type definitions for the orchestrator pipeline operations,
 * including dependency injection containers, runtime parameters, and
 * intermediate results used throughout pipeline phases.
 */

import type {
  IContextBuilder,
  IExperienceRecorder,
  IConfigManager,
  ISessionManager,
  ISkillManager,
} from "../interfaces.js";
import type { IProviderRegistry } from "../../providers/providerRegistry.js";
import type { PerConnection } from "../../container/types.js";
import type { MaxSubagentsParam } from "../maxSubagents.js";
import type { SessionInfo, TaskModelOverrides } from "../types.js";
import type { Agent } from "../agent/agent.js";
import type { TaskFrame } from "../../transport/frames.js";
import type { IModelPlacementReporter } from "../../ollama/modelPlacement.js";
import type { TaskApprovalMode, ClientEnvPayload } from "@atlasagents/shared";

/**
 * Dependency injection container for the orchestrator pipeline.
 *
 * @remarks
 * Collects all the services needed to run the orchestration pipeline.
 * These dependencies are provided by the application container and passed
 * to the orchestrator pipeline for task execution.
 */
export type OrchestratorPipelineDeps = {
  /** Builds context from memory and workspace state. */
  contextBuilder: IContextBuilder;

  /** Manages skill selection and retrieval. */
  skillManager: ISkillManager;

  /** Manages session state and history. */
  sessionManager: ISessionManager;

  /** Records task outcomes for learning. */
  experienceRecorder: IExperienceRecorder;

  /** Plans and combines agent results. */
  agent: Agent;

  /** Resolves each role (agent/subagent) to its currently configured provider's client. */
  providerRegistry: IProviderRegistry;

  /** Configuration manager for settings. */
  config: IConfigManager;

  /**
   * Reports when a loaded model has spilled off the GPU onto CPU, once per
   * client connection. Optional so callers that don't need placement
   * warnings (and existing test fakes) don't have to provide one — when
   * absent, the pipeline simply skips the check.
   */
  modelPlacementReporter?: IModelPlacementReporter;
};

/**
 * Parameters for a single orchestrator pipeline execution.
 *
 * @remarks
 * Contains all the runtime parameters needed to execute a single task
 * through the orchestrator pipeline, including session info, task text,
 * emission callback, cancellation signal, and optional overrides.
 */
export type OrchestratorPipelineParams = {
  /** Authenticated connection identity for auditing. */
  session: SessionInfo;

  /** User task description to execute. */
  taskText: string;

  /** Callback to emit task frames to the client. */
  emit: (frame: TaskFrame) => void;

  /** AbortSignal for cancellation support. */
  signal: AbortSignal;

  /** Optional per-connection resources. */
  perConn?: PerConnection;

  /** Optional model selection overrides. */
  modelOverrides?: TaskModelOverrides;

  /** Optional agent count constraint. */
  maxSubagents?: MaxSubagentsParam;

  /**
   * Session approval mode from the client. `"plan"` stops after confirm-plan
   * (no subagent pool). Other modes execute the pool; file/command policy
   * is enforced on the client.
   */
  approvalMode?: TaskApprovalMode;

  /**
   * Client platform info, so the agent's `run_command` guidance matches the
   * shell it actually executes on (the client, not the server).
   */
  clientEnv?: ClientEnvPayload;
};

/** Context header and skill body assembled ahead of the agent turn. */
export type PlanningContextResult = {
  contextHeader: string;
  skillBody: string;
};
