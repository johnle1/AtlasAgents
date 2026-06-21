/**
 * <Summary>
 * What it does:
 *   Dependency injection container that creates and wires all server collaborators
 *   in the correct order, providing centralized configuration and lifecycle management.
 *
 * How it fits in the system:
 *   Serves as the composition root for the server application, instantiating all
 *   services (OLLAMA client, config manager, orchestrator, etc.) with proper
 *   dependencies and exposing them through a clean interface. Handles per-connection
 *   resource creation and router configuration for request handling.
 *
 * Dependencies:
 *   - All server modules (advisor, orchestrator, config, memory, routing, etc.).
 *
 * Dependants:
 *   - Server entry point — calls createContainer to bootstrap the application.
 * </Summary>
 */

// ===== ORCHESTRATION LAYER IMPORTS =====
import { Advisor } from "./orchestration/advisor/advisor.js";
import { AdvisorOrchestrator } from "./orchestration/orchestrator/orchestrator.js";
import type { PreferenceRule } from "./orchestration/interfaces.js";

// ===== CONFIGURATION IMPORTS =====
import { ConfigManager } from "./config/configManager.js";

// ===== MEMORY AND LEARNING IMPORTS =====
import { ContextBuilder } from "./memory/context/contextBuilder.js";
import { ExperienceRecorder } from "./memory/experience/experienceRecorder.js";
import { PatternExtractor } from "./memory/pattern/patternExtractor.js";
import { PreferenceStore } from "./memory/preference/preferenceStore.js";
import { SessionManager } from "./memory/session/sessionManager.js";

// ===== OLLAMA CLIENT IMPORTS =====
import { OllamaClient } from "./ollama/client.js";

// ===== ROUTING IMPORTS =====
import { Router } from "./routing/router.js";
import { buildRouter as buildRouterFromDeps } from "./routing/routerBuilder.js";

// ===== SKILLS MANAGEMENT IMPORTS =====
import { SkillManager } from "./skills/manager/skillManager.js";

// ===== TRANSPORT LAYER IMPORTS =====
import { type TaskFrame } from "./transport/frames.js";
import { ClientBridge } from "./transport/clientBridge.js";

// ===== MEMORY CONSOLIDATION IMPORTS =====
import { scheduleConsolidation as scheduleConsolidationFromDeps } from "./memory/consolidation/consolidationScheduler.js";

// ===== CONTAINER INTERNAL IMPORTS =====
import type { PerConnection } from "./container/types.js";
import { createServices } from "./container/serviceFactory.js";
import { createPerConnection as createPerConnectionFromDeps } from "./container/perConnectionFactory.js";

export type { PerConnection } from "./container/types.js";

/**
 * <Summary>
 * What it does:
 *   Configuration options for creating the application container.
 *
 * Used by:
 *   - createContainer — receives these options to customize container setup.
 *
 * Produced by:
 *   - Server entry point — provides configuration when bootstrapping the app.
 * </Summary>
 */
export type ContainerOptions = {
  /**
   * Root directory for data storage.
   * This directory stores user preferences, session data, and pattern information.
   * If not provided, the service factory will use a default location.
   */
  dataRoot?: string;

  /**
   * Root directory for workspace operations.
   * All file system operations and git commands will be executed within this directory.
   * Defaults to the current working directory if not specified.
   */
  workspaceRoot?: string;

  /**
   * Base URL for OLLAMA API endpoint.
   * Specifies where the OLLAMA LLM service can be accessed.
   * Required for model inference and generation tasks.
   */
  ollamaBaseUrl?: string;

  /**
   * Function to retrieve RSocket peer connection for a given requester ID.
   * This callback enables the container to establish communication channels with specific clients.
   * The requester ID uniquely identifies each client connection.
   *
   * @param requesterId - Unique identifier for the client requester
   * @returns RSocket connection if available, undefined otherwise
   */
  getClientPeer?: (
    requesterId: string,
  ) => import("@rsocket/core").RSocket | undefined;
};

/**
 * <Summary>
 * What it does:
 *   Defines the shape of the application container with all core services.
 *
 * Used by:
 *   - Server entry point — uses this type to access container services.
 *
 * Produced by:
 *   - createContainer — constructs and returns an AppContainer instance.
 * </Summary>
 */
export type AppContainer = {
  /**
   * OLLAMA client for model communication.
   * Provides methods for sending prompts to LLM models and receiving responses.
   * Handles all API interactions with the OLLAMA service.
   */
  ollama: OllamaClient;

  /**
   * Configuration manager for server settings.
   * Manages server-wide configuration including model settings, timeouts, and feature flags.
   * Provides methods for reading and updating configuration values.
   */
  config: ConfigManager;

  /**
   * Preference store for user preferences and memory.
   * Persists user-specific preferences, rules, and learned patterns.
   * Enables the system to adapt to individual user needs over time.
   */
  prefs: PreferenceStore;

  /**
   * Skill manager for loading and managing skills.
   * Handles discovery, loading, and execution of user-defined skills.
   * Skills extend the agent's capabilities with custom behaviors.
   */
  skills: SkillManager;

  /**
   * Session manager for conversation state.
   * Maintains conversation history and context across interactions.
   * Enables multi-turn conversations with proper context preservation.
   */
  session: SessionManager;

  /**
   * Pattern extractor for identifying code patterns.
   * Analyzes code to identify recurring patterns and idioms.
   * Helps the agent understand code structure and conventions.
   */
  patternExtractor: PatternExtractor;

  /**
   * Experience recorder for tracking agent learning.
   * Records successful patterns, solutions, and outcomes for future reference.
   * Enables the agent to learn from past interactions and improve over time.
   */
  experienceRecorder: ExperienceRecorder;

  /**
   * Context builder for preparing LLM context.
   * Constructs appropriate context windows for LLM prompts.
   * Manages token limits and context prioritization.
   */
  contextBuilder: ContextBuilder;

  /**
   * Advisor for planning and agent coordination.
   * Plans complex tasks and coordinates multiple agent instances.
   * Breaks down complex requests into manageable subtasks.
   */
  advisor: Advisor;

  /**
   * Orchestrator for managing agent execution.
   * Executes planned tasks and manages agent lifecycle.
   * Handles task delegation and result aggregation.
   */
  orchestrator: AdvisorOrchestrator;

  /**
   * Map of requester IDs to per-connection resources.
   * Maintains separate state and resources for each connected client.
   * Key is the requester ID, value is the PerConnection object.
   */
  brokerByRequester: Map<string, PerConnection>;

  /**
   * Factory function for creating per-connection resources.
   * Called when a new client connects to establish connection-specific state.
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
   * Creates a router with all command and stream handlers registered.
   * The router directs incoming requests to appropriate handlers.
   *
   * @returns Configured Router instance with all handlers
   */
  buildRouter: () => Router;

  /**
   * Schedules periodic memory consolidation tasks.
   * Sets up timers to run consolidation operations at regular intervals.
   * Consolidation optimizes memory storage and removes redundant data.
   * Called for side effects (timer setup), return value is not used.
   */
  scheduleConsolidation: () => void;
};

/**
 * <Summary>
 * What it does:
 *   Converts preference rules into memory entries grouped by topic.
 *
 * How it does it (step by step):
 *   1. Create a map to group rules by topic.
 *   2. Iterate through each preference rule.
 *   3. Use "general" as default topic if no topics specified.
 *   4. Add rule text to each associated topic in the map.
 *   5. Convert map entries to array of topic/rules objects.
 *
 * Parameters:
 *   @param {PreferenceRule[]} rules — Array of preference rules to convert.
 *
 * Returns:
 *   @returns {Array<{topic: string, rules: string[]}>} — Memory entries grouped by topic.
 *
 * Dependencies:
 *   - None (pure function).
 *
 * Dependants:
 *   - buildRouter — uses this to format memory entries for client responses.
 * </Summary>
 */
const preferenceRulesToMemoryEntries = (
  rules: PreferenceRule[],
): Array<{ topic: string; rules: string[] }> => {
  // Step 1: Create a map to organize rules by their topics
  // Using Map allows efficient lookups and avoids duplicate topic entries
  const rulesByTopic = new Map<string, string[]>();

  // Step 2: Iterate through each preference rule to categorize it
  for (const rule of rules) {
    // Step 3: Determine which topics this rule belongs to
    // If the rule has no topics specified, assign it to "general" by default
    // This ensures every rule has at least one topic classification
    const topics = rule.topics.length > 0 ? rule.topics : ["general"];

    // Step 4: Add the rule text to each associated topic in the map
    for (const topic of topics) {
      // Step 4a: Get existing rules for this topic, or initialize empty array if topic doesn't exist yet
      // The nullish coalescing operator (??) provides a default empty array
      const topicRules = rulesByTopic.get(topic) ?? [];

      // Step 4b: Add the current rule's text to the topic's rule list
      topicRules.push(rule.text);

      // Step 4c: Update the map with the modified rule list for this topic
      rulesByTopic.set(topic, topicRules);
    }
  }

  // Step 5: Convert the Map structure to an array of objects for easier consumption
  // Spread operator converts Map entries to array, then map transforms each entry
  // Result format: [{ topic: "general", rules: ["rule1", "rule2"] }, ...]
  return [...rulesByTopic.entries()].map(([topic, ruleTexts]) => ({
    topic,
    rules: ruleTexts,
  }));
};

/**
 * <Summary>
 * What it does:
 *   Creates and initializes the application container with all required services.
 *
 * How it does it (step by step):
 *   1. Extract configuration options with sensible defaults.
 *   2. Initialize core infrastructure services (OLLAMA, config, preferences).
 *   3. Initialize memory and learning services (skills, session, patterns).
 *   4. Initialize context building with cache invalidation on model changes.
 *   5. Initialize orchestration services (advisor, orchestrator).
 *   6. Set up connection management with client bridge and broker map.
 *   7. Create factory functions for per-connection resources and router.
 *   8. Set up periodic consolidation scheduling.
 *   9. Return container object with all services and factories.
 *
 * Parameters:
 *   @param {ContainerOptions} options — Configuration options for container setup.
 *
 * Returns:
 *   @returns {AppContainer} — Fully initialized container with all services.
 *
 * Dependencies:
 *   - All imported service classes.
 *   - ContainerOptions for configuration.
 *
 * Dependants:
 *   - Server entry point — calls this to bootstrap the application.
 * </Summary>
 */
export const createContainer = (
  options: ContainerOptions = {},
): AppContainer => {
  // Step 1: Create and initialize all core services using the service factory
  // The service factory handles dependency injection and proper initialization order
  // Destructuring extracts each service for direct access in the container
  const {
    ollama, // OLLAMA API client for LLM communication
    config, // Configuration manager for server settings
    prefs, // Preference store for user preferences and memory
    skills, // Skill manager for loading and managing skills
    session, // Session manager for conversation state tracking
    patternExtractor, // Pattern extractor for identifying code patterns
    experienceRecorder, // Experience recorder for tracking agent learning
    contextBuilder, // Context builder for preparing LLM context
    advisor, // Advisor for planning and agent coordination
    orchestrator, // Orchestrator for managing agent execution
  } = createServices({
    dataRoot: options.dataRoot, // Root directory for persistent data storage
    ollamaBaseUrl: options.ollamaBaseUrl, // Base URL for OLLAMA API endpoint
  });

  // ===== CONNECTION MANAGEMENT SECTION =====

  // Step 3: Create a map to track per-connection resources by requester ID
  // This map maintains state for each connected client/requester
  // Key: requesterId (string), Value: PerConnection object with connection-specific resources
  const brokerByRequester = new Map<string, PerConnection>();

  // Step 4: Create client bridge for communication between server and clients
  // The bridge provides a callback to retrieve RSocket peer connections
  // This enables bidirectional communication with connected clients
  const clientBridge = new ClientBridge((requesterId) =>
    options.getClientPeer?.(requesterId),
  );

  // Step 5: Create factory function for per-connection resource instantiation
  // This function is called when a new client connects, creating connection-specific resources
  // Parameters:
  //   - requesterId: Unique identifier for the connecting client
  //   - emit: Callback function to send frames back to the client
  // Returns: PerConnection object with connection-specific services and state
  const createPerConnection = (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ): PerConnection => {
    // Delegate to the per-connection factory with required dependencies
    // This isolates connection-specific logic and maintains clean separation
    return createPerConnectionFromDeps({ clientBridge }, requesterId, emit);
  };

  /**
   * <Summary>
   * What it does:
   *   Creates a Router with command and stream handlers for client requests.
   *
   * How it does it (step by step):
   *   1. Define command handlers for individual request/response operations.
   *   2. Define stream handlers for long-running operations with progress updates.
   *   3. Each handler accesses container services through closure.
   *   4. Return configured Router instance.
   *
   * Parameters:
   *   None — uses container services through closure.
   *
   * Returns:
   *   @returns {Router} — Configured router with all handlers registered.
   *
   * Dependencies:
   *   - Container services (ollama, config, prefs, skills, session, etc.).
   *   - brokerByRequester — for per-connection resource access.
   *   - Router — for request routing infrastructure.
   *
   * Dependants:
   *   - createContainer — calls this to create router for container.
   * </Summary>
   */
  const buildRouter = (): Router => {
    // Step 1: Build the router by injecting all required dependencies
    // The router builder function creates command and stream handlers
    // that need access to various container services
    return buildRouterFromDeps({
      // Core infrastructure services
      ollama, // For LLM API communication
      config, // For accessing configuration settings

      // Memory and preference services
      skills, // For skill management and invocation
      prefs, // For user preference storage and retrieval
      session, // For conversation session management

      // Orchestration services
      orchestrator, // For agent execution and coordination

      // Connection management
      brokerByRequester, // Map of active connections for resource access
      createPerConnection, // Factory for creating new connection resources

      // Utility functions
      preferenceRulesToMemoryEntries, // Helper for formatting preference rules
    });
  };

  /**
   * <Summary>
   * What it does:
   *   Schedules periodic memory consolidation to run weekly.
   *
   * How it does it (step by step):
   *   1. Passes config and prefs to scheduleConsolidation function.
   *   2. Returns void (called for side effects).
   *
   * Parameters:
   *   None — uses container services through closure.
   *
   * Returns:
   *   void — called for side effects (timer setup and consolidation scheduling).
   *
   * Dependencies:
   *   - config — stores last consolidation timestamp.
   *   - prefs — performs consolidation operation.
   *   - scheduleConsolidation — scheduler function from memory/consolidationScheduler.ts.
   *
   * Dependants:
   *   - createContainer — calls this to set up periodic consolidation.
   * </Summary>
   */
  const scheduleConsolidation = (): void => {
    // Step 1: Schedule periodic memory consolidation task
    // This sets up a timer to run consolidation operations at regular intervals
    // The scheduler uses config to track last run time and prefs to perform consolidation
    return scheduleConsolidationFromDeps({
      config, // Configuration manager for storing consolidation timestamps
      prefs, // Preference store for performing the actual consolidation
    });
  };

  // ===== RETURN CONTAINER OBJECT =====

  // Step 6: Return the fully initialized application container
  // This object provides access to all services and factory functions
  // The container serves as the composition root for the entire application
  return {
    // Core infrastructure services
    ollama, // OLLAMA client for model communication
    config, // Configuration manager for server settings

    // Memory and learning services
    prefs, // Preference store for user preferences and memory
    skills, // Skill manager for loading and managing skills
    session, // Session manager for conversation state
    patternExtractor, // Pattern extractor for identifying code patterns
    experienceRecorder, // Experience recorder for tracking agent learning
    contextBuilder, // Context builder for preparing LLM context

    // Orchestration services
    advisor, // Advisor for planning and agent coordination
    orchestrator, // Orchestrator for managing agent execution

    // Connection management
    brokerByRequester, // Map of requester IDs to per-connection resources

    // Factory functions
    createPerConnection, // Factory for creating per-connection resources
    buildRouter, // Router factory for command and stream handlers
    scheduleConsolidation, // Schedules periodic memory consolidation tasks
  };
};
