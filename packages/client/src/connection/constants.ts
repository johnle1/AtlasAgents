/**
 * Timing knobs for connect retries, reconnect backoff, and health probes.
 *
 * @remarks
 * All values are milliseconds. Tune carefully: shorter health timeouts detect
 * dead peers faster but amplify noise on slow networks; longer reconnect caps
 * reduce reconnect spam but leave the UI “stuck” reconnecting longer after an
 * outage. Used by {@link Connection} and {@link ConnectionLifecycle}.
 */

/**
 * Pause between failed attempts inside `Connection.waitUntilConnected`.
 *
 * @remarks
 * Kept short (200 ms) so interactive startup stays snappy without spinning the
 * CPU in a tight `connect()` loop while the server is still coming up.
 *
 * @defaultValue `200`
 */
export const CONNECT_RETRY_INTERVAL_MS = 200;

/**
 * Initial exponential-backoff delay for automatic reconnect after a drop.
 *
 * @remarks
 * Delay for attempt `n` (0-based) is roughly
 * `min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2^n)` plus jitter.
 * First wait ≈ 500 ms, then 1 s, 2 s, …
 *
 * @defaultValue `500`
 */
export const RECONNECT_BASE_DELAY_MS = 500;

/**
 * Upper bound on reconnect backoff before jitter is applied.
 *
 * @remarks
 * Stops the exponential from growing forever after a long outage. Once capped,
 * the client keeps retrying about every 30 s (+ jitter) until connect succeeds
 * or the process exits.
 *
 * @defaultValue `30_000`
 */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Maximum random milliseconds added on top of each reconnect delay.
 *
 * @remarks
 * Spreads simultaneous reconnects after a server restart (“thundering herd”).
 * Each attempt adds `floor(random() * RECONNECT_JITTER_MAX_MS)`.
 *
 * @defaultValue `250`
 */
export const RECONNECT_JITTER_MAX_MS = 250;

/**
 * Period between lightweight `session.exists` health probes while connected.
 *
 * @remarks
 * Chosen well above {@link HEALTH_CHECK_TIMEOUT_MS} so a slow probe cannot
 * overlap the next scheduled tick under normal conditions. Shorter intervals
 * catch dead TCP half-opens sooner at the cost of more chatter.
 *
 * @defaultValue `15_000`
 */
export const HEALTH_CHECK_INTERVAL_MS = 15_000;

/**
 * How long a health probe may take before the socket is treated as dead.
 *
 * @remarks
 * On timeout (or other probe failure) the client closes the RSocket so the
 * normal close path can schedule reconnect. Must stay meaningfully shorter
 * than {@link HEALTH_CHECK_INTERVAL_MS}.
 *
 * @defaultValue `5_000`
 */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;
