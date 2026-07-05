import { AppError } from "./appError.js";

/**
 * <Summary>
 * What it does:
 *   Error for state conflicts or concurrent modification issues.
 *
 * How it fits in the system:
 *   Used when an operation conflicts with current state or another operation.
 * </Summary>
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}
