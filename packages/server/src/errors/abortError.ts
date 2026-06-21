import { AppError } from "./appError.js";

/**
 * <Summary>
 * What it does:
 *   Error for aborted operations.
 *
 * How it fits in the system:
 *   Used when an operation is aborted by user request or signal.
 *
 * Dependencies:
 *   - AppError - base error class.
 *
 * Dependants:
 *   - AbortSignal handling throughout the application.
 * </Summary>
 */
export class AbortError extends AppError {
  constructor(message: string = "Operation aborted") {
    super(message, 499, "ABORTED");
  }
}
