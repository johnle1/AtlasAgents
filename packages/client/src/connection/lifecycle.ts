/**
 * Connection status machine and automatic reconnect scheduling.
 *
 * @remarks
 * {@link Connection} owns the live RSocket and delegates status transitions,
 * listener fan-out, and exponential-backoff reconnect to this class so the
 * socket plumbing stays separate from the reconnect policy.
 */

import type { ConnectionStatus, StatusListener } from "./types.js";
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_JITTER_MAX_MS,
  RECONNECT_MAX_DELAY_MS,
} from "./constants.js";

/**
 * Injected hooks {@link ConnectionLifecycle} needs from the owning connection.
 *
 * @remarks
 * Dependency injection keeps this class free of RSocket imports: reconnect
 * calls back into `Connection.connect`, and socket teardown clears the owner’s
 * `rsocket` field via `clearSocket`.
 *
 * @example
 * ```ts
 * const deps: ConnectionLifecycleDeps = {
 *   connect: () => connection.connect(),
 *   clearSocket: () => {
 *     connectionSocket = null;
 *   },
 * };
 * ```
 */
export type ConnectionLifecycleDeps = {
  /** Attempt (or re-attempt) a full RSocket handshake. */
  connect: () => Promise<void>;

  /**
   * Drop the owner’s socket reference after close so later calls see
   * disconnected state before reconnect finishes.
   */
  clearSocket: () => void;
};

/**
 * Tracks connection status, notifies listeners, and schedules reconnects.
 *
 * @remarks
 * **Status:** `emitStatus` ignores no-ops (same status twice) so UIs are not
 * spammed. `onConnectionStatus` always fires once immediately with the current
 * value so new subscribers synchronize without waiting for the next event.
 *
 * **Reconnect:** On unexpected close, `handleSocketClosed` schedules
 * `connect()` with exponential backoff + jitter unless
 * `setSuppressReconnect(true)` (used during intentional `reload` / teardown).
 * Only one reconnect timer is active at a time; failures increment the attempt
 * counter and reschedule; success resets the counter to zero.
 *
 * @example
 * ```ts
 * const lifecycle = new ConnectionLifecycle({
 *   connect: () => owner.connect(),
 *   clearSocket: () => {
 *     ownerSocket = null;
 *   },
 * });
 *
 * const unsubscribe = lifecycle.onConnectionStatus((status) => {
 *   console.log(status);
 * });
 * // After an unexpected close (auto-reconnect allowed):
 * lifecycle.handleSocketClosed();
 * unsubscribe();
 * ```
 */
export class ConnectionLifecycle {
  /** Last emitted status; starts disconnected before any handshake. */
  private currentStatus: ConnectionStatus = "Disconnected";

  /** Subscribers notified on every distinct status change. */
  private readonly statusListeners = new Set<StatusListener>();

  /**
   * Zero-based reconnection attempt index used in `baseDelay * 2^attempt`.
   * Reset to `0` after a successful reconnect.
   */
  private reconnectAttemptCounter = 0;

  /** Pending reconnect timeout; non-null means a retry is already scheduled. */
  private reconnectTimerHandle: ReturnType<typeof setTimeout> | null = null;

  /**
   * When true, `handleSocketClosed` / `scheduleReconnect` skip auto-retry.
   * Set around intentional disconnects (config reload) so closing the old
   * socket does not race a stale reconnect into the new settings.
   */
  private suppressReconnectFlag = false;

  /**
   * Creates a lifecycle controller bound to an owning connection’s hooks.
   *
   * @param lifecycleDependencies - `connect` + `clearSocket` implementations.
   */
  constructor(
    private readonly lifecycleDependencies: ConnectionLifecycleDeps,
  ) {}

  /**
   * Subscribes to status changes and returns an unsubscribe function.
   *
   * @remarks
   * The listener is invoked immediately with {@link getStatus} so React/Ink
   * bridges can render the current banner without a flash of stale state.
   *
   * @param statusListenerCallback - Invoked on register and on each new status.
   * @returns Function that removes this listener (idempotent if called twice
   *   after the listener was already removed).
   *
   * @example
   * ```ts
   * const off = lifecycle.onConnectionStatus((status) => {
   *   setUiStatus(status);
   * });
   * // …
   * off();
   * ```
   */
  onConnectionStatus = (
    statusListenerCallback: StatusListener,
  ): (() => void) => {
    this.statusListeners.add(statusListenerCallback);
    // Push current status so new UI mounts do not wait for the next transition.
    statusListenerCallback(this.currentStatus);
    return () => {
      this.statusListeners.delete(statusListenerCallback);
    };
  };

  /**
   * Returns the last emitted {@link ConnectionStatus}.
   *
   * @returns Current status string (`"Disconnected"` before first connect).
   */
  getStatus = (): ConnectionStatus => this.currentStatus;

  /**
   * Transitions status and notifies listeners when the value actually changes.
   *
   * @remarks
   * No-op when `newStatus === currentStatus` to avoid redundant re-renders.
   *
   * @param newStatus - Status to publish.
   */
  emitStatus = (newStatus: ConnectionStatus): void => {
    if (this.currentStatus === newStatus) return;
    this.currentStatus = newStatus;
    for (const statusListener of this.statusListeners) {
      statusListener(newStatus);
    }
  };

  /**
   * Enables or disables automatic reconnect after socket close.
   *
   * @param suppressFlag - `true` to skip scheduling reconnect; `false` to allow it.
   */
  setSuppressReconnect = (suppressFlag: boolean): void => {
    this.suppressReconnectFlag = suppressFlag;
  };

  /**
   * Whether automatic reconnect is currently suppressed.
   *
   * @returns `true` if closes must not schedule reconnect.
   */
  isReconnectSuppressed = (): boolean => this.suppressReconnectFlag;

  /**
   * Cancels a pending reconnect timer, if any.
   *
   * @remarks
   * Safe to call when no timer is armed. Does not change {@link getStatus}.
   */
  cancelReconnect = (): void => {
    if (this.reconnectTimerHandle) {
      clearTimeout(this.reconnectTimerHandle);
      this.reconnectTimerHandle = null;
    }
  };

  /**
   * Resets the exponential backoff attempt counter to zero.
   *
   * @remarks
   * Call after a successful handshake so the next failure starts from the
   * short base delay again instead of staying near the max backoff.
   */
  resetReconnectAttempt = (): void => {
    this.reconnectAttemptCounter = 0;
  };

  /**
   * Handles an unexpected (or final) socket close: clear socket, emit status,
   * optionally schedule reconnect.
   *
   * @remarks
   * Always clears the owner socket and sets status to `"Disconnected"`. If
   * reconnect is suppressed (intentional teardown), returns without scheduling.
   * Otherwise delegates to {@link scheduleReconnect}.
   */
  handleSocketClosed = (): void => {
    this.lifecycleDependencies.clearSocket();
    this.emitStatus("Disconnected");
    // Intentional disconnect (reload / shutdown) must not start a ghost reconnect.
    if (this.suppressReconnectFlag) return;
    this.scheduleReconnect();
  };

  /**
   * Arms a single reconnect attempt using exponential backoff + jitter.
   *
   * @remarks
   * No-ops if a timer is already pending or reconnect is suppressed. Delay is
   * `min(MAX, BASE * 2^attempt) + random(0..JITTER)`. On success the attempt
   * counter resets; on failure it increments and this method schedules again.
   *
   * The `connect()` promise is intentionally not awaited by callers of this
   * method — failures are handled inside the timer callback.
   */
  scheduleReconnect = (): void => {
    // Coalesce: never stack multiple timers for the same outage window.
    if (this.reconnectTimerHandle || this.suppressReconnectFlag) return;

    this.emitStatus("Reconnecting");

    const exponentialDelay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttemptCounter,
    );

    // Jitter desynchronizes clients that all dropped when the server restarted.
    const reconnectDelayWithJitter =
      exponentialDelay + Math.floor(Math.random() * RECONNECT_JITTER_MAX_MS);

    this.reconnectTimerHandle = setTimeout(() => {
      // Allow a future scheduleReconnect if this attempt fails.
      this.reconnectTimerHandle = null;
      void this.lifecycleDependencies
        .connect()
        .then(() => {
          this.reconnectAttemptCounter = 0;
        })
        .catch(() => {
          this.reconnectAttemptCounter++;
          this.scheduleReconnect();
        });
    }, reconnectDelayWithJitter);
  };
}
