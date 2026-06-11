import { RSocketConnector, type RSocket } from "@rsocket/core";
import { TcpClientTransport } from "@rsocket/tcp-client";
import type { Config } from "../config.js";
import type { TaskFrame } from "../frames.js";
import type { LocalFileProxy } from "../localFileProxy.js";
import {
  clearMemory as clearMemoryFn,
  fetchModels as fetchModelsFn,
  fetchModelsDetailed as fetchModelsDetailedFn,
  forgetMemory as forgetMemoryFn,
  getMemory as getMemoryFn,
  respondConfirmation as respondConfirmationFn,
  respondPlan as respondPlanFn,
  sendCommand as sendCommandFn,
  syncSkills as syncSkillsFn,
} from "./commands.js";
import { createFileResponder } from "./fileResponder.js";
import {
  sendStream as sendStreamFn,
  sendTask as sendTaskFn,
} from "./streaming.js";
import type {
  ConnectionStatus,
  SkillPayload,
  StatusListener,
} from "./types.js";
import { authMetadata, requireSocket } from "./utils.js";

export type { PullProgress, TaskFrame } from "../frames.js";

/**
 * <Summary>
 * What it does:
 *   Manages the single persistent RSocket TCP connection to the LoopyCode
 *   server, sending tasks as requestStream and commands as requestResponse.
 *
 * How it fits in the system:
 *   Sits between the CLI input loop (index.ts / CommandHandler) and the
 *   server. All server communication flows through this class so transport
 *   logic is centralised in one place.
 *
 * Dependencies:
 *   - RSocketConnector — establishes the RSocket session.
 *   - TcpClientTransport — TCP transport layer under RSocket.
 *   - commands.js, streaming.js — wire-level send helpers.
 *   - utils.js — auth metadata and socket guard helpers.
 *   - fileResponder.js — handles server-initiated file operations.
 *
 * Dependants:
 *   - index.ts main() — creates a Connection instance on startup.
 *   - CommandHandler — calls listModels, syncSkills, getMemory, etc.
 *   - taskStream.runTaskStream — calls sendTask for user tasks.
 * </Summary>
 */
export class Connection {
  /** Current client configuration (server, port, models, password, etc.). */
  private config: Config;

  /** Live RSocket instance after successful connect, null when disconnected. */
  private rsocket: RSocket | null = null;

  /** In-flight connect promise used as a mutex to prevent duplicate connections. */
  private establishing: Promise<void> | null = null;

  /** Current connection state for status emission. */
  private status: ConnectionStatus = "disconnected";

  /** Set of callbacks notified on every status change. */
  private readonly statusListeners = new Set<StatusListener>();

  /** Counter driving exponential backoff delay between reconnect attempts. */
  private reconnectAttempt = 0;

  /** Handle for the pending reconnect setTimeout so it can be cancelled. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** When true, socket close does not schedule reconnect (reload / shutdown). */
  private suppressReconnect = false;

  /** Local file proxy used by the RSocket responder for server-initiated file ops. */
  private fileProxy: LocalFileProxy | null = null;

  /**
   * <Summary>
   * What it does:
   *   Initializes a new Connection instance with the provided configuration.
   *
   * How it does it (step by step):
   *   1. Stores the provided config object in the instance.
   *
   * Parameters:
   *   @param {Config} config — Initial configuration with server address, port,
   *     password, model names, and timeout settings.
   *
   * Returns:
   *   void — constructor returns nothing.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - index.ts main() — creates a Connection instance on startup.
   * </Summary>
   */
  constructor(config: Config) {
    // ===== STEP 1: Store Configuration =====
    // Step 1a: Save the provided config for use in connection methods
    this.config = config;
  }

  /**
   * <Summary>
   * What it does:
   *   Registers a listener for connection status changes and returns an
   *   unsubscribe function.
   *
   * How it does it (step by step):
   *   1. Adds the callback to the statusListeners set.
   *   2. Immediately invokes the callback with the current status.
   *   3. Returns a function that removes the callback from the set.
   *
   * Parameters:
   *   @param {StatusListener} cb — Callback invoked with the new status string.
   *
   * Returns:
   *   @returns {() => void} — Call this to unsubscribe.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - index.ts main() — subscribes to print connection status in the CLI.
   *   - App.tsx — drives ConnectionStatusLine in the Ink UI.
   * </Summary>
   */
  onConnectionStatus = (cb: StatusListener): (() => void) => {
    // ===== STEP 1: Register Listener =====
    // Step 1a: Add the callback to the statusListeners set
    // Step 1b: Set ensures no duplicate callbacks
    this.statusListeners.add(cb);

    // ===== STEP 2: Notify Listener of Current Status =====
    // Step 2a: Immediately invoke the callback with the current status
    // Step 2b: Ensures listener has the latest state even if connection already established
    cb(this.status);

    // ===== STEP 3: Return Unsubscribe Function =====
    // Step 3a: Return a function that removes this callback when called
    // Step 3b: Allows listeners to clean up their subscription
    return () => {
      this.statusListeners.delete(cb);
    };
  };

  /**
   * <Summary>
   * What it does:
   *   Updates the internal status and notifies all registered listeners.
   *
   * How it does it (step by step):
   *   1. Skips if the new status equals the current status (no duplicate events).
   *   2. Stores the new status.
   *   3. Iterates the statusListeners set and calls each callback.
   *
   * Parameters:
   *   @param {ConnectionStatus} next — The new connection state.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - Connection.connect — emits "connecting" and "connected" or "disconnected".
   *   - Connection.handleSocketClosed — emits "disconnected".
   *   - Connection.scheduleReconnect — emits "reconnecting".
   * </Summary>
   */
  private emitStatus = (next: ConnectionStatus): void => {
    // ===== STEP 1: Check for Duplicate Status =====
    // Step 1a: If status hasn't changed, skip emission to avoid duplicate events
    if (this.status === next) return;

    // ===== STEP 2: Update Internal State =====
    // Step 2a: Store the new status for future subscribers and queries
    this.status = next;

    // ===== STEP 3: Notify All Listeners =====
    // Step 3a: Iterate through the set of registered listener callbacks
    // Step 3b: Call each listener with the new status value
    for (const fn of this.statusListeners) {
      fn(next);
    }
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Blocks until an RSocket connection is live, retrying connect attempts
   *   until config.timeout milliseconds have elapsed.
   *
   * How it does it (step by step):
   *   1. Calculates a deadline from Date.now() + config.timeout.
   *   2. Loops: if rsocket exists, returns immediately.
   *   3. If past deadline, throws a timeout error with host and port.
   *   4. Tries this.connect(); if it succeeds and rsocket is set, returns.
   *   5. On connect failure, sleeps 200ms and retries.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when connected.
   *
   * @throws {Error} — When the timeout elapses without a successful connection.
   *
   * Dependencies:
   *   - Connection.connect — attempts to open the TCP + RSocket session.
   *
   * Dependants:
   *   - Connection.sendCommand — waits for connection before sending.
   *   - Connection.sendTask — waits for connection before streaming.
   * </Summary>
   */
  private waitUntilConnected = async (): Promise<void> => {
    // ===== STEP 1: Calculate Deadline =====
    // Step 1a: Compute timeout deadline from now + config timeout value
    // Step 1b: This ensures we don't wait indefinitely for a connection
    const deadline = Date.now() + this.config.timeout;

    // ===== STEP 2: Loop Until Connected or Timeout =====
    // Step 2a: Start retry loop
    for (;;) {
      // ===== STEP 2b: Check if Already Connected =====
      // If rsocket exists, connection is live; return immediately
      if (this.rsocket) return;

      // ===== STEP 2c: Check if Past Deadline =====
      // If current time exceeds deadline, give up and throw timeout error
      if (Date.now() > deadline) {
        throw new Error(
          `Not connected to ${this.config.server}:${this.config.port} (timeout ${this.config.timeout}ms)`,
        );
      }

      // ===== STEP 2d: Attempt to Connect =====
      // Try to establish connection; if it succeeds and rsocket is set, return
      try {
        await this.connect();
        if (this.rsocket) return;
      } catch {
        // ===== STEP 2e: Connect Failed; Sleep Before Retry =====
        // Sleep 200ms to avoid tight retry loop on repeated failures
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Opens the TCP socket and performs the RSocket handshake if not already
   *   connected, using config.server and config.port.
   *
   * How it does it (step by step):
   *   1. Returns immediately if rsocket is already set (idempotent).
   *   2. Returns the existing promise if a connect is already in flight (mutex).
   *   3. Emits "connecting" status.
   *   4. Creates TcpClientTransport pointed at config.server:config.port.
   *   5. Creates RSocketConnector with JSON MIME types, keep-alive, and file responder.
   *   6. Calls connector.connect() to perform the TCP + RSocket SETUP handshake.
   *   7. Stores the rsocket instance and resets reconnectAttempt to 0.
   *   8. Registers an onClose callback that triggers handleSocketClosed.
   *   9. Emits "connected" status.
   *   10. On failure: nulls rsocket, emits "disconnected", and rethrows.
   *   11. Clears the establishing promise in a finally block.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the connection is established.
   *
   * @throws {Error} — When TCP connection or RSocket handshake fails.
   *
   * Dependencies:
   *   - TcpClientTransport — opens the raw TCP socket.
   *   - RSocketConnector — performs the RSocket SETUP handshake.
   *   - createFileResponder — registers server-initiated file request handler.
   *
   * Dependants:
   *   - index.ts main() — calls await conn.connect() on startup.
   *   - Connection.waitUntilConnected — retries this on failure.
   *   - Connection.scheduleReconnect — calls this after backoff delay.
   *   - Connection.reload — calls this after closing the old socket.
   * </Summary>
   */
  connect = async (): Promise<void> => {
    // ===== STEP 1: Check for Existing Connection =====
    // Step 1a: If already connected, return immediately (idempotent)
    if (this.rsocket) return;

    // ===== STEP 2: Check for In-Flight Connection =====
    // Step 2a: If a connection is already being established, return that promise
    // Step 2b: This prevents multiple simultaneous connection attempts (mutex pattern)
    if (this.establishing) return this.establishing;

    // ===== STEP 3: Start Connection Process =====
    // Step 3a: Create and store the connection promise
    this.establishing = (async () => {
      // ===== STEP 4: Emit Connecting Status =====
      // Step 4a: Notify listeners that connection is in progress
      this.emitStatus("connecting");

      try {
        if (!this.fileProxy) {
          throw new Error(
            "fileProxy not set. Call setFileProxy() before connect().",
          );
        }

        // ===== STEP 5: Create TCP Transport =====
        // Step 5a: Initialize TcpClientTransport with server host and port from config
        const transport = new TcpClientTransport({
          connectionOptions: {
            host: this.config.server,
            port: this.config.port,
          },
        });

        // ===== STEP 6: Create RSocket Connector =====
        // Step 6a: Initialize RSocketConnector with transport and setup configuration
        const connector = new RSocketConnector({
          transport,
          setup: {
            dataMimeType: "application/json",
            metadataMimeType: "application/json",
            keepAlive: 30_000,
            lifetime: 120_000,
          },
          // Step 6b: Register responder for server-initiated file operations
          responder: createFileResponder(this.fileProxy),
        });

        // ===== STEP 7: Perform RSocket Handshake =====
        // Step 7a: Connect to server and complete TCP + RSocket SETUP handshake
        const rsocket = await connector.connect();

        // ===== STEP 8: Store RSocket Instance =====
        // Step 8a: Save the live connection for future use
        this.rsocket = rsocket;

        // ===== STEP 9: Reset Reconnect Counter =====
        // Step 9a: Since we're now connected, reset the exponential backoff counter
        this.reconnectAttempt = 0;

        // ===== STEP 10: Register Close Handler =====
        // Step 10a: When socket closes, trigger handleSocketClosed for cleanup and reconnect
        // Step 10b: Ignore stale onClose from a replaced socket during reload()
        rsocket.onClose(() => {
          if (this.rsocket !== rsocket) return;
          this.handleSocketClosed();
        });

        // ===== STEP 11: Emit Connected Status =====
        // Step 11a: Notify listeners that connection is established
        this.emitStatus("connected");
      } catch (err) {
        // ===== STEP 12: Handle Connection Failure =====
        // Step 12a: Clear the rsocket reference since connection failed
        this.rsocket = null;

        // Step 12b: Emit disconnected status to notify listeners
        this.emitStatus("disconnected");

        // Step 12c: Re-throw error so caller knows connection failed
        throw err;
      }
    })().finally(() => {
      // ===== STEP 13: Clear Establishing Promise =====
      // Step 13a: Always clear the establishing promise whether success or failure
      // Step 13b: This allows new connection attempts after failure
      this.establishing = null;
    });

    // ===== STEP 14: Return Connection Promise =====
    // Step 14a: Return the establishing promise to caller
    return this.establishing;
  };

  /**
   * <Summary>
   * What it does:
   *   Cancels any pending reconnect timer so a stale setTimeout does not fire.
   *
   * How it does it (step by step):
   *   1. Checks if reconnectTimer is set.
   *   2. Calls clearTimeout on it.
   *   3. Nulls the handle.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   None (uses clearTimeout).
   *
   * Dependants:
   *   - Connection.reload — clears timer before intentional close.
   * </Summary>
   */
  private clearReconnectTimer = (): void => {
    // ===== STEP 1: Check if Timer is Active =====
    // Step 1a: Test if reconnectTimer is set (null means no timer pending)
    if (this.reconnectTimer) {
      // ===== STEP 2: Cancel Timer =====
      // Step 2a: Call clearTimeout to prevent the scheduled reconnect from firing
      clearTimeout(this.reconnectTimer);

      // ===== STEP 3: Clear Handle =====
      // Step 3a: Null out the timer handle to indicate no timer is active
      this.reconnectTimer = null;
    }
  };

  /**
   * <Summary>
   * What it does:
   *   Reacts to the RSocket socket closing by resetting state and optionally
   *   scheduling an automatic reconnect.
   *
   * How it does it (step by step):
   *   1. Nulls out this.rsocket since the connection is dead.
   *   2. Emits "disconnected" status.
   *   3. If suppressReconnect is true (intentional close), returns without reconnecting.
   *   4. Otherwise calls scheduleReconnect to try again with backoff.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - Connection.emitStatus — broadcasts "disconnected".
   *   - Connection.scheduleReconnect — begins the backoff retry loop.
   *
   * Dependants:
   *   - RSocket.onClose callback — registered in connect().
   * </Summary>
   */
  private handleSocketClosed = (): void => {
    // ===== STEP 1: Clear Connection Reference =====
    // Step 1a: Null out rsocket to mark the connection as dead
    // Step 1b: Future sendCommand/sendTask calls will fail until reconnected
    this.rsocket = null;

    // ===== STEP 2: Notify Subscribers of Disconnect =====
    // Step 2a: Emit "disconnected" status to all registered listeners
    // Step 2b: Allows UI to update and show disconnection message
    this.emitStatus("disconnected");

    // ===== STEP 3: Check if Reconnect is Suppressed =====
    // Step 3a: If suppressReconnect is true (intentional close), skip reconnect
    // Step 3b: Used during reload() or shutdown to prevent auto-reconnect
    if (this.suppressReconnect) return;

    // ===== STEP 4: Schedule Reconnect Attempt =====
    // Step 4a: Start exponential backoff retry loop to restore connection
    this.scheduleReconnect();
  };

  /**
   * <Summary>
   * What it does:
   *   Schedules a reconnect attempt after an exponential backoff delay with
   *   random jitter, capped at 30 seconds.
   *
   * How it does it (step by step):
   *   1. Returns if a timer is already scheduled or reconnect is suppressed.
   *   2. Emits "reconnecting" status.
   *   3. Computes delay: min(30000, 500 * 2^attempt) + random 0–250ms jitter.
   *   4. Sets a setTimeout that calls connect().
   *   5. On connect success: resets reconnectAttempt to 0.
   *   6. On connect failure: increments reconnectAttempt and schedules again.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - Connection.connect — the actual reconnect attempt.
   *   - Connection.emitStatus — broadcasts "reconnecting".
   *
   * Dependants:
   *   - Connection.handleSocketClosed — calls this when the socket drops unexpectedly.
   * </Summary>
   */
  private scheduleReconnect = (): void => {
    // ===== STEP 1: Check if Reconnect Already Scheduled =====
    // Step 1a: If a timer is already pending, skip to avoid duplicate timers
    // Step 1b: If suppressReconnect is true, don't schedule (intentional close)
    if (this.reconnectTimer || this.suppressReconnect) return;

    // ===== STEP 2: Emit Reconnecting Status =====
    // Step 2a: Notify subscribers that we're attempting to restore connection
    this.emitStatus("reconnecting");

    // ===== STEP 3: Calculate Exponential Backoff Delay =====
    // Step 3a: Base delay = 500 * 2^reconnectAttempt (exponential growth)
    // Step 3b: Cap at 30 seconds to avoid excessively long waits
    const exp = Math.min(30_000, 500 * 2 ** this.reconnectAttempt);

    // ===== STEP 4: Add Random Jitter =====
    // Step 4a: Add 0–250ms of random jitter to prevent thundering herd
    // Step 4b: If many clients reconnect at once, jitter spreads requests
    const delay = exp + Math.floor(Math.random() * 250);

    // ===== STEP 5: Set Timeout to Reconnect =====
    // Step 5a: Schedule a reconnect attempt after the calculated delay
    this.reconnectTimer = setTimeout(() => {
      // ===== STEP 5b: Clear Timer Handle =====
      // Mark that this scheduled timeout has fired
      this.reconnectTimer = null;

      // ===== STEP 5c: Attempt to Connect =====
      // Start the connection process
      void this.connect()
        .then(() => {
          // ===== STEP 5d: Connection Succeeded =====
          // Reset attempt counter since we're now connected
          this.reconnectAttempt = 0;
        })
        .catch(() => {
          // ===== STEP 5e: Connection Failed; Retry with Backoff =====
          // Increment attempt counter for next exponential backoff
          this.reconnectAttempt++;
          // Schedule another reconnect attempt
          this.scheduleReconnect();
        });
    }, delay);
  };

  /**
   * <Summary>
   * What it does:
   *   Updates the internal config reference without reconnecting.
   *
   * How it does it (step by step):
   *   1. Replaces this.config with the new config.
   *   2. Does NOT trigger reconnection, even if server/port/password change.
   *
   * Parameters:
   *   @param {Config} config — The updated configuration object.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - modelSelectionHandlers.handleSet — updates config after user picks a new model.
   *   - Note: For connection-level changes (server, port, password), use reload() instead.
   * </Summary>
   */
  updateConfig = (config: Config): void => {
    // ===== STEP 1: Replace Config Reference =====
    // Step 1a: Store the new config in the instance
    // Step 1b: This does NOT trigger reconnection. Use reload() for connection-level changes.
    this.config = config;
  };

  /**
   * <Summary>
   * What it does:
   *   Stores a reference to the LocalFileProxy so incoming RSocket file requests
   *   from the server can be handled.
   *
   * How it does it (step by step):
   *   1. Stores the proxy reference for use in the RSocket responder callback.
   *
   * Parameters:
   *   @param {LocalFileProxy} proxy — The file proxy instance.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - index.ts main() — calls this after creating the LocalFileProxy.
   * </Summary>
   */
  setFileProxy = (proxy: LocalFileProxy): void => {
    // ===== STEP 1: Store File Proxy Reference =====
    // Step 1a: Save the proxy so the RSocket responder can access it
    // Step 1b: Used in connect() responder to handle incoming file.* operations
    this.fileProxy = proxy;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Replaces the configuration and reconnects to the server if connection
   *   settings (server, port, password) have changed.
   *
   * How it does it (step by step):
   *   1. Snapshots the current server, port, and password values.
   *   2. Replaces this.config with the new config.
   *   3. Compares the old and new connection settings.
   *   4. If unchanged, returns immediately (no reconnect needed).
   *   5. Sets suppressReconnect flag to prevent auto-reconnect on close.
   *   6. Cancels any pending reconnect timer.
   *   7. Closes the old RSocket connection.
   *   8. Clears suppressReconnect flag.
   *   9. Establishes a new connection with the updated config.
   *
   * Parameters:
   *   @param {Config} config — The new configuration object.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when reconnect completes or immediately
   *     if connection settings are unchanged.
   *
   * Dependencies:
   *   - Connection.clearReconnectTimer — cancels pending reconnect attempts.
   *   - Connection.connect — establishes the new connection.
   *
   * Dependants:
   *   - configHandlers.handleConfig — calls this after user changes server settings.
   *   - modelSelectionHandlers.handleSet — calls this after model config update.
   * </Summary>
   */
  reload = async (config: Config): Promise<void> => {
    // ===== STEP 1: Snapshot Previous Connection Settings =====
    // Step 1a: Save the current server, port, and password for comparison
    const prev = {
      server: this.config.server,
      port: this.config.port,
      password: this.config.password,
    };

    // ===== STEP 2: Install New Config =====
    // Step 2a: Replace config immediately so we have the new values
    this.config = config;

    // ===== STEP 3: Check if Connection Settings Changed =====
    // Step 3a: Compare previous and new connection-level fields
    // Step 3b: If unchanged, just update config and return (no reconnect needed)
    if (
      prev.server === config.server &&
      prev.port === config.port &&
      prev.password === config.password
    ) {
      return;
    }

    // ===== STEP 4: Suppress Auto-Reconnect During Close =====
    // Step 4a: Set flag so that when the old socket closes, it doesn't auto-reconnect
    // Step 4b: We want to reconnect to the NEW server, not the old one
    this.suppressReconnect = true;

    // ===== STEP 5: Clean Up Pending Reconnect Timer =====
    // Step 5a: Cancel any scheduled reconnect from the old connection
    this.clearReconnectTimer();

    // ===== STEP 6: Close Old Connection =====
    // Step 6a: Save reference to the old RSocket
    const old = this.rsocket;

    // Step 6b: Null out the reference immediately to mark as disconnected
    this.rsocket = null;

    // Step 6c: Close the old RSocket (if it exists)
    old?.close();

    // ===== STEP 7: Connect to New Server =====
    // Step 7a: Establish connection with the updated config
    // Step 7b: Keep suppressReconnect true until connect settles so a late
    //          old-socket onClose cannot schedule a competing reconnect
    try {
      await this.connect();
    } finally {
      this.suppressReconnect = false;
    }
  };

  /**
   * <Summary>
   * What it does:
   *   Builds the auth metadata Buffer for the current config.
   *
   * How it does it (step by step):
   *   1. Delegates to authMetadata utility with this.config.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Buffer} — UTF-8 JSON password metadata for RSocket frames.
   *
   * Dependencies:
   *   - authMetadata — serialises password from config.
   *
   * Dependants:
   *   - All Connection send methods — attach metadata to every frame.
   * </Summary>
   */
  private meta = (): Buffer => authMetadata(this.config);

  /**
   * <Summary>
   * What it does:
   *   Returns the live RSocket or throws if disconnected.
   *
   * How it does it (step by step):
   *   1. Delegates to requireSocket with this.rsocket.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {RSocket} — The live RSocket connection object.
   *
   * @throws {Error} — When the connection is not established.
   *
   * Dependencies:
   *   - requireSocket — validates non-null socket.
   *
   * Dependants:
   *   - Connection.sendCommand, sendTask, sendStream — after waitUntilConnected.
   * </Summary>
   */
  private socket = (): RSocket => requireSocket(this.rsocket);

  /**
   * @async
   * <Summary>
   * What it does:
   *   Sends a command envelope via RSocket requestResponse and returns parsed data.
   *
   * How it does it (step by step):
   *   1. Waits until the RSocket connection is live.
   *   2. Delegates to sendCommand in commands.js with socket and metadata.
   *
   * Parameters:
   *   @param {string} type — Command route e.g. "models.list", "memory.get".
   *   @param {unknown} payload — JSON-serialisable command payload.
   *
   * Returns:
   *   @returns {Promise<TResponse>} — Parsed data field from the server response.
   *
   * @throws {Error} — When the server returns ok: false or connection fails.
   *
   * Dependencies:
   *   - Connection.waitUntilConnected — ensures live socket.
   *   - sendCommand — commands.js requestResponse helper.
   *
   * Dependants:
   *   - index.ts — session.exists check on startup.
   *   - modelHandlers — models.delete, models.show, etc.
   * </Summary>
   */
  sendCommand = async <TResponse>(
    type: string,
    payload: unknown,
  ): Promise<TResponse> => {
    // ===== STEP 1: Wait for Connection =====
    // Step 1a: Block until RSocket is live, retrying with backoff if needed
    await this.waitUntilConnected();

    // ===== STEP 2: Delegate to Command Helper =====
    // Step 2a: Pass live socket, route, payload, and auth metadata to sendCommand
    return sendCommandFn(this.socket(), type, payload, this.meta());
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Fetches installed Ollama models with full metadata from the server.
   *
   * How it does it (step by step):
   *   1. Waits until connected.
   *   2. Delegates to fetchModelsDetailed in commands.js.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<InstalledModel[]>} — Array of model metadata objects.
   *
   * Dependencies:
   *   - fetchModelsDetailed — commands.js helper.
   *
   * Dependants:
   *   - modelHandlers.handleModels — list and find subcommands.
   * </Summary>
   */
  fetchModelsDetailed = async () => {
    await this.waitUntilConnected();
    return fetchModelsDetailedFn(this.socket(), this.meta());
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Fetches installed Ollama model names from the server.
   *
   * How it does it (step by step):
   *   1. Waits until connected.
   *   2. Delegates to fetchModels in commands.js.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<string[]>} — Array of model name strings.
   *
   * Dependencies:
   *   - fetchModels — commands.js helper.
   *
   * Dependants:
   *   - Connection.listModels — deprecated alias.
   * </Summary>
   */
  fetchModels = async (): Promise<string[]> => {
    await this.waitUntilConnected();
    return fetchModelsFn(this.socket(), this.meta());
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deprecated alias for fetchModels, kept for backward compatibility.
   *
   * How it does it (step by step):
   *   1. Delegates to this.fetchModels().
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<string[]>} — Array of model names.
   *
   * Dependencies:
   *   - Connection.fetchModels — the real implementation.
   *
   * Dependants:
   *   - modelSelectionHandlers.handleSet — populates the model picker.
   * </Summary>
   */
  listModels = async (): Promise<string[]> => this.fetchModels();

  /**
   * @async
   * <Summary>
   * What it does:
   *   Uploads local skill files to the server for advisor/agent use.
   *
   * How it does it (step by step):
   *   1. Waits until connected.
   *   2. Delegates to syncSkills in commands.js.
   *
   * Parameters:
   *   @param {SkillPayload[]} skills — Skill objects with name and markdown content.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - syncSkills — commands.js helper.
   *
   * Dependants:
   *   - skillHandlers.handleSkills — after reading local skill files.
   *   - SkillManager.autoSync — on startup.
   * </Summary>
   */
  syncSkills = async (skills: SkillPayload[]): Promise<void> => {
    await this.waitUntilConnected();
    await syncSkillsFn(this.socket(), this.meta(), skills);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Fetches all stored memory entries from the server's preference store.
   *
   * How it does it (step by step):
   *   1. Waits until connected.
   *   2. Delegates to getMemory in commands.js.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<MemoryEntry[]>} — Array of topics with their rules.
   *
   * Dependencies:
   *   - getMemory — commands.js helper.
   *
   * Dependants:
   *   - memoryHandlers.handleMemory — show subcommand.
   * </Summary>
   */
  getMemory = async () => {
    await this.waitUntilConnected();
    return getMemoryFn(this.socket(), this.meta());
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deletes all rules for a specific topic from server memory.
   *
   * How it does it (step by step):
   *   1. Waits until connected.
   *   2. Delegates to forgetMemory in commands.js.
   *
   * Parameters:
   *   @param {string} topic — Topic name to forget e.g. "coding-style".
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - forgetMemory — commands.js helper.
   *
   * Dependants:
   *   - memoryHandlers.handleMemory — forget subcommand.
   * </Summary>
   */
  forgetMemory = async (topic: string): Promise<void> => {
    await this.waitUntilConnected();
    await forgetMemoryFn(this.socket(), this.meta(), topic);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Wipes all memory entries from the server's preference store.
   *
   * How it does it (step by step):
   *   1. Waits until connected.
   *   2. Delegates to clearMemory in commands.js.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - clearMemory — commands.js helper.
   *
   * Dependants:
   *   - memoryHandlers.handleMemory — clear subcommand.
   * </Summary>
   */
  clearMemory = async (): Promise<void> => {
    await this.waitUntilConnected();
    await clearMemoryFn(this.socket(), this.meta());
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Streams a user task to the server and dispatches frames/tokens to callbacks.
   *
   * How it does it (step by step):
   *   1. Waits until connected.
   *   2. Delegates to sendTask in streaming.js with config and callbacks.
   *
   * Parameters:
   *   @param {Object} opts — Task options with text, maxAgents, onFrame, onToken.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the server finishes streaming.
   *
   * Dependencies:
   *   - sendTask — streaming.js helper.
   *
   * Dependants:
   *   - taskStream.runTaskStream — primary task execution entry point.
   * </Summary>
   */
  sendTask = async (opts: {
    task: string;
    maxAgents?: 1 | 2 | "max" | number;
    onFrame: (frame: TaskFrame) => void | Promise<void>;
    onToken?: (token: string) => void;
  }): Promise<void> => {
    // ===== STEP 1: Wait for Connection =====
    // Step 1a: Block until RSocket is live before starting the task stream
    await this.waitUntilConnected();

    // ===== STEP 2: Delegate to Streaming Helper =====
    // Step 2a: Pass task text, config, metadata, socket, and callbacks to sendTask
    await sendTaskFn(
      opts.task,
      this.config,
      this.meta(),
      this.socket(),
      opts.onFrame,
      opts.onToken,
      opts.maxAgents,
    );
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Streams long-running server operations (model pull, explore) to callbacks.
   *
   * How it does it (step by step):
   *   1. Waits until connected.
   *   2. Delegates to sendStream in streaming.js.
   *
   * Parameters:
   *   @param {Object} opts — Operation kind, payload, and onFrame callback.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the server finishes streaming.
   *
   * Dependencies:
   *   - sendStream — streaming.js helper.
   *
   * Dependants:
   *   - modelHandlers.handleModels — pull subcommand.
   *   - sessionHandlers.handleExplore — explore subcommand.
   * </Summary>
   */
  sendStream = async (
    opts:
      | {
          kind: "models.pull";
          payload: { name: string };
          onFrame: (frame: TaskFrame) => void | Promise<void>;
        }
      | {
          kind: "explore";
          payload?: Record<string, never>;
          onFrame: (frame: TaskFrame) => void | Promise<void>;
        },
  ): Promise<void> => {
    // ===== STEP 1: Wait for Connection =====
    // Step 1a: Block until RSocket is live before starting the operation stream
    await this.waitUntilConnected();

    // ===== STEP 2: Delegate to Streaming Helper =====
    // Step 2a: Pass operation options, metadata, and socket to sendStream
    await sendStreamFn(opts, this.meta(), this.socket());
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Responds to a pending server confirmation request (approve or reject).
   *
   * How it does it (step by step):
   *   1. Waits until connected.
   *   2. Delegates to respondConfirmation in commands.js.
   *
   * Parameters:
   *   @param {string} id — Confirmation ID from the server frame.
   *   @param {boolean} approved — True to approve, false to reject.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the server acknowledges.
   *
   * Dependencies:
   *   - respondConfirmation — commands.js helper.
   *
   * Dependants:
   *   - taskStream.runTaskStream — user approval prompts in Ink UI.
   * </Summary>
   */
  respondConfirmation = async (
    id: string,
    approved: boolean,
  ): Promise<void> => {
    await this.waitUntilConnected();
    await respondConfirmationFn(this.socket(), this.meta(), id, approved);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Responds to a pending server plan request (implement, skip, or edit).
   *
   * How it does it (step by step):
   *   1. Waits until connected.
   *   2. Delegates to respondPlan in commands.js.
   *
   * Parameters:
   *   @param {string} id — Plan ID from the server frame.
   *   @param {"implement" | "skip" | "edit"} decision — User's plan decision.
   *   @param {string[]} [steps] — Modified steps when decision is "edit".
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the server acknowledges.
   *
   * Dependencies:
   *   - respondPlan — commands.js helper.
   *
   * Dependants:
   *   - taskStream.runTaskStream — plan review prompts in Ink UI.
   * </Summary>
   */
  respondPlan = async (
    id: string,
    decision: "implement" | "skip" | "edit",
    steps?: string[],
  ): Promise<void> => {
    await this.waitUntilConnected();
    await respondPlanFn(this.socket(), this.meta(), id, decision, steps);
  };
}
