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
 * **Dev Mode:**
 * - When server starts with an empty password (user presses enter without typing),
 *   dev mode activates and all connections are automatically approved
 * - Intended for local development without authentication friction
 *
 * @example
 * ```typescript
 * Production: require password
 * const auth = new AuthMiddleware("my-secure-password");
 * auth.validate("my-secure-password"); // → "shared"
 * auth.validate("wrong"); // → null
 *
 * Dev mode allows all:
 * const devAuth = new AuthMiddleware("");
 * devAuth.validate("anything"); // → "shared"
 * ```
 */
export class AuthMiddleware {
  /**
   * Initialize authentication middleware with a server password.
   *
   * @param expectedPassword - The password typed by operator at server startup.
   *                          Empty string (or only whitespace) activates dev mode,
   *                          which bypasses password validation and accepts all connections.
   *                          Password is stored in memory, never written to disk.
   */
  constructor(private readonly expectedPassword: string) {}

  /**
   * Validate a client's password and return a user ID on success.
   *
   * **Authentication Logic:**
   * 1. Trim the expected password from constructor
   * 2. If empty → dev mode active → approve all clients
   * 3. Otherwise → compare trimmed client password to trimmed expected password
   * 4. On match → return shared user ID; on mismatch → return null (unauthorized)
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
   *                          Empty or missing strings will fail auth (unless dev mode).
   *
   * @returns `"shared"` when client is authorized (password matches or dev mode),
   *          `null` when client is unauthorized (password mismatch in production mode).
   *
   * @example
   * ```typescript
   * const auth = new AuthMiddleware("secret123");
   *
   * Production validation:
   * auth.validate("secret123");   // → "shared" (exact match)
   * auth.validate(" secret123 "); // → "shared" (whitespace trimmed)
   * auth.validate("wrong");       // → null (mismatch)
   * auth.validate("");            // → null (empty doesn't match "secret123")
   *
   * Dev mode validation:
   * const devAuth = new AuthMiddleware("");
   * devAuth.validate("anything");  // → "shared" (all allowed)
   * devAuth.validate("");          // → "shared" (all allowed)
   * ```
   */
  validate = (metadataPassword: string): string | null => {
    // Trim the expected password to remove any accidental whitespace
    // from operator input at startup
    const expected = this.expectedPassword.trim();

    // Dev mode: if no password was set, approve all connections
    // This is indicated by an empty string after trimming
    if (expected.length === 0) {
      return "shared";
    }

    // Production mode: compare trimmed client password to expected password
    // Trim client input too, so "password " matches "password"
    // Return "shared" user ID on match, null (unauthorized) on mismatch
    return metadataPassword.trim() === expected ? "shared" : null;
  };
}
