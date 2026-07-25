import { ConfigurationError } from "../errors/index.js";

/**
 * Authentication middleware for RSocket connections.
 *
 * Validates client passwords against a server-side password captured at startup.
 * All authenticated clients share a single user ID (`"shared"`), allowing multiple
 * concurrent CLI clients to communicate with a single server instance without
 * per-user isolation.
 *
 * **Integration Point:**
 * - Called by `RSocketServer` on every incoming RSocket frame
 * - Expects client metadata in format: `{ password: "user-provided-password" }`
 * - Password is never persisted; it exists only in server process memory
 *
 * **No unauthenticated mode:**
 * - A non-empty password is required. Because the listener binds all
 *   interfaces, an empty password would expose the agent's file and shell
 *   tooling to anyone who can reach the port, so the constructor throws
 *   rather than accepting one.
 *
 * @example
 * ```typescript
 * const auth = new AuthMiddleware("my-secure-password");
 * auth.validate("my-secure-password"); // → "shared"
 * auth.validate("wrong"); // → null
 *
 * An empty (or whitespace-only) password is rejected outright:
 * new AuthMiddleware(""); // throws ConfigurationError
 * ```
 */
export class AuthMiddleware {
  /**
   * Initialize authentication middleware with a server password.
   *
   * @param expectedPassword - The password typed by operator at server startup.
   *                          Password is stored in memory, never written to disk.
   *
   * @throws {ConfigurationError} When `expectedPassword` is empty or only
   *   whitespace — every server start must set a real password.
   */
  constructor(private readonly expectedPassword: string) {
    if (expectedPassword.trim().length === 0) {
      throw new ConfigurationError(
        "Refusing to start with an empty password: every client would be " +
          "authenticated automatically. Set a password to start the server.",
      );
    }
  }

  /**
   * Validate a client's password and return a user ID on success.
   *
   * **Authentication Logic:**
   * 1. Trim the expected password from constructor
   * 2. Compare trimmed client password to trimmed expected password
   * 3. On match → return shared user ID; on mismatch → return null (unauthorized)
   *
   * **Return Value Meaning:**
   * - `"shared"`: Client authorized; all authenticated clients share this user ID
   * - `null`: Client unauthorized; connection should be rejected by RSocketServer
   *
   * **Whitespace Handling:**
   * Both passwords are trimmed before comparison. This prevents accidental auth failures
   * due to leading/trailing spaces. For example, `" password "` and `"password"` match.
   *
   * @param metadataPassword - The password provided by the client in RSocket
   *                          connection metadata, extracted from JSON `{ password: "..." }`.
   *                          Empty or missing strings always fail auth.
   *
   * @returns `"shared"` when the password matches, `null` on mismatch.
   *
   * @example
   * ```typescript
   * const auth = new AuthMiddleware("secret123");
   *
   * auth.validate("secret123");   // → "shared" (exact match)
   * auth.validate(" secret123 "); // → "shared" (whitespace trimmed)
   * auth.validate("wrong");       // → null (mismatch)
   * auth.validate("");            // → null (empty doesn't match "secret123")
   * ```
   */
  validate = (metadataPassword: string): string | null => {
    // Trim the expected password to remove any accidental whitespace
    // from operator input at startup
    const expected = this.expectedPassword.trim();

    // Compare trimmed client password to expected password.
    // Trim client input too, so "password " matches "password"
    // Return "shared" user ID on match, null (unauthorized) on mismatch
    return metadataPassword.trim() === expected ? "shared" : null;
  };
}
