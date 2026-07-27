import { AppError } from "./appError.js";

/**
 * Thrown when input data or request validation fails.
 *
 * @remarks
 * Used for:
 * - Invalid request body or query parameters
 * - Schema validation failures
 * - Type mismatches or format violations
 * - Business logic validation failures (e.g., negative quantity)
 *
 * Always returns HTTP 400 (Bad Request) status code. Callers should fix
 * their input and retry; this is not a server error.
 *
 * @example
 * ```ts
 *  * Validate user input
 * if (!email.includes("@")) {
 *   throw new ValidationError("Invalid email format");
 * }
 *
 *  * Handle validation errors
 * try {
 *   await processRequest(input);
 * } catch (err) {
 *   if (err instanceof ValidationError) {
 *     return response.status(400).json({
 *       error: err.message,
 *       code: "VALIDATION_ERROR"
 *     });
 *   }
 * }
 * ```
 */
export class ValidationError extends AppError {
  /**
   * Creates a validation error with a descriptive message.
   *
   * @param message - Description of what validation failed (e.g., "Email must be valid")
   */
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
  }
}
