/**
 * Type definitions for per-connection resource management.
 *
 * @remarks
 * This module defines types that represent connection-specific resources created
 * for each client connection. Each client gets isolated instances to prevent
 * cross-client interference and enable multiple simultaneous connections with
 * separate workspaces, terminals, and plan review sessions.
 *
 * The container maintains a map of requester IDs to PerConnection objects,
 * and these resources are created by {@link createPerConnection} in the
 * {@link PerConnectionFactory}.
 */

// ===== TRANSPORT TYPE IMPORTS =====
import type { TaskFrame } from "../transport/frames.js";

// ===== ORCHESTRATION TYPE IMPORTS =====
import type { PlanReviewResponse } from "../orchestration/types.js";
import type { Agent } from "../orchestration/agent/agent.js";
import type { AgentOrchestrator } from "../orchestration/orchestrator/orchestrator.js";

// ===== WORKSPACE TYPE IMPORTS =====
import type { ToolSchema } from "../orchestration/tools/types.js";
import type { PlanReviewBroker } from "../workspace/review/planReviewBroker.js";
import type { TerminalExecutor } from "../workspace/execution/terminalExecutor.js";
import type { WorkspaceManager } from "../workspace/manager/workspaceManager.js";

// ===== CONFIGURATION TYPE IMPORTS =====
import type { ConfigManager } from "../config/configManager.js";

// ===== MEMORY TYPE IMPORTS =====
import type { ContextBuilder } from "../memory/context/contextBuilder.js";
import type { ExperienceRecorder } from "../memory/experience/experienceRecorder.js";
import type { PatternExtractor } from "../memory/pattern/patternExtractor.js";
import type { PreferenceStore } from "../memory/preference/preferenceManager.js";
import type { SessionManager } from "../memory/session/sessionManager.js";

// ===== OLLAMA TYPE IMPORTS =====
import type { OllamaClient } from "../ollama/client.js";

// ===== PROVIDER REGISTRY TYPE IMPORTS =====
import type { ProviderRegistry } from "../providers/providerRegistry.js";

// ===== SKILLS TYPE IMPORTS =====
import type { SkillManager } from "../skills/skillManager.js";

// ===== TRANSPORT TYPE IMPORTS =====
import type { ClientBridge } from "../transport/clientBridge.js";

/**
 * Dependencies required to create per-connection resources.
 *
 * @remarks
 * The ClientBridge is shared infrastructure across all connections.
 * Each connection binds to a specific requester ID to achieve isolation,
 * so the bridge itself can remain stateless regarding per-connection concerns.
 *
 * @example
 * ```ts
 * const deps: PerConnectionFactoryDeps = { clientBridge };
 * const connection = createPerConnection(deps, "user_123", emitFrame);
 * ```
 */
export type PerConnectionFactoryDeps = {
  /**
   * Shared client bridge for sending and receiving commands.
   *
   * Provides communication methods that are used by each connection
   * after binding to its specific requester ID. The bridge ensures
   * commands are routed to the correct client.
   */
  clientBridge: ClientBridge;
};

/**
 * All per-connection resources and utilities for a specific client session.
 *
 * @remarks
 * Each client connection receives its own instance of PerConnection to ensure
 * isolation. The container stores these instances in a map keyed by requester ID,
 * allowing the router to access per-connection resources when handling requests.
 *
 * Instances are created by {@link createPerConnection} and provide:
 * - Plan review workflow management via {@link planBroker}
 * - File system and workspace operations via {@link workspace}
 * - Terminal command execution via {@link terminal}
 * - Stream emission utilities for client communication
 *
 * @example
 * ```ts
 * Created by the container for each new connection
 * const perConnection = createPerConnection(deps, "user_123", emitFrame);
 *
 * Resources are then used to handle client requests
 * perConnection.workspace.readFile("src/index.ts");
 * perConnection.terminal.runCommand("npm run build");
 * ```
 */
export type PerConnection = {
  /**
   * Broker for managing plan review workflows.
   *
   * Handles plan proposals, feedback collection, and approval decisions.
   * Used to coordinate plan discussions between the client and agent.
   */
  planBroker: PlanReviewBroker;

  /**
   * Resolves a pending plan review with a final response.
   *
   * Called when a plan review workflow completes to notify the client
   * of the outcome (approved, rejected, or revised).
   *
   * @param planId - Unique identifier for the plan being resolved.
   * @param response - The final plan review response to send to the client.
   */
  resolvePlan: (planId: string, response: PlanReviewResponse) => void;

  /**
   * Updates the stream emit function after client reconnection.
   *
   * When a client reconnects, this rebinds the emit function to the new
   * connection so subsequent frames are sent to the correct transport layer.
   * This allows reconnection without losing the session's state.
   *
   * @param emitFunction - The new emit function for sending TaskFrames to the client.
   */
  rebindStreamEmit: (emitFunction: (frame: TaskFrame) => void) => void;

  /**
   * Manager for workspace and file system operations.
   *
   * Handles file reading/writing, git operations, and workspace-specific
   * tasks for this client's session. Isolated per connection to prevent
   * cross-client file system interference.
   */
  workspace: WorkspaceManager;

  /**
   * Executor for shell commands and terminal sessions.
   *
   * Manages terminal lifecycle and command execution scoped to this client.
   * Each connection maintains its own terminal state and session history.
   */
  terminal: TerminalExecutor;

  /**
   * MCP TokenSave tools synchronized from the client for this session.
   *
   * Contains tool schemas that the client has made available via their
   * TokenSave MCP server. Populated during connection handshake if the
   * client supports TokenSave tools.
   */
  tokenSaveTools?: ToolSchema[];
};

/**
 * Configuration options for initializing application services.
 *
 * @remarks
 * All options are optional and have sensible defaults, allowing the factory
 * to work with minimal configuration. Override these only if you need
 * non-default behavior (e.g., custom data directory, custom Ollama endpoint).
 *
 * @example
 * ```ts
 * // Use defaults (cwd for data, default Ollama URL)
 * const services = createServices();
 *
 * // Override specific options
 * const services = createServices({
 *   dataRoot: "/var/lib/app",
 *   ollamaBaseUrl: "http://ollama.example.com:11434"
 * });
 * ```
 */
export type ServiceFactoryOptions = {
  /**
   * Root directory for persistent data storage.
   *
   * Used for user preferences, session history, and learned patterns.
   * @defaultValue Current working directory (`process.cwd()`)
   */
  dataRoot?: string;

  /**
   * Base URL for the Ollama API endpoint.
   *
   * Example: `"http://localhost:11434"` or `"http://ollama.example.com"`
   * @defaultValue Ollama client's default URL
   *
   * @see {@link OllamaClient} for default URL behavior
   */
  ollamaBaseUrl?: string;
};

/**
 * Complete set of initialized application services.
 *
 * @remarks
 * This type represents all core services needed for the application to function.
 * All services are fully instantiated and wired with their dependencies.
 * The service graph supports:
 * - **LLM Communication**: via {@link ollama}
 * - **Configuration**: via {@link config}
 * - **Memory & Preferences**: via {@link prefs}, {@link session}, {@link patternExtractor}
 * - **User Skills**: via {@link skills}
 * - **LLM Context Building**: via {@link contextBuilder} (with model-change cache invalidation)
 * - **Orchestration**: via {@link agent} and {@link orchestrator}
 *
 * Instances are created and returned by `createServices`.
 *
 * @example
 * ```ts
 * const services = createServices({ dataRoot: "/app/data" });
 *
 * // Use individual services
 * const models = await services.ollama.listModels();
 * const model = services.config.getModel("agent");
 * services.skills.loadSkillsFromDirectory("/app/skills");
 * ```
 */
export type InitializedServices = {
  /**
   * Client for communicating with the Ollama LLM service.
   *
   * Handles model inference, model listing, and lifecycle management.
   * Configured with the provided `ollamaBaseUrl` option.
   */
  ollama: OllamaClient;

  /**
   * Resolves each role (agent/subagent) to whichever provider it's currently
   * configured to use — native Ollama, or any OpenAI-compatible backend
   * (vLLM, Trainium, TPU) added via /providers.
   */
  providerRegistry: ProviderRegistry;

  /**
   * Manager for server-wide configuration and model selection.
   *
   * Stores and retrieves configuration like which model to use for
   * different roles (agent, executor). Also triggers cache invalidation
   * in the context builder when models change.
   */
  config: ConfigManager;

  /**
   * Persistent store for user preferences and learned memory.
   *
   * Persists user-specific preferences across sessions and stores
   * learned patterns and outcomes. Uses the provided `dataRoot` option.
   */
  prefs: PreferenceStore;

  /**
   * Manager for user-defined skills and plugins.
   *
   * Discovers, loads, and executes user-defined skills from the
   * filesystem. Scoped to the provided `dataRoot` option.
   */
  skills: SkillManager;

  /**
   * Manager for conversation history and session state.
   *
   * Maintains conversation history across interactions and manages
   * session-specific context. Persisted to the provided `dataRoot`.
   */
  session: SessionManager;

  /**
   * Analyzer for identifying recurring code patterns and idioms.
   *
   * Uses the LLM to identify patterns in code and learning outcomes,
   * feeding insights back into the experience recorder for future improvement.
   */
  patternExtractor: PatternExtractor;

  /**
   * Recorder for successful patterns and learning outcomes.
   *
   * Tracks agent successes, learned patterns, and solutions for reuse
   * in future tasks. Persisted to the provided `dataRoot`.
   */
  experienceRecorder: ExperienceRecorder;

  /**
   * Builder for preparing LLM context windows.
   *
   * Constructs appropriately-sized context for LLM prompts, with
   * intelligent caching that is invalidated whenever the model changes.
   * Depends on preferences, session history, and configuration.
   */
  contextBuilder: ContextBuilder;

  /**
   * Agent for planning complex tasks.
   *
   * Handles task planning, subagent coordination, and high-level
   * decision-making using the LLM. Configured with the selected model
   * for planning work.
   */
  agent: Agent;

  /**
   * Orchestrator for executing planned tasks and managing agent lifecycle.
   *
   * Coordinates subagent execution, manages skill invocation, tracks session
   * state, and records learning outcomes. This is the primary execution engine
   * for all subagent work.
   */
  orchestrator: AgentOrchestrator;
};
