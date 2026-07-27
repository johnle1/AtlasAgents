/**
 * Base error class for all application errors.
 *
 * @remarks
 * Extends the native JavaScript Error with application-specific properties:
 * - `statusCode`: HTTP status code for API responses (400, 404, 500, etc.)
 * - `code`: Machine-readable error code for programmatic handling (e.g., "NOT_FOUND")
 *
 * All custom error types in the application should extend this class. This ensures
 * consistent error handling, proper HTTP status codes in responses, and uniform
 * error codes for client-side error detection.
 *
 * Stack traces are automatically captured for debugging.
 *
 * @example
 * ```ts
 *   Extend AppError for custom error types
 * export class MyCustomError extends AppError {
 *   constructor(message: string) {
 *     super(message, 400, "MY_CUSTOM_ERROR");
 *   }
 * }
 *
 *  Throw and catch
 * try {
 *   throw new MyCustomError("Something went wrong");
 * } catch (err) {
 *   if (err instanceof AppError) {
 *     console.log(`Error ${err.code}: ${err.message}`);
 *     response.status(err.statusCode).json({ code: err.code });
 *   }
 * }
 * ```
 */
export class AppError extends Error {
  /**
   * Creates a new application error with HTTP status and error code.
   *
   * @param message - Human-readable error description
   * @param statusCode - HTTP status code for API responses
   * @param code - Machine-readable error code for client handling
   */
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
