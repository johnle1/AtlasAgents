import { AppError } from "./appError.js";

/**
 * <Summary>
 * What it does:
 *   Error for invalid input or data validation failures.
 *
 * How it fits in the system:
 *   Used when user input or data fails validation checks.
 * </Summary>
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
  }
}
