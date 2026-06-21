import { AppError } from "./appError.js";

/**
 * <Summary>
 * What it does:
 *   Error for configuration issues.
 *
 * How it fits in the system:
 *   Used when configuration is missing, invalid, or inaccessible.
 *
 * Dependencies:
 *   - AppError - base error class.
 *
 * Dependants:
 *   - Configuration loading and validation logic.
 * </Summary>
 */
export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(message, 500, "CONFIGURATION_ERROR");
  }
}
