import { AppError } from "./appError.js";

/**
 * <Summary>
 * What it does:
 *   Error for operation timeouts.
 *
 * How it fits in the system:
 *   Used when an operation exceeds its time limit.
 *
 * Dependencies:
 *   - AppError - base error class.
 *
 * Dependants:
 *   - Timeout handling in long-running operations.
 * </Summary>
 */
export class TimeoutError extends AppError {
  constructor(message: string) {
    super(message, 408, "TIMEOUT");
  }
}
