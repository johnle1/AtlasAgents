/**
 * <Summary>
 * What it does:
 *   Base error class for all application errors with status code and error code.
 *
 * How it fits in the system:
 *   Provides a consistent error structure for error handling throughout the application.
 *   All custom errors should extend this base class.
 *
 * Dependencies:
 *   - Error - JavaScript Error class.
 *
 * Dependants:
 *   - All custom error classes (ValidationError, NotFoundError, etc.).
 * </Summary>
 */
export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}
