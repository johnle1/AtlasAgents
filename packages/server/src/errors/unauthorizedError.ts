import { AppError } from "./appError.js";

/**
 * <Summary>
 * What it does:
 *   Error for authentication or authorization failures.
 *
 * How it fits in the system:
 *   Used when authentication fails or user lacks permission for an operation.
 * </Summary>
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}
