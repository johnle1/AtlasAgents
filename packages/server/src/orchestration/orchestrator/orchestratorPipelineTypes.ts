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
import type {
  SubagentPlan,
} from "../types.js";
import type { PerConnection } from "../../container/types.js";
import type { MaxSubagentsParam } from "../maxSubagents.js";
import type { SessionInfo, TaskModelOverrides } from "../types.js";
import type { Agent } from "../agent/agent.js";
import type { TaskFrame } from "../../transport/frames.js";

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
};

/** Context header and skill body assembled ahead of agent planning. */
export type PlanningContextResult = {
  contextHeader: string;
  skillBody: string;
};

/** Outcome of agent planning: a plan, or a user skip. */
export type PlanningResult =
  | { skipped: false; plan: SubagentPlan }
  | { skipped: true };
