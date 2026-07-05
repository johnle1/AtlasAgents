import { AppError } from "./appError.js";

/**
 * <Summary>
 * What it does:
 *   Error for requested resource not found.
 *
 * How it fits in the system:
 *   Used when a requested resource (file, model, config, etc.) cannot be found.
 * </Summary>
 */
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, "NOT_FOUND");
  }
}
