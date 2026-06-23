import { AppError } from "./appError.js";

/**
 * <Summary>
 * What it does:
 *   Error for orchestration failures.
 *
 * How it fits in the system:
 *   Used when orchestration pipeline fails (advisor planning, agent execution, etc.).
 * </Summary>
 */
export class OrchestrationError extends AppError {
  constructor(message: string) {
    super(message, 500, "ORCHESTRATION_ERROR");
  }
}
