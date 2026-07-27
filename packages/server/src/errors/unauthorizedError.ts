import { AppError } from "./appError.js";

/**
 * Thrown when authentication fails or user lacks authorization.
 *
 * @remarks
 * Used for:
 * - Failed login attempts or invalid credentials
 * - Missing or expired authentication tokens
 * - User lacks required permissions for an operation
 * - Session has expired
 *
 * Always returns HTTP 401 (Unauthorized) status code. Callers should
 * re-authenticate or request elevated permissions before retrying.
 *
 * @example
 * ```ts
 *  * Check authentication
 * const token = request.headers.authorization?.split(" ")[1];
 * if (!token || !verifyToken(token)) {
 *   throw new UnauthorizedError("Invalid or missing authentication token");
 * }
 *
 *  * Check authorization
 * if (!user.hasPermission("admin")) {
 *   throw new UnauthorizedError("User lacks required permissions");
 * }
 * ```
 */
export class UnauthorizedError extends AppError {
  /**
   * Creates an authorization error with optional custom message.
   *
   * @param message - Description of why authorization failed.
   *   Defaults to "Unauthorized" if not provided.
   */
  constructor(message: string = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}
