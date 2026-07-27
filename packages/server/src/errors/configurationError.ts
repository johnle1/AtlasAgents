import { AppError } from "./appError.js";

/**
 * Thrown when application configuration is invalid, missing, or inaccessible.
 *
 * @remarks
 * Used for:
 * - Missing configuration files or environment variables
 * - Invalid configuration values or format
 * - Configuration file parsing errors (JSON, YAML, etc.)
 * - Missing required configuration keys
 * - Inaccessible configuration data sources
 *
 * Always returns HTTP 500 (Internal Server Error) status code, indicating
 * a server-side issue. Callers cannot recover from this without server
 * admin intervention to fix the configuration.
 *
 * @example
 * ```ts
 *  Validate required configuration
 * const config = loadConfig();
 * if (!config.ollamaUrl) {
 *   throw new ConfigurationError("Required config 'ollamaUrl' is missing");
 * }
 *
 *  Validate configuration format
 * if (typeof config.timeout !== "number" || config.timeout < 0) {
 *   throw new ConfigurationError("Config 'timeout' must be a positive number");
 * }
 * ```
 */
export class ConfigurationError extends AppError {
  /**
   * Creates a configuration error with diagnostic details.
   *
   * @param message - Description of the configuration issue, including
   *   what is missing/invalid and how to fix it (e.g., required key, expected format)
   */
  constructor(message: string) {
    super(message, 500, "CONFIGURATION_ERROR");
  }
}
