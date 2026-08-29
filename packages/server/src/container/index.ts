/**
 * Dependency injection container that creates and wires all server collaborators.
 *
 * @remarks
 * Serves as the composition root for the server application, instantiating all
 * services (Ollama client, config manager, orchestrator, etc.) with proper
 * dependencies and exposing them through a clean interface. Handles per-connection
 * resource creation and router configuration for request handling.
 *
 * This is the central place where all application services are created and
 * their dependencies are resolved. Callers receive a fully configured container
 * and can access any service through its properties.
 *
 * @example
 * ```ts
 * const app = createContainer({
 *   dataRoot: "/path/to/data",
 *   workspaceRoot: "/path/to/workspace",
 *   ollamaBaseUrl: "http://localhost:11434",
 *   getClientPeer: (id) => clientPeers.get(id),
 * });
 *
 * Access services
 * const models = await app.ollama.listModels();
 * const subagentModel = await app.config.getSubagentModel();
 * ```
 */

// ===== ORCHESTRATION LAYER IMPORTS =====
import { Agent } from "../orchestration/agent/agent.js";
import { AgentOrchestrator } from "../orchestration/orchestrator/orchestrator.js";
import type { PreferenceRule } from "../orchestration/interfaces.js";

// ===== CONFIGURATION IMPORTS =====
import { ConfigManager } from "../config/index.js";

// ===== MEMORY AND LEARNING IMPORTS =====
import { ContextBuilder } from "../memory/context/contextBuilder.js";
import { ExperienceRecorder } from "../memory/experience/experienceRecorder.js";
import { PatternExtractor } from "../memory/pattern/patternExtractor.js";
import { PreferenceStore } from "../memory/preference/preferenceManager.js";
import { SessionManager } from "../memory/session/sessionManager.js";

// ===== OLLAMA CLIENT IMPORTS =====
import { OllamaClient } from "../ollama/client.js";
import type { IModelPlacementReporter } from "../ollama/modelPlacement.js";

// ===== PROVIDER REGISTRY IMPORTS =====
import type { ProviderRegistry } from "../providers/providerRegistry.js";

// ===== ROUTING IMPORTS =====
import { Router } from "../routing/router.js";
import { buildRouter as buildRouterFromDeps } from "../routing/routerBuilder.js";

// ===== SKILLS MANAGEMENT IMPORTS =====
import { SkillManager } from "../skills/skillManager.js";

// ===== TRANSPORT LAYER IMPORTS =====
import { type TaskFrame } from "../transport/frames.js";
import { ClientBridge } from "../transport/clientBridge.js";

// ===== MEMORY CONSOLIDATION IMPORTS =====
import { scheduleConsolidation as scheduleConsolidationFromDeps } from "../memory/consolidation/consolidationScheduler.js";

// ===== CONTAINER INTERNAL IMPORTS =====
import type { PerConnection } from "./types.js";
import { createServices } from "./serviceFactory.js";
import { createPerConnection as createPerConnectionFromDeps } from "./perConnectionFactory.js";

export type { PerConnection } from "./types.js";

/**
 * Configuration options for creating the application container.
 *
 * @remarks
 * All fields are optional. The container will use sensible defaults for
 * any omitted values. This design allows the server to start with minimal
 * configuration while supporting customization for different deployment scenarios.
 */
export type ContainerOptions = {
  /**
   * Root directory for data storage.
   *
   * @remarks
   * This directory stores user preferences, session data, and pattern information.
   * If not provided, the service factory will use a default location.
   */
  dataRoot?: string;

  /**
   * Root directory for workspace operations.
   *
   * @remarks
   * All file system operations and git commands will be executed within this directory.
   * Defaults to the current working directory if not specified.
   */
  workspaceRoot?: string;

  /**
   * Base URL for Ollama API endpoint.
   *
   * @remarks
   * Specifies where the Ollama LLM service can be accessed.
   * Required for model inference and generation tasks. Typically
   * "http://localhost:11434" for a local Ollama installation.
   */
  ollamaBaseUrl?: string;

  /**
   * Function to retrieve RSocket peer connection for a given requester ID.
   *
   * @remarks
   * This callback enables the container to establish communication channels with specific clients.
   * The requester ID uniquely identifies each client connection. The container uses this
   * to send streaming responses back to connected clients.
   *
   * @param requesterId - Unique identifier for the client requester
   * @returns RSocket connection if available, undefined otherwise
   */
  getClientPeer?: (
    requesterId: string,
  ) => import("@rsocket/core").RSocket | undefined;
};

/**
 * Fully initialized application container with all core services.
 *
 * @remarks
 * This type defines the public interface of the container. All services are
 * fully initialized and ready to use. The container also provides factory
 * functions for creating per-connection resources and the request router.
 *
 * Services are organized into categories: infrastructure (ollama, config),
 * memory and learning (prefs, skills, session, patterns, experience, context),
 * and orchestration (agent, orchestrator).
 */
export type AppContainer = {
  /**
   * Ollama client for model communication.
   *
   * @remarks
   * Provides methods for sending prompts to LLM models and receiving responses.
   * Handles all API interactions with the Ollama service including model listing,
   * chat requests, and streaming responses.
   */
  ollama: OllamaClient;

  /**
   * Resolves each role (agent/subagent) to whichever provider it's currently
   * configured to use — native Ollama, or any OpenAI-compatible backend
   * added via /providers.
   */
  providerRegistry: ProviderRegistry;

  /**
   * Configuration manager for server settings.
   *
   * @remarks
   * Manages server-wide configuration including model settings, timeouts, and feature flags.
   * Provides methods for reading and updating configuration values stored in the
   * user-data directory.
   */
  config: ConfigManager;

  /**
   * Preference store for user preferences and memory.
   *
   * @remarks
   * Persists user-specific preferences, rules, and learned patterns.
   * Enables the system to adapt to individual user needs over time by storing
   * and retrieving user-defined rules and preferences.
   */
  prefs: PreferenceStore;

  /**
   * Skill manager for loading and managing skills.
   *
   * @remarks
   * Handles discovery, loading, and execution of user-defined skills.
   * Skills extend the agent's capabilities with custom behaviors and can be
   * dynamically loaded from the file system.
   */
  skills: SkillManager;

  /**
   * Session manager for conversation state.
   *
   * @remarks
   * Maintains conversation history and context across interactions.
   * Enables multi-turn conversations with proper context preservation by
   * storing and retrieving session data.
   */
  session: SessionManager;

  /**
   * Pattern extractor for identifying code patterns.
   *
   * @remarks
   * Analyzes code to identify recurring patterns and idioms.
   * Helps the agent understand code structure and conventions by extracting
   * meaningful patterns from codebases.
   */
  patternExtractor: PatternExtractor;

  /**
   * Experience recorder for tracking agent learning.
   *
   * @remarks
   * Records successful patterns, solutions, and outcomes for future reference.
   * Enables the agent to learn from past interactions and improve over time
   * by storing experience data.
   */
  experienceRecorder: ExperienceRecorder;

  /**
   * Context builder for preparing LLM context.
   *
   * @remarks
   * Constructs appropriate context windows for LLM prompts.
   * Manages token limits and context prioritization to ensure the most relevant
   * information is included within the model's context window.
   */
  contextBuilder: ContextBuilder;

  /**
   * Agent for planning and subagent coordination.
   *
   * @remarks
   * Plans complex tasks and coordinates multiple subagent instances.
   * Breaks down complex requests into manageable subtasks and delegates
   * them to appropriate subagents.
   */
  agent: Agent;

  /**
   * Orchestrator for managing subagent execution.
   *
   * @remarks
   * Executes planned tasks and manages agent lifecycle.
   * Handles task delegation and result aggregation by coordinating
   * between different agent instances.
   */
  orchestrator: AgentOrchestrator;

  /**
   * Reports models that spilled out of GPU memory, deduped per connection.
   *
   * @remarks
   * Exposed on the container so connection teardown can call
   * {@link IModelPlacementReporter.forgetScope}. The reporter is a
   * process-lifetime singleton keyed by per-connection ids, so without that
   * call its dedup state grows for the life of the server.
   */
  modelPlacementReporter: IModelPlacementReporter;

  /**
   * Map of requester IDs to per-connection resources.
   *
   * @remarks
   * Maintains separate state and resources for each connected client.
   * This isolation ensures that concurrent client connections don't interfere
   * with each other's state.
   */
  brokerByRequester: Map<string, PerConnection>;

  /**
   * Factory function for creating per-connection resources.
   *
   * @remarks
   * Called when a new client connects to establish connection-specific state.
   * Each connection gets its own workspace manager, terminal executor, and
   * plan broker to ensure isolation between clients.
   *
   * @param requesterId - Unique identifier for the connecting client
   * @param emit - Callback function to send frames to the client
   * @returns PerConnection object with connection-specific services
   */
  createPerConnection: (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ) => PerConnection;

  /**
   * Router factory for command and stream handlers.
   *
   * @remarks
   * Creates a router with all command and stream handlers registered.
   * The router directs incoming requests to appropriate handlers based on
   * the request type and command name.
   *
   * @returns Configured Router instance with all handlers
   */
  buildRouter: () => Router;

  /**
   * Schedules periodic memory consolidation tasks.
   *
   * @remarks
   * Sets up timers to run consolidation operations at regular intervals.
   * Consolidation optimizes memory storage and removes redundant data.
   * Called for side effects (timer setup), return value is not used.
   */
  scheduleConsolidation: () => void;
};

/**
 * Converts preference rules into memory entries grouped by topic.
 *
 * @remarks
 * Preference rules can be associated with multiple topics. This function
 * groups rules by topic so they can be efficiently retrieved when building
 * context for specific topics. Rules without topics are assigned to "general"
 * to ensure they're always included.
 *
 * @param rules - Array of preference rules to convert
 * @returns Memory entries grouped by topic, each with a topic name and array of rule texts
 *
 * @example
 * ```ts
 * const rules: PreferenceRule[] = [
 *   { text: "Use TypeScript strict mode", topics: ["typescript"] },
 *   { text: "Write tests first", topics: [] }, // no topics = general
 * ];
 * const entries = preferenceRulesToMemoryEntries(rules);
 * Returns:
 *  [
 *   { topic: "typescript", rules: ["Use TypeScript strict mode"] },
 *   { topic: "general", rules: ["Write tests first"] }
 * ]
 * ```
 */
const preferenceRulesToMemoryEntries = (
  rules: PreferenceRule[],
): Array<{ topic: string; rules: string[] }> => {
  // Use Map for efficient topic lookups and to avoid duplicate topic entries
  const rulesByTopic = new Map<string, string[]>();

  for (const rule of rules) {
    // Assign rules without topics to "general" so they're always included in context
    const topics = rule.topics.length > 0 ? rule.topics : ["general"];

    for (const topic of topics) {
      const topicRules = rulesByTopic.get(topic) ?? [];
      topicRules.push(rule.text);
      rulesByTopic.set(topic, topicRules);
    }
  }

  // Convert Map to array for easier serialization and consumption
  return [...rulesByTopic.entries()].map(([topic, ruleTexts]) => ({
    topic,
    rules: ruleTexts,
  }));
};

/**
 * Creates and initializes the application container with all required services.
 *
 * @remarks
 * This is the composition root of the application. It creates all services
 * in the correct order, handling dependency injection automatically. The
 * service factory (`createServices`) handles the actual instantiation with
 * proper dependencies, while this function sets up connection management
 * and factory functions.
 *
 * The container is stateful and maintains a map of per-connection resources
 * to support multiple concurrent client connections with proper isolation.
 *
 * @param options - Configuration options for container setup. All fields are optional.
 * @returns Fully initialized container with all services and factory functions
 *
 * @example
 * ```ts
 * const app = createContainer({
 *   dataRoot: "/app/data",
 *   workspaceRoot: "/app/workspace",
 *   ollamaBaseUrl: "http://localhost:11434",
 * });
 *
 * Use the services
 * await app.ollama.chat("model", messages, opts);
 * const router = app.buildRouter();
 * ```
 */
export const createContainer = (
  options: ContainerOptions = {},
): AppContainer => {
  // Service factory handles dependency injection and proper initialization order
  const {
    ollama,
    providerRegistry,
    config,
    prefs,
    skills,
    session,
    patternExtractor,
    experienceRecorder,
    contextBuilder,
    agent,
    orchestrator,
    modelPlacementReporter,
  } = createServices({
    dataRoot: options.dataRoot,
    ollamaBaseUrl: options.ollamaBaseUrl,
  });

  // Track per-connection resources by requester ID for proper isolation
  const brokerByRequester = new Map<string, PerConnection>();

  // Client bridge enables bidirectional communication with connected clients
  const clientBridge = new ClientBridge((requesterId) =>
    options.getClientPeer?.(requesterId),
  );

  // Factory for creating per-connection resources when clients connect
  const createPerConnection = (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ): PerConnection => {
    // Delegate to keep connection-specific logic isolated
    return createPerConnectionFromDeps({ clientBridge }, requesterId, emit);
  };

  /**
   * Creates a Router with command and stream handlers for client requests.
   *
   * @remarks
   * The router builder injects container services into handlers via closure.
   * This allows handlers to access ollama, config, prefs, and other services
   * without passing them explicitly. The router is built lazily so it can
   * capture the current state of the container.
   *
   * @returns Configured router with all handlers registered
   */
  const buildRouter = (): Router => {
    return buildRouterFromDeps({
      // Core infrastructure
      ollama,
      providerRegistry,
      config,
      ollamaBaseUrl: options.ollamaBaseUrl,

      // Memory and preferences
      skills,
      prefs,
      session,

      // Orchestration
      orchestrator,

      // Connection management
      brokerByRequester,
      createPerConnection,

      // Utilities
      preferenceRulesToMemoryEntries,
    });
  };

  /**
   * Schedules periodic memory consolidation to run at regular intervals.
   *
   * @remarks
   * Consolidation optimizes memory storage by removing redundant data and
   * merging similar entries. The scheduler uses the config service to track
   * the last run time and the prefs service to perform the actual consolidation.
   * This function is called for its side effects (setting up the timer).
   */
  const scheduleConsolidation = (): void => {
    return scheduleConsolidationFromDeps({
      config,
      prefs,
    });
  };

  return {
    // Core infrastructure
    ollama,
    providerRegistry,
    config,

    // Memory and learning
    prefs,
    skills,
    session,
    patternExtractor,
    experienceRecorder,
    contextBuilder,

    // Orchestration
    agent,
    orchestrator,
    modelPlacementReporter,

    // Connection management
    brokerByRequester,

    // Factory functions
    createPerConnection,
    buildRouter,
    scheduleConsolidation,
  };
};
