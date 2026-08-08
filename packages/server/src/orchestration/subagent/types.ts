/**
 * Type definitions for subagent orchestration and execution.
 *
 * @remarks
 * Centralizes all types used across the subagent module for better organization,
 * discoverability, and to reduce circular imports between module files.
 */

import type { CommandPlan, Message, TaskModelOverrides } from "../types.js";

/**
 * Parameters for a single subagent task execution.
 *
 * @remarks
 * Contains everything the subagent needs: the subtask description, workspace
 * context, message callbacks for UI updates, cancellation signal, and optional
 * configuration overrides (model, temperature) for fine-grained control.
 */
export type AgentRunParams = {
  /** Unique identifier for this task (used in logging, tracking, and result reporting). */
  taskId: string;

  /** The specific action the agent should take (e.g., "Implement OAuth login flow"). */
  subtask: string;

  /** Numeric ID of this agent instance (used to distinguish concurrent agents). */
  agentId: number;

  /** Human-readable label for this agent (e.g., "CodeWorker", used in UI/logs). */
  agentLabel: string;

  /** Skill documentation or domain-specific guidance (API reference, patterns, etc.). */
  skillContent: string;

  /** Context from prior steps, test output, or previous results that inform this task. */
  sessionContext: string;

  /** Workspace manager for file operations, directory structure, etc. */
  workspace: any; // WorkspaceManager — imported at usage to avoid circular deps

  /** Terminal executor for running CLI commands. */
  terminal: any; // TerminalExecutor — imported at usage to avoid circular deps

  /** Recorder for storing experiment data and tracing. */
  recorder: any; // IExperienceRecorder — imported at usage to avoid circular deps

  /** Callback to emit UI/status frames (thinking, tool calls, completion). */
  emit: (frame: any) => void; // TaskFrame — imported at usage to avoid circular deps

  /** Cancellation signal from orchestrator (allows task abort on policy timeout). */
  signal: AbortSignal;

  /** Optional per-task model/temperature overrides (prefer over global config). */
  modelOverrides?: TaskModelOverrides;

  /** Optional breakdown and sequence of steps for this task. */
  commandPlan?: CommandPlan;

  /** Enable verbose debug logging for troubleshooting. */
  debug?: boolean;
};

/**
 * Tracks state mutations across a single task execution.
 *
 * @remarks
 * Survives across multiple retry/escalation iterations and is returned in the
 * final summary. Tracks files touched (for change reporting), setup command
 * completion (prevents duplicate setup), retry budgets, and planning progress.
 */
export type TaskTrackers = {
  /** Set of file paths written by tools during this task. */
  filesWrittenThisTask: Set<string>;

  /** Set of file paths verified (read and checked for correctness). */
  filesVerifiedThisTask: Set<string>;

  /** Set of file paths read (includes reads that didn't modify). */
  filesReadThisTask: Set<string>;

  /** True if a verify command (e.g., tests, lints) has passed. */
  verifyCommandPassed: boolean;

  /** Set of setup commands already executed (prevent re-running). */
  completedSetupCommands: Set<string>;

  /** Counts failed attempts per command (tracks retry patterns). */
  failedCommandAttempts: Map<string, number>;

  /** True after first think block seen (used to enforce command plan checking). */
  firstThinkSeen: boolean;

  /** True if command plan enforcement re-prompt has been used. */
  commandPlanRetryUsed: boolean;

  /** Latest thinking block text from the agent (for recovery/analysis). */
  lastThinkText: string | null;

  /**
   * Consecutive turns that ended without a real tool handler doing work.
   *
   * @remarks
   * Incremented once per loop pass in `Subagent.run`, reset only when a
   * genuine (non-control-flow) tool handler executes. Trips
   * `MAX_UNPRODUCTIVE_TURNS` — the stagnation breaker for a model that keeps
   * thinking without ever emitting a usable tool call.
   */
  unproductiveTurns: number;
};

/**
 * Result of fetching one model turn with thinking extraction and tool parsing.
 */
export type ChatResult = {
  /** Full text content from the model (includes thinking, narrative, tool calls). */
  content: string;

  /**
   * Reasoning from the model's native thinking channel (Ollama
   * `message.thinking`), separate from `content`. Empty for the text-mode
   * path, where thinking already arrives inline in `content` instead.
   *
   * @remarks
   * A model on the native tool-calling path can put its whole
   * `<redacted_thinking>` block here rather than in `content` — callers
   * that only extract thinking from `content` will find nothing even though
   * the model reasoned. `runIteration` falls back to this field for exactly
   * that case.
   */
  thinking: string;

  /** Extracted tool calls from the response (may be empty). */
  toolCalls: any[]; // ParsedToolCall[] — imported at usage to avoid circular deps

  /** True if tool block was present but malformed (invalid JSON, incomplete). */
  hadMalformedToolBlock: boolean;
};

/**
 * Resolved model, temperature, tool-support capability, and retry settings for one run.
 *
 * @remarks
 * Combines per-task overrides with global config defaults. Task-level settings
 * take precedence, allowing fine-grained control without modifying global settings.
 */
export type SubagentConfig = {
  /** Model name/ID passed to Ollama (e.g., "gemma3:27b", "llama3:70b"). */
  subagentModel: string;

  /** Temperature for sampling (0.0 = deterministic, 1.0+ = creative). */
  subagentTemperature: number;

  /** True if the model supports native tool calls; false for text-based fallback. */
  configuredSupportsTools: boolean;

  /** Maximum escalations before giving up (usually 1-3). */
  maxEscalations: number;
};

/**
 * Outcome of evaluating a single agent turn for retry/escalation eligibility.
 *
 * @remarks
 * - `shouldRetry`: true if the agent should try again (with or without escalation)
 * - `updatedMessages`: if retrying without escalation, these messages append to history
 * - `updatedThinkRetryCount`: incremented if thinking parse retries are exhausted
 * - `shouldEscalate`: true if retry budget is exhausted; triggers escalation to lead agent
 * - `escalationReason`: human-readable explanation of why escalation was needed
 */
export type RetryResult = {
  shouldRetry: boolean;
  updatedMessages: Message[];
  updatedThinkRetryCount: number;
  shouldEscalate?: boolean;
  escalationReason?: string;
};
