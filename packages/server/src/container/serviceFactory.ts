/**
 * Factory for creating and initializing all application services.
 *
 * @remarks
 * This module provides the central composition point for the entire application
 * service graph. It handles dependency injection and initialization order,
 * ensuring all services are properly configured and wired together.
 *
 * Services are organized by layer:
 * - **Infrastructure**: OLLAMA client, configuration, preferences
 * - **Memory & Learning**: Skills, sessions, patterns, experience
 * - **Context**: Context builder for LLM prompts with caching
 * - **Orchestration**: Agent planning and orchestrator execution
 *
 * See {@link InitializedServices} for the complete set of services returned.
 */

// ===== TYPE IMPORTS =====
import type { InitializedServices, ServiceFactoryOptions } from "./types.js";

// ===== ORCHESTRATION LAYER IMPORTS =====
import { Agent } from "../orchestration/agent/agent.js";
import { AgentOrchestrator } from "../orchestration/orchestrator/orchestrator.js";

// ===== CONFIGURATION IMPORTS =====
import { ConfigManager } from "../config/index.js";

// ===== MEMORY AND CONTEXT IMPORTS =====
import { ContextBuilder } from "../memory/context/contextBuilder.js";
import { ExperienceRecorder } from "../memory/experience/experienceRecorder.js";
import { PatternExtractor } from "../memory/pattern/patternExtractor.js";
import { PreferenceStore } from "../memory/preference/preferenceManager.js";
import { SessionManager } from "../memory/session/sessionManager.js";

// ===== OLLAMA CLIENT IMPORTS =====
import { OllamaClient } from "../ollama/client.js";

// ===== PROVIDER REGISTRY IMPORTS =====
import { ProviderRegistry } from "../providers/providerRegistry.js";

// ===== SKILLS MANAGEMENT IMPORTS =====
import { SkillManager } from "../skills/skillManager.js";

// ===== MODEL PLACEMENT IMPORTS =====
import { createModelPlacementReporter } from "../ollama/modelPlacement.js";
import { logger } from "../utils/logger.js";

/**
 * Creates and initializes all application services with proper dependency injection.
 *
 * @remarks
 * This factory sets up the complete service graph in the correct dependency order:
 *
 * 1. **Infrastructure**: OLLAMA client, configuration, preferences
 * 2. **Memory Services**: Skills, sessions, patterns
 * 3. **Experience**: Pattern extraction and experience recording
 * 4. **Context**: Context builder with cache invalidation hook
 * 5. **Orchestration**: Agent and orchestrator with all dependencies
 *
 * All services are fully initialized and ready to use. The factory registers
 * a callback with the config manager to invalidate context caches whenever
 * the selected model changes, ensuring stale context windows aren't reused
 * across model switches.
 *
 * @param options - Configuration options for service setup (all optional).
 * @returns All initialized application services, ready for use.
 *
 * @example
 * ```ts
 * Initialize with defaults
 * const services = createServices();
 *
 * Use services
 * const models = await services.ollama.listModels();
 * const currentModel = services.config.getModel("agent");
 * services.session.addMessage({
 *   role: "user",
 *   content: "Build a CLI tool"
 * });
 * ```
 *
 * @example <caption>Custom configuration</caption>
 * ```ts
 * const services = createServices({
 *   dataRoot: "/opt/app-data",
 *   ollamaBaseUrl: "http://ollama.prod:11434"
 * });
 *
 * All services now use the custom paths and endpoints
 * ```
 */
export const createServices = (
  options: ServiceFactoryOptions = {},
): InitializedServices => {
  // Resolve data root directory — defaults to cwd if not provided
  const dataRootDirectory = options.dataRoot ?? process.cwd();

  // Initialize OLLAMA client for LLM communication.
  // Configured with custom endpoint if provided, otherwise uses Ollama defaults.
  const ollamaClient = new OllamaClient({ baseUrl: options.ollamaBaseUrl });

  // Initialize configuration manager for server-wide settings and model selection.
  const configManager = new ConfigManager({ rootDir: dataRootDirectory });

  // Initialize provider registry: resolves each role (agent/subagent) to
  // whichever provider it's currently configured to use — native Ollama, or
  // any OpenAI-compatible backend added via /providers.
  const providerRegistry = new ProviderRegistry({
    config: configManager,
    ollamaClient,
  });

  // Initialize preference store with references to core services.
  // Enables cache invalidation on configuration changes.
  const preferenceStore = new PreferenceStore(dataRootDirectory, {
    ollama: ollamaClient,
    config: configManager,
  });

  // Initialize skill manager to discover and load user-defined skills.
  const skillManager = new SkillManager({ rootDir: dataRootDirectory });

  // Initialize session manager to track conversation history and context.
  const sessionManager = new SessionManager({ rootDir: dataRootDirectory });

  // Initialize pattern extractor to analyze code and identify recurring patterns.
  const patternExtractor = new PatternExtractor({
    ollama: ollamaClient,
    config: configManager,
    prefs: preferenceStore,
  });

  // Initialize experience recorder to persist successful patterns and solutions.
  // Used by orchestrator to improve decisions in future tasks.
  const experienceRecorder = new ExperienceRecorder({
    rootDir: dataRootDirectory,
    patternExtractor: patternExtractor,
    sessionManager: sessionManager,
  });

  // Initialize context builder with all dependencies for prompt construction.
  const contextBuilder = new ContextBuilder({
    prefs: preferenceStore,
    ollama: ollamaClient,
    config: configManager,
    rootDir: dataRootDirectory,
    session: sessionManager,
  });

  // Register cache invalidation hook on model changes.
  // Clears stale context windows when the selected model changes to prevent
  // reusing cached context with a different model. Skips on initial setup
  // (when previousModelName is empty).
  configManager.setOnModelChanged((previousModelName) => {
    if (previousModelName.length > 0) {
      contextBuilder.clearContextWindowCache(previousModelName);
    }
  });

  // Initialize agent for task planning and subagent coordination.
  const agent = new Agent({
    ollama: providerRegistry.getRoleClient("agent"),
    config: configManager,
  });

  // Detects when a loaded model has spilled off the GPU onto CPU (typically
  // 10-50x slower) and reports it once per client connection. Reads
  // Ollama's admin API directly — not hardware probing, so it's fine to run
  // during normal operation (unlike packages/server/src/hardware/, which is
  // CLI-only by design).
  const modelPlacementReporter = createModelPlacementReporter({
    admin: ollamaClient,
    log: logger,
  });

  // Initialize orchestrator — the primary engine for executing planned tasks.
  // Coordinates all services to run subagent work and manage task lifecycle.
  const orchestrator = new AgentOrchestrator({
    contextBuilder: contextBuilder,
    skillManager: skillManager,
    sessionManager: sessionManager,
    experienceRecorder: experienceRecorder,
    agent: agent,
    providerRegistry: providerRegistry,
    config: configManager,
    modelPlacementReporter: modelPlacementReporter,
  });

  // Return complete service graph with all initialized services.
  return {
    ollama: ollamaClient,
    providerRegistry: providerRegistry,
    config: configManager,
    prefs: preferenceStore,
    skills: skillManager,
    session: sessionManager,
    patternExtractor: patternExtractor,
    experienceRecorder: experienceRecorder,
    contextBuilder: contextBuilder,
    agent: agent,
    orchestrator: orchestrator,
    modelPlacementReporter: modelPlacementReporter,
  };
};
