/**
 * Command utility functions.
 *
 * This module contains helper functions used across command handlers.
 */

/**
 * <Summary>
 * What it does:
 *   Parses a TCP port from user text for /set port validation.
 *
 * How it does it (step by step):
 *   1. Trims the string and parses base-10 integer.
 *   2. Returns null if NaN or outside inclusive range 1–65535.
 *   3. Otherwise returns the port number.
 *
 * Parameters:
 *   @param {string} portString — User-supplied or prompted port text.
 *
 * Returns:
 *   @returns {number | null} — Valid port, or null if unusable.
 *
 * Dependencies:
 *   - None (parseInt and Number helpers only).
 *
 * Dependants:
 *   - configHandlers.handleSet — /set port branch.
 * </Summary>
 */
export const parsePort = (portString: string): number | null => {
  // Parse the trimmed string as a base-10 integer
  const portNumber = parseInt(portString.trim(), 10);
  // Return null if parsing failed or outside valid port range
  if (Number.isNaN(portNumber) || portNumber < 1 || portNumber > 65_535)
    return null;
  // Return the validated port number
  return portNumber;
};
