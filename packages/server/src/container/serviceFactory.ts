/**
 * <Summary>
 * What it does:
 *   Factory for creating and initializing all application services.
 *
 * How it does it (step by step):
 *   1. Extract configuration options with sensible defaults.
 *   2. Initialize core infrastructure services (OLLAMA, config, preferences).
 *   3. Initialize memory and learning services (skills, session, patterns).
 *   4. Initialize context building with cache invalidation on model changes.
 *   5. Initialize orchestration services (advisor, orchestrator).
 *   6. Return object with all initialized services.
 *
 * How it fits in the system:
 *   Serves as the central service composition point, ensuring proper
 *   dependency injection and initialization order. All services are
 *   created here with their required dependencies, making the container
 * setup clean and maintainable.
 *
 * Parameters:
 *   @param options - Configuration options for service setup.
 *
 * Returns:
 *   @returns All initialized application services.
 * </Summary>
 */

// ===== ORCHESTRATION LAYER IMPORTS =====
import { Advisor } from "../orchestration/advisor/advisor.js";
import { AdvisorOrchestrator } from "../orchestration/orchestrator/orchestrator.js";

// ===== CONFIGURATION IMPORTS =====
import { ConfigManager } from "../config/configManager.js";

// ===== MEMORY AND CONTEXT IMPORTS =====
import { ContextBuilder } from "../memory/context/contextBuilder.js";
import { ExperienceRecorder } from "../memory/experience/experienceRecorder.js";
import { PatternExtractor } from "../memory/pattern/patternExtractor.js";
import { PreferenceStore } from "../memory/preference/preferenceStore.js";
import { SessionManager } from "../memory/session/sessionManager.js";

// ===== OLLAMA CLIENT IMPORTS =====
import { OllamaClient } from "../ollama/client.js";

// ===== SKILLS MANAGEMENT IMPORTS =====
import { SkillManager } from "../skills/manager/skillManager.js";

/**
 * <Summary>
 * What it does:
 *   Configuration options for service factory initialization.
 *
 * How it fits in the system:
 *   Provides optional configuration overrides for service initialization.
 * All options have sensible defaults, allowing the factory to work
 * with minimal configuration.
 *
 * Used by:
 *   - createServices — receives these options during initialization.
 *
 * Produced by:
 *   - Container — provides options when calling createServices.
 * </Summary>
 */
export type ServiceFactoryOptions = {
  /**
   * Root directory for data storage (preferences, sessions, patterns).
   * Defaults to current working directory if not specified.
   * Used for persistent data storage and file system operations.
   */
  dataRoot?: string;

  /**
   * Base URL for OLLAMA API endpoint.
   * Defaults to OllamaClient's default URL if not specified.
   * Used for LLM communication and model management.
   */
  ollamaBaseUrl?: string;
};

/**
 * <Summary>
 * What it does:
 *   Defines the complete set of initialized application services.
 *
 * How it fits in the system:
 *   This type represents all core services needed for the application
 *   to function. Services are organized by layer (infrastructure, memory,
 *   orchestration) and are fully initialized with their dependencies.
 *
 * Used by:
 *   - createServices — returns objects of this type.
 *   - Container — receives and uses these services.
 *
 * Produced by:
 *   - createServices — constructs and returns this type.
 * </Summary>
 */
export type InitializedServices = {
  /**
   * OLLAMA client for model communication.
   * Handles all interactions with the Ollama LLM service.
   */
  ollama: OllamaClient;

  /**
   * Configuration manager for server settings.
   * Manages server-wide configuration and model settings.
   */
  config: ConfigManager;

  /**
   * Preference store for user preferences and memory.
   * Persists user-specific preferences and learned patterns.
   */
  prefs: PreferenceStore;

  /**
   * Skill manager for loading and managing skills.
   * Handles discovery, loading, and execution of user-defined skills.
   */
  skills: SkillManager;

  /**
   * Session manager for conversation state.
   * Maintains conversation history and context across interactions.
   */
  session: SessionManager;

  /**
   * Pattern extractor for identifying code patterns.
   * Analyzes code to identify recurring patterns and idioms.
   */
  patternExtractor: PatternExtractor;

  /**
   * Experience recorder for tracking agent learning.
   * Records successful patterns, solutions, and outcomes.
   */
  experienceRecorder: ExperienceRecorder;

  /**
   * Context builder for preparing LLM context.
   * Constructs appropriate context windows for LLM prompts.
   */
  contextBuilder: ContextBuilder;

  /**
   * Advisor for planning and agent coordination.
   * Plans complex tasks and coordinates multiple agent instances.
   */
  advisor: Advisor;

  /**
   * Orchestrator for managing agent execution.
   * Executes planned tasks and manages agent lifecycle.
   */
  orchestrator: AdvisorOrchestrator;
};

/**
 * <Summary>
 * What it does:
 *   Creates and initializes all application services with proper dependency injection.
 *
 * How it does it (step by step):
 *   1. Extract data root directory from options or use current working directory.
 *   2. Initialize OLLAMA client for LLM communication.
 *   3. Initialize configuration manager for server settings.
 *   4. Initialize preference store with OLLAMA and config dependencies.
 *   5. Initialize skill manager for user-defined skills.
 *   6. Initialize session manager for conversation state.
 *   7. Initialize pattern extractor with OLLAMA, config, and preferences.
 *   8. Initialize experience recorder with pattern extractor and session manager.
 *   9. Initialize context builder with all required dependencies.
 *   10. Register model change callback for cache invalidation.
 *   11. Initialize advisor for planning and coordination.
 *   12. Initialize orchestrator with all required dependencies.
 *   13. Return object containing all initialized services.
 *
 * Parameters:
 *   @param options - Configuration options for service setup.
 *
 * Returns:
 *   @returns All initialized application services.
 * </Summary>
 */
export const createServices = (
  options: ServiceFactoryOptions = {},
): InitializedServices => {
  // ===== STEP 1: EXTRACT DATA ROOT DIRECTORY =====
  // Use provided data root or default to current working directory
  // This directory is used for all persistent data storage
  const dataRootDirectory = options.dataRoot ?? process.cwd();

  // ===== STEP 2: INITIALIZE CORE INFRASTRUCTURE SERVICES =====
  // Step 2a: Initialize OLLAMA client for LLM communication
  // Handles all interactions with the Ollama LLM service
  const ollamaClient = new OllamaClient({ baseUrl: options.ollamaBaseUrl });

  // Step 2b: Initialize configuration manager for server settings
  // Manages server-wide configuration and model settings
  const configManager = new ConfigManager({ rootDir: dataRootDirectory });

  // ===== STEP 3: INITIALIZE MEMORY AND LEARNING SERVICES =====
  // Step 3a: Initialize preference store with OLLAMA and config dependencies
  // Persists user-specific preferences and learned patterns
  const preferenceStore = new PreferenceStore(dataRootDirectory, {
    ollama: ollamaClient,
    config: configManager,
  });

  // Step 3b: Initialize skill manager for user-defined skills
  // Handles discovery, loading, and execution of skills
  const skillManager = new SkillManager({ rootDir: dataRootDirectory });

  // Step 3c: Initialize session manager for conversation state
  // Maintains conversation history and context
  const sessionManager = new SessionManager({ rootDir: dataRootDirectory });

  // ===== STEP 4: INITIALIZE PATTERN EXTRACTION =====
  // Initialize pattern extractor with OLLAMA, config, and preferences
  // Analyzes code to identify recurring patterns and idioms
  const patternExtractor = new PatternExtractor({
    ollama: ollamaClient,
    config: configManager,
    prefs: preferenceStore,
  });

  // ===== STEP 5: INITIALIZE EXPERIENCE RECORDING =====
  // Initialize experience recorder with pattern extractor and session manager
  // Records successful patterns, solutions, and outcomes
  const experienceRecorder = new ExperienceRecorder({
    rootDir: dataRootDirectory,
    patternExtractor: patternExtractor,
    sessionManager: sessionManager,
  });

  // ===== STEP 6: INITIALIZE CONTEXT BUILDING =====
  // Initialize context builder with all required dependencies
  // Constructs appropriate context windows for LLM prompts
  const contextBuilder = new ContextBuilder({
    prefs: preferenceStore,
    ollama: ollamaClient,
    config: configManager,
    rootDir: dataRootDirectory,
    session: sessionManager,
  });

  // ===== STEP 7: REGISTER MODEL CHANGE CALLBACK =====
  // Register cache invalidation callback when advisor model changes
  // This ensures stale context windows are cleared when switching models
  configManager.setOnModelChanged((previousModelName, role) => {
    // Only clear cache if previous model was set (non-empty)
    // First-time setup with empty previous model should not clear cache
    if (previousModelName.length > 0) {
      contextBuilder.clearContextWindowCache(previousModelName);
    }
  });

  // ===== STEP 8: INITIALIZE ORCHESTRATION SERVICES =====
  // Step 8a: Initialize advisor for planning and coordination
  // Plans complex tasks and coordinates multiple agent instances
  const advisor = new Advisor({ ollama: ollamaClient, config: configManager });

  // Step 8b: Initialize orchestrator with all required dependencies
  // Executes planned tasks and manages agent lifecycle
  const orchestrator = new AdvisorOrchestrator({
    contextBuilder: contextBuilder,
    skillManager: skillManager,
    sessionManager: sessionManager,
    experienceRecorder: experienceRecorder,
    advisor: advisor,
    ollama: ollamaClient,
    config: configManager,
  });

  // ===== STEP 9: RETURN ALL INITIALIZED SERVICES =====
  // Return object containing all initialized services
  // This provides the complete service graph for the application
  return {
    ollama: ollamaClient,
    config: configManager,
    prefs: preferenceStore,
    skills: skillManager,
    session: sessionManager,
    patternExtractor: patternExtractor,
    experienceRecorder: experienceRecorder,
    contextBuilder: contextBuilder,
    advisor: advisor,
    orchestrator: orchestrator,
  };
};
