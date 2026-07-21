/**
 * Custom error types for the application.
 *
 * @remarks
 * This module provides a centralized set of error classes that extend the base
 * {@link AppError} class. Each error type represents a specific failure scenario
 * with its own HTTP status code and machine-readable error code.
 *
 * **Error Classification by HTTP Status:**
 * - **400-level (Client Errors)**: Caller's responsibility to fix
 *   - {@link ValidationError} (400) — Invalid input
 *   - {@link UnauthorizedError} (401) — Authentication/authorization failure
 *   - {@link ConflictError} (409) — State or concurrent modification conflict
 *   - {@link NotFoundError} (404) — Missing resource
 * - **408 (Request Timeout)**: Operation exceeded time limit
 * - **499 (Client Closed Request)**: Operation intentionally aborted
 * - **500-level (Server Errors)**: Server must fix; caller should not retry immediately
 *   - {@link ConfigurationError} (500) — Invalid configuration
 *   - {@link OrchestrationError} (500) — Agent orchestration failure
 *
 * **Usage Pattern:**
 * ```ts
 * import { ValidationError, NotFoundError, AppError } from "./errors/index.js";
 *
 * try {
 *   * ... operation
 * } catch (err) {
 *   if (err instanceof ValidationError) {
 *     * Client error — send 400 response
 *   } else if (err instanceof AppError) {
 *     * Known app error — use status code and code
 *   }
 * }
 * ```
 */

// ===== BASE ERROR CLASSES =====
export { AppError } from "./appError.js";

// ===== CLIENT ERROR CLASSES (4xx) =====
/**
 * Thrown when input data or request validation fails (400).
 *
 * Caller should fix their input and retry. Not a server error.
 */
export { ValidationError } from "./validationError.js";

/**
 * Thrown when a requested resource does not exist (404).
 *
 * Caller should verify the resource exists before operating on it.
 */
export { NotFoundError } from "./notFoundError.js";

/**
 * Thrown when authentication fails or user lacks authorization (401).
 *
 * Caller must re-authenticate or request elevated permissions.
 */
export { UnauthorizedError } from "./unauthorizedError.js";

/**
 * Thrown when an operation conflicts with current state (409).
 *
 * Caller may retry after refreshing state information.
 */
export { ConflictError } from "./conflictError.js";

// ===== SPECIAL CLIENT ERRORS =====
/**
 * Thrown when an operation exceeds its allowed time limit (408).
 *
 * Caller may retry or consider optimizing the operation.
 */
export { TimeoutError } from "./timeoutError.js";

/**
 * Thrown when an operation is intentionally cancelled (499).
 *
 * Not a failure; indicates user or system abort. Perform cleanup.
 */
export { AbortError } from "./abortError.js";

// ===== SERVER ERROR CLASSES (5xx) =====
/**
 * Thrown when configuration is invalid or missing (500).
 *
 * Requires server admin intervention to fix. Caller should not retry.
 */
export { ConfigurationError } from "./configurationError.js";

/**
 * Thrown when agent orchestration or execution fails (500).
 *
 * Indicates a server-side orchestration failure. Caller should not retry immediately.
 */
export { OrchestrationError } from "./orchestrationError.js";
