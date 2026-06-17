import type { ConnectionStatus, StatusListener } from "./types.js";
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_JITTER_MAX_MS,
  RECONNECT_MAX_DELAY_MS,
} from "./constants.js";

/**
 * <Summary>
 * What it does:
 *   Defines the dependencies required by the ConnectionLifecycle class.
 *
 * Used by:
 *   - ConnectionLifecycle — constructor requires these dependencies.
 *
 * Produced by:
 *   - Connection — creates this object and passes it to ConnectionLifecycle constructor.
 * </Summary>
 */
export type ConnectionLifecycleDeps = {
  /** Function to initiate a connection attempt. */
  connect: () => Promise<void>;
  /** Function to clear the socket reference when connection closes. */
  clearSocket: () => void;
};

/**
 * <Summary>
 * What it does:
 *   Manages the connection lifecycle including status tracking, listener notifications,
 *   and automatic reconnection with exponential backoff.
 *
 * How it fits in the system:
 *   Handles the connection state machine and reconnection logic for the RSocket connection.
 *   Provides status change notifications to listeners and implements exponential backoff
 *   with jitter for reconnection attempts.
 *
 * Dependencies:
 *   - ConnectionLifecycleDeps — provides connect and clearSocket functions.
 *   - RECONNECT_BASE_DELAY_MS — base delay for exponential backoff calculation.
 *   - RECONNECT_JITTER_MAX_MS — maximum jitter to add to reconnection delay.
 *   - RECONNECT_MAX_DELAY_MS — maximum delay cap for exponential backoff.
 *
 * Dependants:
 *   - Connection — creates an instance and delegates lifecycle management to it.
 * </Summary>
 */
export class ConnectionLifecycle {
  /** Current connection status (disconnected, connecting, connected, reconnecting). */
  private currentStatus: ConnectionStatus = "disconnected";

  /** Set of registered listeners that receive connection status updates. */
  private readonly statusListeners = new Set<StatusListener>();

  /** Counter tracking the number of reconnection attempts (for exponential backoff). */
  private reconnectAttemptCounter = 0;

  /** Timer handle for scheduled reconnection attempts (null if no reconnect scheduled). */
  private reconnectTimerHandle: ReturnType<typeof setTimeout> | null = null;

  /** Flag to suppress automatic reconnection (used during intentional disconnects). */
  private suppressReconnectFlag = false;

  /**
   * <Summary>
   * What it does:
   *   Initializes the lifecycle manager with dependency injection.
   *
   * How it does it (step by step):
   *   1. Stores the provided dependencies for later use.
   *
   * Parameters:
   *   @param {ConnectionLifecycleDeps} lifecycleDependencies — Functions for connection and cleanup.
   *
   * Returns:
   *   void — constructor side effects only.
   *
   * Dependencies:
   *   None (field assignment only).
   *
   * Dependants:
   *   - Connection — creates ConnectionLifecycle with these dependencies.
   * </Summary>
   */
  constructor(
    private readonly lifecycleDependencies: ConnectionLifecycleDeps,
  ) {}

  /**
   * <Summary>
   * What it does:
   *   Registers a listener for connection status changes and returns an unsubscribe function.
   *
   * How it does it (step by step):
   *   1. Adds the callback to the statusListeners set.
   *   2. Immediately invokes the callback with the current status.
   *   3. Returns a function that removes the callback from the set.
   *
   * Parameters:
   *   @param {StatusListener} statusListenerCallback — Callback invoked with the new status.
   *
   * Returns:
   *   @returns {() => void} — Call this to unsubscribe from status updates.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - Connection.onConnectionStatus — delegates to this method.
   * </Summary>
   */
  onConnectionStatus = (
    statusListenerCallback: StatusListener,
  ): (() => void) => {
    // ===== STEP 1: Add Listener to Set =====
    // Step 1a: Add the callback to the set of status listeners
    // Step 1b: This ensures the listener will receive future status updates
    this.statusListeners.add(statusListenerCallback);

    // ===== STEP 2: Invoke Callback with Current Status =====
    // Step 2a: Immediately call the callback with the current status
    // Step 2b: This provides the initial status to the new listener
    statusListenerCallback(this.currentStatus);

    // ===== STEP 3: Return Unsubscribe Function =====
    // Step 3a: Return a function that removes the listener from the set
    // Step 3b: This allows the caller to clean up when they no longer need updates
    return () => {
      this.statusListeners.delete(statusListenerCallback);
    };
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the current connection status.
   *
   * How it does it (step by step):
   *   1. Returns the currentStatus field value.
   *
   * Returns:
   *   @returns {ConnectionStatus} — The current connection status.
   *
   * Dependencies:
   *   None (simple field access).
   *
   * Dependants:
   *   - Connection components — use this to check current status for display.
   * </Summary>
   */
  getStatus = (): ConnectionStatus => this.currentStatus;

  /**
   * <Summary>
   * What it does:
   *   Updates the connection status and notifies all registered listeners.
   *
   * How it does it (step by step):
   *   1. Returns immediately if the new status is the same as current (no change).
   *   2. Updates the currentStatus to the new status.
   *   3. Iterates through all listeners and invokes each with the new status.
   *
   * Parameters:
   *   @param {ConnectionStatus} newStatus — The new connection status to emit.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - Connection.connect — emits "connecting" and "connected" statuses.
   *   - Connection.handleSocketClosed — emits "disconnected" status.
   * </Summary>
   */
  emitStatus = (newStatus: ConnectionStatus): void => {
    // ===== STEP 1: Check for Status Change =====
    // Step 1a: If new status is the same as current, no need to notify listeners
    // Step 1b: This prevents unnecessary notifications when status hasn't changed
    if (this.currentStatus === newStatus) return;

    // ===== STEP 2: Update Current Status =====
    // Step 2a: Update the current status to the new value
    this.currentStatus = newStatus;

    // ===== STEP 3: Notify All Listeners =====
    // Step 3a: Iterate through all registered status listeners
    // Step 3b: Invoke each listener with the new status
    // Step 3c: This ensures all listeners receive the status update
    for (const statusListener of this.statusListeners) {
      statusListener(newStatus);
    }
  };

  /**
   * <Summary>
   * What it does:
   *   Sets the flag to suppress automatic reconnection.
   *
   * How it does it (step by step):
   *   1. Updates the suppressReconnectFlag to the provided value.
   *
   * Parameters:
   *   @param {boolean} suppressFlag — True to suppress reconnect, false to allow reconnect.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - Connection.reload — suppresses reconnect during intentional reconnection.
   * </Summary>
   */
  setSuppressReconnect = (suppressFlag: boolean): void => {
    // ===== STEP 1: Update Suppress Flag =====
    // Step 1a: Set the suppress reconnect flag to the provided value
    // Step 1b: When true, automatic reconnection will be skipped
    this.suppressReconnectFlag = suppressFlag;
  };

  /**
   * <Summary>
   * What it does:
   *   Returns whether automatic reconnection is currently suppressed.
   *
   * How it does it (step by step):
   *   1. Returns the suppressReconnectFlag value.
   *
   * Returns:
   *   @returns {boolean} — True if reconnect is suppressed, false otherwise.
   *
   * Dependencies:
   *   None (simple field access).
   *
   * Dependants:
   *   - Connection.suppressReconnect — exposes this for testing purposes.
   * </Summary>
   */
  isReconnectSuppressed = (): boolean => this.suppressReconnectFlag;

  /**
   * <Summary>
   * What it does:
   *   Cancels any pending reconnection timer.
   *
   * How it does it (step by step):
   *   1. Checks if a reconnect timer is active.
   *   2. If active, clears the timeout and nulls the handle.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   None (uses clearTimeout).
   *
   * Dependants:
   *   - Connection.clearReconnectTimer — delegates to this method.
   * </Summary>
   */
  cancelReconnect = (): void => {
    // ===== STEP 1: Check for Active Timer =====
    // Step 1a: Check if there is a pending reconnection timer
    if (this.reconnectTimerHandle) {
      // ===== STEP 1a-i: Cancel the Timer =====
      // Step 1a-i-1: Clear the timeout to prevent the reconnection attempt
      clearTimeout(this.reconnectTimerHandle);

      // Step 1a-i-2: Null the handle to indicate no timer is active
      this.reconnectTimerHandle = null;
    }
  };

  /**
   * <Summary>
   * What it does:
   *   Resets the reconnection attempt counter to zero.
   *
   * How it does it (step by step):
   *   1. Sets the reconnect attempt counter to zero.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - Connection.connect — resets counter after successful connection.
   * </Summary>
   */
  resetReconnectAttempt = (): void => {
    // ===== STEP 1: Reset Reconnect Counter =====
    // Step 1a: Set the reconnect attempt counter back to zero
    // Step 1b: This is called after a successful connection to restart the backoff sequence
    this.reconnectAttemptCounter = 0;
  };

  /**
   * <Summary>
   * What it does:
   *   Handles socket close event by cleaning up and optionally scheduling reconnection.
   *
   * How it does it (step by step):
   *   1. Calls clearSocket to null the socket reference.
   *   2. Emits "disconnected" status.
   *   3. If reconnect is suppressed, returns without scheduling reconnect.
   *   4. Otherwise, schedules a reconnection attempt.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - lifecycleDependencies.clearSocket — clears the socket reference.
   *   - emitStatus — notifies listeners of status change.
   *   - scheduleReconnect — initiates reconnection attempt.
   *
   * Dependants:
   *   - Connection.onClose callback — calls this when socket closes.
   * </Summary>
   */
  handleSocketClosed = (): void => {
    // ===== STEP 1: Clear Socket Reference =====
    // Step 1a: Call the clearSocket function to null the socket reference
    // Step 1b: This prevents further operations on the closed socket
    this.lifecycleDependencies.clearSocket();

    // ===== STEP 2: Update Connection Status =====
    // Step 2a: Emit "disconnected" status to notify listeners
    // Step 2b: This updates UI components and other status consumers
    this.emitStatus("disconnected");

    // ===== STEP 3: Check if Reconnect is Suppressed =====
    // Step 3a: If reconnect flag is set, skip automatic reconnection
    // Step 3b: This is used during intentional disconnects (e.g., config reload)
    if (this.suppressReconnectFlag) return;

    // ===== STEP 4: Schedule Reconnection Attempt =====
    // Step 4a: Schedule a reconnection attempt with exponential backoff
    // Step 4b: This implements automatic reconnection with increasing delays
    this.scheduleReconnect();
  };

  /**
   * <Summary>
   * What it does:
   *   Schedules a reconnection attempt with exponential backoff and jitter.
   *
   * How it does it (step by step):
   *   1. Returns if reconnect is already scheduled or suppressed.
   *   2. Emits "reconnecting" status.
   *   3. Calculates exponential backoff delay based on attempt count.
   *   4. Adds random jitter to prevent thundering herd problem.
   *   5. Sets timer to attempt connection after calculated delay.
   *   6. On success: resets attempt counter.
   *   7. On failure: increments counter and schedules next attempt.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - RECONNECT_BASE_DELAY_MS — base delay for backoff calculation.
   *   - RECONNECT_JITTER_MAX_MS — maximum jitter to add.
   *   - RECONNECT_MAX_DELAY_MS — maximum delay cap.
   *   - lifecycleDependencies.connect — attempts reconnection.
   *
   * Dependants:
   *   - handleSocketClosed — calls this to schedule reconnect after disconnect.
   * </Summary>
   */
  scheduleReconnect = (): void => {
    // ===== STEP 1: Check Reconnection Preconditions =====
    // Step 1a: Return if reconnect timer is already set (avoid duplicate timers)
    // Step 1b: Return if reconnect is suppressed (respect the suppress flag)
    if (this.reconnectTimerHandle || this.suppressReconnectFlag) return;

    // ===== STEP 2: Update Connection Status =====
    // Step 2a: Emit "reconnecting" status to notify listeners
    // Step 2b: This updates UI to show reconnection is in progress
    this.emitStatus("reconnecting");

    // ===== STEP 3: Calculate Exponential Backoff Delay =====
    // Step 3a: Calculate base delay using exponential backoff formula
    // Step 3b: Formula: BASE_DELAY * 2^attempt (doubles each attempt)
    // Step 3c: Cap at MAX_DELAY to prevent excessively long delays
    const exponentialDelay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttemptCounter,
    );

    // ===== STEP 4: Add Random Jitter =====
    // Step 4a: Add random jitter to the exponential delay
    // Step 4b: Jitter prevents multiple clients from reconnecting simultaneously
    // Step 4c: This mitigates the "thundering herd" problem on server restart
    const reconnectDelayWithJitter =
      exponentialDelay + Math.floor(Math.random() * RECONNECT_JITTER_MAX_MS);

    // ===== STEP 5: Schedule Reconnection Attempt =====
    // Step 5a: Set a timeout to attempt connection after calculated delay
    this.reconnectTimerHandle = setTimeout(() => {
      // ===== STEP 5a-i: Clear Timer Handle =====
      // Step 5a-i-1: Null the timer handle to indicate timer has fired
      this.reconnectTimerHandle = null;

      // ===== STEP 5a-ii: Attempt Connection =====
      // Step 5a-ii-1: Attempt to connect using the provided connect function
      // Step 5a-ii-2: Use void to avoid unhandled promise rejection warning
      void this.lifecycleDependencies
        .connect()
        .then(() => {
          // ===== STEP 5a-ii-1-a: Connection Succeeded =====
          // Step 5a-ii-1-a-1: Reset the reconnect attempt counter on success
          // Step 5a-ii-1-a-2: This restarts the backoff sequence for future disconnects
          this.reconnectAttemptCounter = 0;
        })
        .catch(() => {
          // ===== STEP 5a-ii-1-b: Connection Failed =====
          // Step 5a-ii-1-b-1: Increment the reconnect attempt counter
          // Step 5a-ii-1-b-2: This increases the delay for the next attempt
          this.reconnectAttemptCounter++;

          // Step 5a-ii-1-b-3: Schedule the next reconnection attempt
          // Step 5a-ii-1-b-4: This implements the retry loop with increasing delays
          this.scheduleReconnect();
        });
    }, reconnectDelayWithJitter);
  };
}
