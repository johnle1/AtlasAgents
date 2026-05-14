/**
 * <Summary>
 * What it does:
 *   Compares each request's metadata password to the server password captured
 *   in memory at process startup (never persisted).
 *
 * How it fits in the system:
 *   Used by RSocketServer on every frame with JSON metadata `{ password }`.
 *
 * Dependencies:
 *   - None (pure string comparison).
 *
 * Dependants:
 *   - RSocketServer — calls validate per request.
 * </Summary>
 */
export class AuthMiddleware {
  /**
   * @param {string} expectedPassword — Password typed at server startup; empty string enables dev mode (allow all).
   */
  constructor(private readonly expectedPassword: string) {}

  /**
   * <Summary>
   * What it does:
   *   Returns a fixed user id when the client password matches the expected
   *   password, or when the server runs in dev mode (empty expected password).
   *
   * How it does it (step by step):
   *   1. If expectedPassword is empty after trim, returns `shared` (dev mode).
   *   2. Otherwise compares trimmed metadata password to trimmed expected password.
   *   3. Returns `shared` on match, null on mismatch.
   *
   * Parameters:
   *   @param {string} metadataPassword — Value from JSON metadata `{ password: "..." }`.
   *
   * Returns:
   *   @returns {string | null} — `"shared"` when allowed, null when Unauthorized.
   *
   * Dependencies:
   *   - None.
   *
   * Dependants:
   *   - RSocketServer — attaches userId to routed requests.
   * </Summary>
   */
  validate = (metadataPassword: string): string | null => {
    const expected = this.expectedPassword.trim()
    if (expected.length === 0) {
      return 'shared'
    }
    return metadataPassword.trim() === expected ? 'shared' : null
  }
}
