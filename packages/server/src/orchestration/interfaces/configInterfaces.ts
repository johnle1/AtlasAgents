/**
 * <Summary>
 * What it does:
 *   Interface for configuration management in the orchestration layer.
 *
 * How it fits in the system:
 *   Provides read-only and write access to persisted or session server configuration for models,
 *   temperatures, and agent retry limits. This abstraction allows the orchestration layer
 *   to operate without depending on concrete configuration implementations, enabling
 *   easier testing and configuration management.
 *
 * Dependencies:
 *   - None at interface level.
 *
 * Dependants:
 *   - Advisor — uses model and temperature settings for planning/advising.
 *   - Agent — uses model and temperature settings for execution.
 *   - Router command handlers — reads and updates configuration.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Read-only and write access to persisted or session server configuration for models,
 *   temperatures, and agent retry limits.
 *
 * How it fits in the system:
 *   Provides methods to retrieve and update various configuration values used by the orchestration
 *   layer. The configuration is managed by the ConfigManager implementation which handles
 *   persisting and loading values from config files or session overrides.
 *
 * Used by:
 *   - Advisor — model names and sampling settings per call site.
 *   - Agent — model names and sampling settings per call site.
 *
 * Produced by:
 *   - Future packages/server/src/config/configManager.ts implementation.
 * </Summary>
 */
export interface IConfigManager {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns the Ollama model name used for planning, advising, and combine.
   *
   * How it does it (step by step):
   *   1. Read configuration from config file or session overrides.
   *   2. Apply any session-level model override if present.
   *   3. Return the advisor model name string.
   *
   * Returns:
   *   @returns {Promise<string>} — Advisor model id string (e.g., "llama3.1").
   *
   * Dependencies:
   *   - ConfigManager implementation — reads from config storage.
   *
   * Dependants:
   *   - Advisor.plan — uses for planning model.
   *   - Advisor.advise — uses for escalation guidance model.
   *   - Advisor.combine — uses for result synthesis model.
   * </Summary>
   */
  getAdvisorModel(): Promise<string>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns the Ollama model name used for subtask execution.
   *
   * How it does it (step by step):
   *   1. Read configuration from config file or session overrides.
   *   2. Apply any session-level model override if present.
   *   3. Return the agent model name string.
   *
   * Returns:
   *   @returns {Promise<string>} — Agent model id string (e.g., "llama3.1").
   *
   * Dependencies:
   *   - ConfigManager implementation — reads from config storage.
   *
   * Dependants:
   *   - Agent.run — uses for execution model.
   * </Summary>
   */
  getAgentModel(): Promise<string>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns advisor sampling temperature (planning and advise use this).
   *
   * How it does it (step by step):
   *   1. Read configuration from config file or session overrides.
   *   2. Apply any session-level temperature override if present.
   *   3. Return the temperature value (typically low for consistency).
   *
   * Returns:
   *   @returns {Promise<number>} — Temperature, typically low (e.g., 0.1-0.3 for consistent planning).
   *
   * Dependencies:
   *   - ConfigManager implementation — reads from config storage.
   *
   * Dependants:
   *   - Advisor.plan — uses for planning temperature.
   *   - Advisor.advise — uses for escalation guidance temperature.
   * </Summary>
   */
  getAdvisorTemperature(): Promise<number>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns agent sampling temperature for subtask runs.
   *
   * How it does it (step by step):
   *   1. Read configuration from config file or session overrides.
   *   2. Apply any session-level temperature override if present.
   *   3. Return the temperature value for agent execution.
   *
   * Returns:
   *   @returns {Promise<number>} — Temperature for execution (typically 0.5-0.7 for creativity).
   *
   * Dependencies:
   *   - ConfigManager implementation — reads from config storage.
   *
   * Dependants:
   *   - Agent.run — uses for execution temperature.
   * </Summary>
   */
  getAgentTemperature(): Promise<number>;

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns maximum advisor-assisted retries after an ESCALATE response.
   *
   * How it does it (step by step):
   *   1. Read configuration from config file or session overrides.
   *   2. Apply any session-level retry override if present.
   *   3. Ensure minimum value of 1 (at least one retry allowed).
   *   4. Return the maximum retry count.
   *
   * Returns:
   *   @returns {Promise<number>} — Max retry attempts (>= 1).
   *
   * Dependencies:
   *   - ConfigManager implementation — reads from config storage.
   *
   * Dependants:
   *   - Agent.run — uses for escalation retry limit.
   * </Summary>
   */
  getMaxRetries(): Promise<number>;

  /**
   * <Summary>
   * What it does:
   *   Returns advisorTemp or agentTemp based on role.
   * </Summary>
   */
  getTemperature(role: "advisor" | "agent"): Promise<number>;

  /**
   * <Summary>
   * What it does:
   *   Returns configured retry count (alias for getMaxRetries).
   * </Summary>
   */
  getRetries(): Promise<number>;

  /**
   * <Summary>
   * What it does:
   *   Returns orchestration timeout in milliseconds.
   * </Summary>
   */
  getTimeout(): Promise<number>;

  /**
   * <Summary>
   * What it does:
   *   Returns fraction of model context reserved for memory header.
   * </Summary>
   */
  getMaxContextBudget(): Promise<number>;

  /**
   * <Summary>
   * What it does:
   *   Returns full merged config — used by Router config.get.
   * </Summary>
   */
  getAll(): Promise<Record<string, unknown>>;

  /**
   * <Summary>
   * What it does:
   *   Updates one config key and persists — used by Router config.set.
   * </Summary>
   */
  set(key: string, value: unknown): Promise<void>;

  /**
   * <Summary>
   * What it does:
   *   Updates advisor or agent model and triggers cache invalidation callback.
   * </Summary>
   */
  setModel(role: "advisor" | "agent", modelName: string): Promise<void>;
}
