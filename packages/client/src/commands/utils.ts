/**
 * Small shared helpers for slash-command handlers.
 *
 * @remarks
 * Keep parsing / error formatting here so individual handlers stay focused on
 * domain logic (config, models, memory, …).
 */

/**
 * Parses a TCP/UDP port string into an integer in `1…65535`, or `null`.
 *
 * @remarks
 * Trims whitespace first. Rejects `NaN`, `0`, negatives, and values above
 * `65535`. Does not accept trailing junk that `parseInt` would otherwise accept
 * only partially beyond the leading digits (callers typically pass trimmed
 * tokens from slash parsing).
 *
 * @param portString - User input such as `"8080"` or `" 7000 "`.
 * @returns Valid port number, or `null` when invalid.
 *
 * @example
 * ```ts
 * parsePort("8080");   // 8080
 * parsePort("0");      // null
 * parsePort("65536");  // null
 * parsePort("abc");    // null
 * ```
 */
export const parsePort = (portString: string): number | null => {
  const trimmedPortString = portString.trim();
  const portNumber = parseInt(trimmedPortString, 10);

  // Inclusive IANA range for non-zero TCP ports the CLI will bind/connect to.
  if (Number.isNaN(portNumber) || portNumber < 1 || portNumber > 65_535) {
    return null;
  }

  return portNumber;
};

/**
 * Turns an unknown thrown value into a user-facing error string.
 *
 * @remarks
 * Prefer `Error.message` when available; otherwise `String(error)` so handlers
 * can safely interpolate catch clauses without nested type guards.
 *
 * @param error - Value from a `catch` clause (`Error`, string, etc.).
 * @returns Human-readable message suitable for `printError`.
 *
 * @example
 * ```ts
 * try {
 *   await risky();
 * } catch (err) {
 *   printError(formatErrorMessage(err));
 * }
 * ```
 */
export const formatErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
