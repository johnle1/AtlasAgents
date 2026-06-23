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
import { CONNECT_RETRY_INTERVAL_MS } from "./constants.js";
import { ConnectionLifecycle } from "./lifecycle.js";

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
 * </Summary>
 */
export class Connection {
  /** Current client configuration (server, port, models, password, etc.). */
  private config: Config;

  /** Live RSocket instance after successful connect, null when disconnected. */
  private rsocket: RSocket | null = null;

  /** In-flight connect promise used as a mutex to prevent duplicate connections. */
  private establishing: Promise<void> | null = null;

  private readonly lifecycle: ConnectionLifecycle;

  /** Local file proxy used by the RSocket responder for server-initiated file ops. */
  private fileProxy: LocalFileProxy | null = null;

  constructor(config: Config) {
    this.config = config;
    this.lifecycle = new ConnectionLifecycle({
      connect: async () => {
        await this.connect();
      },
      clearSocket: () => {
        this.rsocket = null;
      },
    });
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
   *   @param statusListenerCallback - Callback invoked with the new status string.
   *
   * Returns:
   *   @returns Call this to unsubscribe.
   *
   *   None.
   * </Summary>
   */
  onConnectionStatus = (statusListenerCallback: StatusListener): (() => void) =>
    this.lifecycle.onConnectionStatus(statusListenerCallback);

  private emitStatus = (nextStatus: ConnectionStatus): void => {
    // ===== STEP 1: Delegate to Lifecycle Manager =====
    // Step 1a: Pass the new status to the lifecycle manager for emission
    // Step 1b: The lifecycle manager handles notifying all registered listeners
    this.lifecycle.emitStatus(nextStatus);
  };

  private handleSocketClosed = (): void => {
    this.lifecycle.handleSocketClosed();
  };

  /** @internal Used by connection tests for reload reconnect suppression. */
  get suppressReconnect(): boolean {
    return this.lifecycle.isReconnectSuppressed();
  }

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
   *   @returns Resolves when connected.
   *
   * @throws {Error} — When the timeout elapses without a successful connection.
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
        await new Promise((resolve) =>
          setTimeout(resolve, CONNECT_RETRY_INTERVAL_MS),
        );
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
   *   @returns Resolves when the connection is established.
   *
   * @throws {Error} — When TCP connection or RSocket handshake fails.
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
        this.lifecycle.resetReconnectAttempt();

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
   *   None (uses clearTimeout).
   * </Summary>
   */
  private clearReconnectTimer = (): void => {
    this.lifecycle.cancelReconnect();
  };

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
   *   @param proxy - The file proxy instance.
   *
   * Returns:
   *   void — called for side effects only.
   *
   *   None.
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
   *   @param config - The new configuration object.
   *
   * Returns:
   *   @returns Resolves when reconnect completes or immediately
   *     if connection settings are unchanged.
   * </Summary>
   */
  reload = async (config: Config): Promise<void> => {
    // ===== STEP 1: Snapshot Previous Connection Settings =====
    // Step 1a: Save the current server, port, and password for comparison
    // Step 1b: This allows us to detect if connection-level settings actually changed
    const previousConnectionSettings = {
      server: this.config.server,
      port: this.config.port,
      password: this.config.password,
    };

    // ===== STEP 2: Install New Config =====
    // Step 2a: Replace config immediately so we have the new values
    // Step 2b: This ensures all methods use the updated configuration going forward
    this.config = config;

    // ===== STEP 3: Check if Connection Settings Changed =====
    // Step 3a: Compare previous and new connection-level fields
    // Step 3b: If unchanged, just update config and return (no reconnect needed)
    // Step 3c: This avoids unnecessary disconnection when only non-connection settings changed
    if (
      previousConnectionSettings.server === config.server &&
      previousConnectionSettings.port === config.port &&
      previousConnectionSettings.password === config.password
    ) {
      return;
    }

    // ===== STEP 4: Suppress Auto-Reconnect During Close =====
    // Step 4a: Set flag so that when the old socket closes, it doesn't auto-reconnect
    // Step 4b: We want to reconnect to the NEW server, not the old one
    // Step 4c: This prevents a race condition where the old socket triggers reconnect to old server
    this.lifecycle.setSuppressReconnect(true);

    // ===== STEP 5: Cancel Pending Reconnect Timer =====
    // Step 5a: Clear any existing reconnect timer
    // Step 5b: This prevents a delayed reconnect attempt from firing after we close the socket
    this.clearReconnectTimer();

    // ===== STEP 6: Close Old Connection =====
    // Step 6a: Save reference to the old RSocket before closing
    // Step 6b: This allows us to close it after nulling the reference
    const oldRSocket = this.rsocket;

    // Step 6c: Null out the reference immediately to mark as disconnected
    // Step 6d: This prevents any new operations from trying to use the closing socket
    this.rsocket = null;

    // Step 6e: Close the old RSocket (if it exists)
    // Step 6f: This gracefully terminates the TCP connection
    oldRSocket?.close();

    // ===== STEP 7: Connect to New Server =====
    // Step 7a: Establish connection with the updated config
    // Step 7b: Keep suppressReconnect true until connect settles so a late
    //          old-socket onClose cannot schedule a competing reconnect
    try {
      // Reset reconnect counter for fresh backoff sequence on new server
      this.lifecycle.resetReconnectAttempt();
      await this.connect();
    } finally {
      // Step 7c: Clear the suppress flag once connection attempt completes
      // Step 7d: This allows normal auto-reconnect behavior for future disconnections
      this.lifecycle.setSuppressReconnect(false);
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
   *   @returns UTF-8 JSON password metadata for RSocket frames.
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
   *   @returns The live RSocket connection object.
   *
   * @throws {Error} — When the connection is not established.
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
   *   @param type - Command route e.g. "models.list", "memory.get".
   *   @param payload - JSON-serialisable command payload.
   *
   * Returns:
   *   @returns Parsed data field from the server response.
   *
   * @throws {Error} — When the server returns ok: false or connection fails.
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
   *   @returns Array of model metadata objects.
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
   *   @returns Array of model name strings.
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
   *   @returns Array of model names.
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
   *   @param skills - Skill objects with name and markdown content.
   *
   * Returns:
   *   void — called for side effects only.
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
   *   @returns Array of topics with their rules.
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
   *   @param topic - Topic name to forget e.g. "coding-style".
   *
   * Returns:
   *   void — called for side effects only.
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
   *   @param opts - Task options with text, maxAgents, onFrame, onToken.
   *
   * Returns:
   *   @returns Resolves when the server finishes streaming.
   * </Summary>
   */
  sendTask = async (taskOptions: {
    task: string;
    maxAgents?: 1 | 2 | "max" | number;
    onFrame: (frame: TaskFrame) => void | Promise<void>;
    onToken?: (token: string) => void;
  }): Promise<void> => {
    // ===== STEP 1: Wait for Connection =====
    // Step 1a: Block until RSocket is live before starting the task stream
    // Step 1b: This ensures we have a valid connection before sending the task
    await this.waitUntilConnected();

    // ===== STEP 2: Delegate to Streaming Helper =====
    // Step 2a: Pass task text, config, metadata, socket, and callbacks to sendTask
    // Step 2b: The streaming helper manages the requestStream protocol and frame handling
    await sendTaskFn(
      taskOptions.task,
      this.config,
      this.meta(),
      this.socket(),
      taskOptions.onFrame,
      taskOptions.onToken,
      taskOptions.maxAgents,
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
   *   @param opts - Operation kind, payload, and onFrame callback.
   *
   * Returns:
   *   @returns Resolves when the server finishes streaming.
   * </Summary>
   */
  sendStream = async (
    streamOptions:
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
    // Step 1b: This ensures we have a valid connection before starting the streaming operation
    await this.waitUntilConnected();

    // ===== STEP 2: Delegate to Streaming Helper =====
    // Step 2a: Pass operation options, metadata, and socket to sendStream
    // Step 2b: The streaming helper manages the requestStream protocol for long-running operations
    await sendStreamFn(streamOptions, this.meta(), this.socket());
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
   *   @param id - Plan ID from the server frame.
   *   @param decision - User's plan decision.
   *   @param {string[]} [steps] — Modified steps when decision is "edit".
   *
   * Returns:
   *   @returns Resolves when the server acknowledges.
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
