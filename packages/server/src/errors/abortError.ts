import { AppError } from "./appError.js";

/**
 * <Summary>
 * What it does:
 *   Error for aborted operations.
 *
 * How it fits in the system:
 *   Used when an operation is aborted by user request or signal.
 * </Summary>
 */
export class AbortError extends AppError {
  constructor(message: string = "Operation aborted") {
    super(message, 499, "ABORTED");
  }
}
