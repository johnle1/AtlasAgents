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

import { Advisor } from "./orchestration/advisor.js";
import { parseMaxAgentsPayload } from "./orchestration/maxAgents.js";
import { AdvisorOrchestrator } from "./orchestration/orchestrator.js";
import type { PreferenceRule } from "./orchestration/interfaces.js";
import { ConfigManager } from "./config/configManager.js";
import { ContextBuilder } from "./memory/contextBuilder.js";
import { ExperienceRecorder } from "./memory/experienceRecorder.js";
import { PatternExtractor } from "./memory/patternExtractor.js";
import { PreferenceStore } from "./memory/preferenceStore.js";
import { SessionManager } from "./memory/sessionManager.js";
import { OllamaClient } from "./ollama/client.js";
import {
  Router,
  type CommandHandler,
  type RouteId,
  type Session,
  type StreamHandler,
  type StreamKind,
} from "./routing/router.js";
import { SkillManager } from "./skills/skillManager.js";
import { encodeFrame, type TaskFrame } from "./transport/frames.js";
import { createStreamTransports } from "./transport/rsocketPlanReviewTransport.js";
import type { PerConnection } from "./container/types.js";
import { PlanReviewBroker } from "./workspace/planReviewBroker.js";
import type { PlanDecision } from "./orchestration/types.js";
import { TerminalExecutor } from "./workspace/terminalExecutor.js";
import { ClientBridge } from "./transport/clientBridge.js";
import { exploreCodebase } from "./orchestration/exploreCodebase.js";
import { WorkspaceManager } from "./workspace/workspaceManager.js";

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
  /** Root directory for data storage (preferences, sessions, patterns). */
  dataRoot?: string;

  /** Root directory for workspace operations (file access, git operations). */
  workspaceRoot?: string;

  /** Base URL for OLLAMA API endpoint. */
  ollamaBaseUrl?: string;

  /** Function to retrieve RSocket peer connection for a given requester ID. */
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
  /** OLLAMA client for model communication. */
  ollama: OllamaClient;

  /** Configuration manager for server settings. */
  config: ConfigManager;

  /** Preference store for user preferences and memory. */
  prefs: PreferenceStore;

  /** Skill manager for loading and managing skills. */
  skills: SkillManager;

  /** Session manager for conversation state. */
  session: SessionManager;

  /** Pattern extractor for identifying code patterns. */
  patternExtractor: PatternExtractor;

  /** Experience recorder for tracking agent learning. */
  experienceRecorder: ExperienceRecorder;

  /** Context builder for preparing LLM context. */
  contextBuilder: ContextBuilder;

  /** Advisor for planning and agent coordination. */
  advisor: Advisor;

  /** Orchestrator for managing agent execution. */
  orchestrator: AdvisorOrchestrator;

  /** Map of requester IDs to per-connection resources. */
  brokerByRequester: Map<string, PerConnection>;

  /** Factory function for creating per-connection resources. */
  createPerConnection: (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ) => PerConnection;

  /** Router factory for command and stream handlers. */
  buildRouter: () => Router;

  /** Schedules periodic memory consolidation tasks. */
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
  // Create map to group rules by topic
  const rulesByTopic = new Map<string, string[]>();

  // Group each rule under its associated topics
  for (const rule of rules) {
    // Use "general" as default topic if no topics specified
    const topics = rule.topics.length > 0 ? rule.topics : ["general"];

    // Add rule text to each associated topic
    for (const topic of topics) {
      const topicRules = rulesByTopic.get(topic) ?? [];
      topicRules.push(rule.text);
      rulesByTopic.set(topic, topicRules);
    }
  }

  // Convert map entries to array format
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
  // ===== DIRECTORY CONFIGURATION =====
  // Use provided data root or default to current working directory
  const dataRoot = options.dataRoot ?? process.cwd();
  const workspaceRoot = options.workspaceRoot ?? process.cwd();

  // ===== CORE INFRASTRUCTURE SERVICES =====
  // Initialize OLLAMA client for model communication
  const ollama = new OllamaClient({ baseUrl: options.ollamaBaseUrl });

  // Initialize configuration manager for server settings
  const config = new ConfigManager({ rootDir: dataRoot });

  // Initialize preference store with OLLAMA and config dependencies
  const prefs = new PreferenceStore(dataRoot, { ollama, config });

  // ===== MEMORY AND LEARNING SERVICES =====
  // Initialize skill manager for loading and managing skills
  const skills = new SkillManager({ rootDir: dataRoot });

  // Initialize session manager for conversation state
  const session = new SessionManager({ rootDir: dataRoot });

  // Initialize pattern extractor for identifying code patterns
  const patternExtractor = new PatternExtractor({
    ollama,
    config,
    prefs,
  });

  // Initialize experience recorder for tracking agent learning
  const experienceRecorder = new ExperienceRecorder({
    rootDir: dataRoot,
    patternExtractor,
    sessionManager: session,
  });

  // ===== CONTEXT BUILDING =====
  // Initialize context builder with all required dependencies
  const contextBuilder = new ContextBuilder({
    prefs,
    ollama,
    config,
    rootDir: dataRoot,
    session,
  });

  // Set up cache invalidation when model configuration changes
  config.setOnModelChanged((oldModel) => {
    contextBuilder.clearContextWindowCache(oldModel);
  });

  // ===== ORCHESTRATION SERVICES =====
  // Initialize advisor for planning and agent coordination
  const advisor = new Advisor({ ollama, config });

  // Initialize orchestrator for managing agent execution
  const orchestrator = new AdvisorOrchestrator({
    contextBuilder,
    skillManager: skills,
    sessionManager: session,
    experienceRecorder,
    advisor,
    ollama,
    config,
  });

  // ===== CONNECTION MANAGEMENT =====
  // Map to track per-connection resources by requester ID
  const brokerByRequester = new Map<string, PerConnection>();

  // Initialize client bridge for RSocket communication
  const clientBridge = new ClientBridge((requesterId) =>
    options.getClientPeer?.(requesterId),
  );

  /**
   * <Summary>
   * What it does:
   *   Factory function that creates per-connection resources for a specific client.
   *
   * How it does it (step by step):
   *   1. Create stream transports for plan review communication.
   *   2. Initialize plan review broker with plan transport.
   *   3. Initialize workspace manager and bind to requester ID.
   *   4. Initialize terminal executor and bind to requester ID.
   *   5. Return object with all per-connection resources and utilities.
   *
   * Parameters:
   *   @param {string} requesterId — Unique identifier for the requesting client.
   *   @param {function} emit — Function to emit task frames to the client.
   *
   * Returns:
   *   @returns {PerConnection} — Object containing connection-specific resources.
   *
   * Dependencies:
   *   - createStreamTransports — creates RSocket stream transports.
   *   - PlanReviewBroker — handles plan review workflow.
   *   - WorkspaceManager — manages workspace operations.
   *   - TerminalExecutor — executes terminal commands.
   *   - clientBridge — provides client communication.
   *
   * Dependants:
   *   - buildRouter — calls this to set up resources for new connections.
   *   - task stream handler — calls this when processing task requests.
   * </Summary>
   */
  const createPerConnection = (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ): PerConnection => {
    // Create stream transports for plan review and general communication
    const streamTransports = createStreamTransports(emit);

    // Initialize plan review broker with plan transport
    const planBroker = new PlanReviewBroker({
      transport: streamTransports.plan,
    });

    // Initialize workspace manager and bind to this specific requester
    const workspace = new WorkspaceManager(clientBridge);
    workspace.bindRequester(requesterId);

    // Initialize terminal executor and bind to this specific requester
    const terminal = new TerminalExecutor(clientBridge);
    terminal.bindRequester(requesterId);

    // Return per-connection resources with utility functions
    return {
      planBroker,
      workspace,
      terminal,
      resolvePlan: streamTransports.resolvePlan,
      rebindStreamEmit: streamTransports.rebindEmit,
    };
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
    // ===== COMMAND HANDLERS =====
    // Handlers for individual request/response operations
    const commands: Partial<Record<RouteId, CommandHandler>> = {
      // List available OLLAMA models
      "models.list": async () => {
        const models = await ollama.listModelsDetailed();
        return { models };
      },

      // Delete a specific OLLAMA model
      "models.delete": async (_session, payload) => {
        const body = payload as { name?: string };
        const modelName = String(body.name ?? "");
        await ollama.deleteModel(modelName);
        return { ok: true };
      },

      // Show detailed information about a specific model
      "models.show": async (_session, payload) => {
        const body = payload as { name?: string };
        return ollama.showModel(String(body.name ?? ""));
      },

      // List currently running OLLAMA models
      "models.running": async () => {
        const models = await ollama.listRunning();
        return { models };
      },

      // Get all configuration values
      "config.get": async () => config.getAll(),

      // Set a configuration value
      "config.set": async (_session, payload) => {
        const body = payload as { key?: string; value?: unknown };
        const configKey = String(body.key ?? "");
        const configValue = body.value;

        // Handle model configuration specially
        if (configKey === "advisorModel") {
          await config.setModel("advisor", String(configValue ?? ""));
        } else if (configKey === "agentModel") {
          await config.setModel("agent", String(configValue ?? ""));
        } else {
          // Handle general configuration
          await config.set(configKey, configValue);

          // Update OLLAMA timeout if timeout configuration changed
          if (configKey === "timeout" && typeof configValue === "number") {
            ollama.setTimeoutMs(configValue);
          }
        }
        return { ok: true };
      },

      // Sync skills from client to server
      "skills.sync": async (_session, payload) => {
        const body = payload as {
          skills?: Array<{ name: string; content: string }>;
        };
        const savedCount = await skills.saveAll(body.skills ?? []);
        return { saved: savedCount };
      },

      // Get all memory/preferences entries
      "memory.get": async () => {
        const rules = await prefs.getAll();
        return { entries: preferenceRulesToMemoryEntries(rules) };
      },

      // Forget (delete) memory entries for a specific topic
      "memory.forget": async (_session, payload) => {
        const body = payload as { topic?: string };
        const removedCount = await prefs.deleteByTopic(
          String(body.topic ?? ""),
        );
        return { removed: removedCount };
      },

      // Clear all memory/preferences
      "memory.clear": async () => {
        await prefs.clear();
        return { ok: true };
      },

      // Check if session exists
      "session.exists": async () => session.exists(),

      // Clear session state
      "session.clear": async () => {
        const message = await session.clear();
        return { message };
      },

      // Respond to plan review request
      "plan.respond": async (session, payload) => {
        const body = payload as {
          id?: string;
          decision?: string;
          steps?: string[];
        };

        // Get per-connection resources for this requester
        const perConnection = brokerByRequester.get(session.requesterId);
        if (!perConnection) {
          throw new Error("No active plan review broker for this connection");
        }

        // Validate plan decision
        const decision = body.decision as PlanDecision | undefined;
        if (
          decision !== "implement" &&
          decision !== "skip" &&
          decision !== "edit"
        ) {
          throw new Error("Invalid plan decision");
        }

        // Resolve plan with user decision and optional edited steps
        perConnection.resolvePlan(String(body.id ?? ""), {
          decision,
          steps: Array.isArray(body.steps)
            ? body.steps.map((step) => String(step))
            : undefined,
        });
        return { ok: true };
      },
    };

    // ===== STREAM HANDLERS =====
    // Handlers for long-running operations with progress updates
    const streams: Partial<Record<StreamKind, StreamHandler>> = {
      // Handle task execution stream with model overrides and multi-agent support
      task: async (session, payload, emit, signal) => {
        const body = payload as {
          text?: string;
          maxAgents?: unknown;
          advisorModel?: string;
          agentModel?: string;
          advisorTemp?: number;
          agentTemp?: number;
          debug?: boolean;
        };

        // Extract and validate task parameters
        const taskText = String(body.text ?? "");
        const maxAgents = parseMaxAgentsPayload(body.maxAgents);

        // Build model overrides object with validation
        const modelOverrides: {
          advisorModel?: string;
          agentModel?: string;
          advisorTemp?: number;
          agentTemp?: number;
          debug?: boolean;
        } = {};

        // Add advisor model override if provided
        if (
          typeof body.advisorModel === "string" &&
          body.advisorModel.length > 0
        ) {
          modelOverrides.advisorModel = body.advisorModel;
        }

        // Add agent model override if provided
        if (typeof body.agentModel === "string" && body.agentModel.length > 0) {
          modelOverrides.agentModel = body.agentModel;
        }

        // Add advisor temperature override if valid
        if (
          typeof body.advisorTemp === "number" &&
          Number.isFinite(body.advisorTemp)
        ) {
          modelOverrides.advisorTemp = body.advisorTemp;
        }

        // Add agent temperature override if valid
        if (
          typeof body.agentTemp === "number" &&
          Number.isFinite(body.agentTemp)
        ) {
          modelOverrides.agentTemp = body.agentTemp;
        }

        // Enable debug mode if requested
        if (body.debug === true) {
          modelOverrides.debug = true;
        }

        // Get or create per-connection resources for this requester
        let perConnection = brokerByRequester.get(session.requesterId);
        if (!perConnection) {
          perConnection = createPerConnection(session.requesterId, emit);
          brokerByRequester.set(session.requesterId, perConnection);
        } else {
          // Rebind emit function for existing connection
          perConnection.rebindStreamEmit(emit);
        }

        try {
          // Execute task through orchestrator with all parameters
          await orchestrator.runTask(
            session,
            taskText,
            emit,
            signal,
            perConnection,
            Object.keys(modelOverrides).length > 0 ? modelOverrides : undefined,
            maxAgents,
          );
          emit({ kind: "done" });
        } catch (error) {
          // Emit error message and re-throw for proper error handling
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          emit({ kind: "error", message: errorMessage });
          throw error;
        }
      },

      // Handle model pulling stream with progress updates
      "models.pull": async (_session, payload, emit, signal) => {
        const body = payload as { name?: string };
        const modelName = String(body.name ?? "");

        // Stream pull progress updates
        for await (const progress of ollama.pullModel(modelName)) {
          if (signal.aborted) {
            throw new Error("Aborted");
          }
          emit({ kind: "progress", data: progress });
        }
        emit({ kind: "done" });
      },

      // Handle codebase exploration stream
      explore: async (connection, _payload, emit, signal) => {
        // Get or create per-connection resources for this requester
        let perConnection = brokerByRequester.get(connection.requesterId);
        if (!perConnection) {
          perConnection = createPerConnection(connection.requesterId, emit);
          brokerByRequester.set(connection.requesterId, perConnection);
        }

        // Stream exploration progress
        emit({ kind: "token", text: "  Exploring codebase...\n" });

        // Perform codebase exploration
        const explored = await exploreCodebase(
          perConnection.workspace,
          emit,
          signal,
        );

        // Save exploration snapshot to session
        await session.saveSnapshot(explored.snapshot);

        emit({ kind: "token", text: "  ✓ Codebase snapshot updated.\n" });
        emit({ kind: "done" });
      },
    };

    // Create and return router with all handlers
    return new Router({ commands, streams });
  };

  /**
   * <Summary>
   * What it does:
   *   Schedules periodic memory consolidation to run weekly.
   *
   * How it does it (step by step):
   *   1. Define weekly interval in milliseconds.
   *   2. Create async function to check if consolidation is due.
   *   3. Check last consolidation timestamp from config.
   *   4. If overdue (more than a week) or never run, perform consolidation.
   *   5. Update last consolidation timestamp after successful run.
   *   6. Run immediately on startup, then set interval for weekly execution.
   *   7. Unref timer to allow process to exit if needed.
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
   *
   * Dependants:
   *   - createContainer — calls this to set up periodic consolidation.
   * </Summary>
   */
  const scheduleConsolidation = (): void => {
    const weekInMilliseconds = 7 * 24 * 60 * 60 * 1000;

    /**
     * <Summary>
     * What it does:
     *   Runs consolidation if it's been more than a week since last run.
     *
     * How it does it (step by step):
     *   1. Get current configuration to check last consolidation time.
     *   2. Parse last consolidation timestamp to milliseconds.
     *   3. Calculate if consolidation is due (more than a week ago or never run).
     *   4. If due, run consolidation and update timestamp.
     *   5. Log errors if consolidation fails.
     *
     * Parameters:
     *   None — uses config and prefs through closure.
     *
     * Returns:
     *   void — called for side effects (consolidation and timestamp update).
     *
     * Dependencies:
     *   - config — stores last consolidation timestamp.
     *   - prefs — performs consolidation operation.
     *
     * Dependants:
     *   - scheduleConsolidation — calls this periodically.
     * </Summary>
     */
    const runIfDue = async (): Promise<void> => {
      try {
        // Get current configuration
        const currentConfig = await config.getAll();

        // Extract last consolidation timestamp
        const lastConsolidatedAt = (currentConfig as Record<string, unknown>)
          .lastConsolidatedAt;

        // Parse timestamp to milliseconds (NaN if invalid)
        const lastConsolidatedMs =
          typeof lastConsolidatedAt === "string"
            ? Date.parse(lastConsolidatedAt)
            : Number.NaN;

        // Check if consolidation is due (never run or more than a week ago)
        const isDue =
          !Number.isFinite(lastConsolidatedMs) ||
          Date.now() - lastConsolidatedMs >= weekInMilliseconds;

        if (!isDue) {
          return;
        }

        // Perform consolidation
        await prefs.consolidate();

        // Update last consolidation timestamp
        await config.set("lastConsolidatedAt", new Date().toISOString());
      } catch (error) {
        console.error("[Consolidate]", error);
      }
    };

    // Run immediately on startup
    void runIfDue();

    // Set up weekly interval for consolidation
    const timer = setInterval(() => {
      void runIfDue();
    }, weekInMilliseconds);

    // Unref timer to allow process to exit naturally
    timer.unref();
  };

  // ===== RETURN CONTAINER OBJECT =====
  // Return fully initialized container with all services and factory functions
  return {
    ollama,
    config,
    prefs,
    skills,
    session,
    patternExtractor,
    experienceRecorder,
    contextBuilder,
    advisor,
    orchestrator,
    brokerByRequester,
    createPerConnection,
    buildRouter,
    scheduleConsolidation,
  };
};
