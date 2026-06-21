/**
 * <Summary>
 * What it does:
 *   Central export point for all custom error classes in the application.
 *
 * How it fits in the system:
 *   Provides a single location for importing all error types, ensuring
 *   consistent error handling across the codebase. This barrel export pattern
 *   simplifies imports and makes it easy to add new error types.
 *
 * Error Types Exported:
 *   - AppError: Base error class for all application errors
 *   - ValidationError: Invalid input data or validation failures
 *   - NotFoundError: Requested resource not found
 *   - UnauthorizedError: Authentication or authorization failures
 *   - ConflictError: Resource state conflicts (e.g., concurrent modifications)
 *   - TimeoutError: Operation timeout exceeded
 *   - AbortError: Operation intentionally aborted
 *   - ConfigurationError: Invalid or missing configuration
 *   - OrchestrationError: Agent orchestration and execution failures
 *
 * Dependencies:
 *   - All error classes in the errors directory.
 *
 * Dependants:
 *   - Application code that needs to throw or catch typed errors.
 *   - Error handling middleware and logging systems.
 * </Summary>
 */

// ===== BASE ERROR CLASSES =====
/**
 * Base error class for all application errors.
 * Extends the native Error class with application-specific functionality.
 */
export { AppError } from "./appError.js";

// ===== VALIDATION AND DATA ERRORS =====
/**
 * Thrown when input data fails validation or is invalid.
 * Used for request validation, schema validation, and data integrity checks.
 */
export { ValidationError } from "./validationError.js";

/**
 * Thrown when a requested resource cannot be found.
 * Used for missing files, records, or any resource that should exist but doesn't.
 */
export { NotFoundError } from "./notFoundError.js";

// ===== AUTHORIZATION ERRORS =====
/**
 * Thrown when authentication or authorization fails.
 * Used for login failures, permission denied, and access control issues.
 */
export { UnauthorizedError } from "./unauthorizedError.js";

// ===== CONCURRENCY AND CONFLICT ERRORS =====
/**
 * Thrown when a resource state conflict is detected.
 * Used for concurrent modification conflicts, version mismatches, and state conflicts.
 */
export { ConflictError } from "./conflictError.js";

// ===== TIMEOUT AND ABORT ERRORS =====
/**
 * Thrown when an operation exceeds its allowed time limit.
 * Used for API timeouts, database timeouts, and long-running operation limits.
 */
export { TimeoutError } from "./timeoutError.js";

/**
 * Thrown when an operation is intentionally aborted.
 * Used for user cancellations, system shutdowns, and intentional operation stops.
 */
export { AbortError } from "./abortError.js";

// ===== CONFIGURATION ERRORS =====
/**
 * Thrown when configuration is invalid, missing, or malformed.
 * Used for missing config files, invalid config values, and configuration errors.
 */
export { ConfigurationError } from "./configurationError.js";

// ===== ORCHESTRATION ERRORS =====
/**
 * Thrown when agent orchestration or execution fails.
 * Used for task execution failures, agent errors, and orchestration issues.
 */
export { OrchestrationError } from "./orchestrationError.js";
