import { AppError } from "./appError.js";

/**
 * <Summary>
 * What it does:
 *   Error for configuration issues.
 *
 * How it fits in the system:
 *   Used when configuration is missing, invalid, or inaccessible.
 * </Summary>
 */
export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(message, 500, "CONFIGURATION_ERROR");
  }
}
