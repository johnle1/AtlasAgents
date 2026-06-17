/**
 * Command utility functions shared across command handlers.
 *
 * This module provides reusable utility functions for common operations
 * in command handlers, such as port validation and error message formatting.
 */

/**
 * <Summary>
 * What it does:
 *   Parses and validates a port number string to ensure it's within the valid TCP/UDP port range.
 *
 * How it does it (step by step):
 *   1. Trims whitespace from the input string to handle user input with leading/trailing spaces.
 *   2. Parses the string as a base-10 integer to convert it to a number.
 *   3. Validates that the parsed number is not NaN (not a number).
 *   4. Validates that the port number is within the valid range (1-65535).
 *   5. Returns null if validation fails, otherwise returns the valid port number.
 *
 * Parameters:
 *   @param {string} portString — The port number as a string (e.g., "8080", "3000").
 *
 * Returns:
 *   @returns {number | null} — The parsed port number if valid, null if invalid.
 *
 * Dependencies:
 *   - None (uses built-in parseInt and Number.isNaN).
 *
 * Dependants:
 *   - configHandlers.handleSet — uses this to validate user-provided port numbers.
 * </Summary>
 */
export const parsePort = (portString: string): number | null => {
  // ===== STEP 1: Trim whitespace from input =====
  // Step 1a: Remove leading and trailing whitespace from the port string
  // Step 1b: This handles cases where users might type " 8080 " or similar
  const trimmedPortString = portString.trim();

  // ===== STEP 2: Parse string to number =====
  // Step 2a: Parse the trimmed string as a base-10 integer
  // Step 2b: This converts "8080" to the number 8080
  const portNumber = parseInt(trimmedPortString, 10);

  // ===== STEP 3: Validate the parsed port number =====
  // Step 3a: Check if the parsed value is NaN (not a number)
  // Step 3b: Check if the port number is less than 1 (ports start at 1)
  // Step 3c: Check if the port number is greater than 65535 (maximum valid port)
  // Step 3d: Return null if any validation fails
  if (Number.isNaN(portNumber) || portNumber < 1 || portNumber > 65_535) {
    return null;
  }

  // ===== STEP 4: Return valid port number =====
  // Step 4a: The port number passed all validation checks
  // Step 4b: Return the valid port number for use in configuration
  return portNumber;
};

/**
 * <Summary>
 * What it does:
 *   Formats an unknown error value into a human-readable string message.
 *
 * How it does it (step by step):
 *   1. Checks if the error is an instance of the Error class.
 *   2. If it's an Error instance, extracts the message property.
 *   3. If it's not an Error instance, converts the value to a string.
 *   4. Returns the formatted error message string.
 *
 * Parameters:
 *   @param {unknown} error — The error value to format (can be Error, string, object, etc.).
 *
 * Returns:
 *   @returns {string} — A human-readable error message string.
 *
 * Dependencies:
 *   - None (uses instanceof and String conversion).
 *
 * Dependants:
 *   - modelHandlers.handleModels — uses this to format error messages from server operations.
 *   - Other command handlers — use this for consistent error message formatting.
 * </Summary>
 */
export const formatErrorMessage = (error: unknown): string => {
  // ===== STEP 1: Check if error is an Error instance =====
  // Step 1a: Use instanceof to check if the error is a proper Error object
  // Step 1b: Error objects have a message property that contains the error details
  if (error instanceof Error) {
    // ===== STEP 1a-i: Extract error message =====
    // Step 1a-i-1: Return the message property from the Error object
    // Step 1a-i-2: This provides a clean, human-readable error message
    return error.message;
  }

  // ===== STEP 2: Handle non-Error values =====
  // Step 2a: If the error is not an Error instance, convert it to a string
  // Step 2b: This handles cases where errors might be strings, numbers, or other objects
  // Step 2c: String() conversion provides a fallback representation of the error
  const errorAsString = String(error);
  return errorAsString;
};
