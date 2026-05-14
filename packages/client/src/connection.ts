/**
 * =============================================================================
 * Part 6 wire contract (RSocket over TCP) — client side
 * =============================================================================
 *
 * SETUP frame (RSocketConnector `setup`):
 *   - dataMimeType:     application/json
 *   - metadataMimeType: application/json
 *
 * Per-frame `metadata` (UTF-8 JSON, same on every requestStream / requestResponse):
 *   { "password": "<string from config>" }
 *   Empty string is valid; server may run in dev mode (accept any password).
 *
 * `data` payloads use JSON encoded as UTF-8 Buffer unless noted.
 *
 * --- requestStream (task execution) ---
 * Single initial payload `data`:
 *   {
 *     "kind": "task",
 *     "text": "<user task string>",
 *     "advisorModel": "<string>",
 *     "agentModel": "<string>",
 *     "advisorTemp": <number>,
 *     "agentTemp": <number>
 *   }
 * Server streams response chunks: each PAYLOAD `data` is UTF-8 text (token
 * or fragment) for incremental display. Terminal frame has COMPLETE flag.
 *
 * --- requestResponse (commands) ---
 * Request `data`:
 *   { "kind": "command", "type": "<commandType>", "payload": <any JSON> }
 *
 * Response `data` (JSON):
 *   { "ok": true, "data": <result> }  on success
 *   { "ok": false, "error": "<message>" } on application error
 *
 * Command types (type field) and expected payload / data result:
 *   - "models.list"     payload {}           -> data: { "models": string[] }
 *   - "skills.sync"     payload { skills } -> data: optional {} or summary
 *   - "memory.get"      payload {}           -> data: { "entries": MemoryEntry[] }
 *   - "memory.forget"   payload { topic }    -> data: optional
 *   - "memory.clear"    payload {}           -> data: optional
 *
 * =============================================================================
 */

import { RSocketConnector, type Payload, type RSocket } from "@rsocket/core";
import { TcpClientTransport } from "@rsocket/tcp-client";
import type { Config } from "./config.js";

/**
 * <Summary>
 * What it does:
 *   Represents one topic in the user's server-side preference store.
 *
 * Used by:
 *   - Connection.getMemory — returned in the array of memory entries.
 *   - renderer.printMemory — displays each entry to the user.
 *
 * Produced by:
 *   - Server /memory endpoint — fetched via requestResponse.
 * </Summary>
 */
export interface MemoryEntry {
  /** Topic name e.g. "coding-style" or "project-structure". */
  topic: string;

  /** Array of preference rules the server learned for this topic. */
  rules: string[];
}

/**
 * <Summary>
 * What it does:
 *   Represents one skill file to be synced to the server.
 *
 * Used by:
 *   - Connection.syncSkills — accepts an array of these in the request body.
 *   - skills.readAllSkills — produces an array of these from local .md files.
 *
 * Produced by:
 *   - skills.readAllSkills — reads ~/.agent-cli/skills/*.md into this shape.
 * </Summary>
 */
export interface SkillPayload {
  /** Skill file basename without extension e.g. "coding". */
  name: string;

  /** Full markdown content of the skill file. */
  content: string;
}

/**
 * <Summary>
 * What it does:
 *   Describes the four possible states of the RSocket TCP connection.
 *
 * Used by:
 *   - Connection — tracks its internal state and emits to listeners.
 *   - renderer.printConnectionStatus — maps each state to a display label.
 *   - index.ts — subscribes to print status changes in the CLI.
 *
 * Produced by:
 *   - Connection.emitStatus — sets the current value.
 * </Summary>
 */
export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

/**
 * <Summary>
 * What it does:
 *   Describes the JSON envelope the server sends back for requestResponse commands.
 *
 * Used by:
 *   - Connection.sendCommand — parses the server response into this shape.
 *
 * Produced by:
 *   - Part 6 server — every command response uses this envelope.
 * </Summary>
 */
type CommandResponseEnvelope = {
  /** Whether the command succeeded. */
  ok: boolean;

  /** Result payload on success, shape depends on command type. */
  data?: unknown;

  /** Human-readable error message on failure. */
  error?: string;
};

/**
 * <Summary>
 * What it does:
 *   Describes the JSON body sent as requestStream data for task execution.
 *
 * Used by:
 *   - Connection.sendTask — builds this object and serialises it to Buffer.
 *
 * Produced by:
 *   - Connection.sendTask — constructed from user input and config settings.
 * </Summary>
 */
type TaskStreamPayload = {
  /** Discriminator so the server knows this is a task, not a command. */
  kind: "task";

  /** The user's task description. */
  text: string;

  /** Ollama model name for the advisor role e.g. "gemma3:27b". */
  advisorModel: string;

  /** Ollama model name for the agent role e.g. "gemma3:4b". */
  agentModel: string;

  /** Sampling temperature for advisor (0.0–1.0). */
  advisorTemp: number;

  /** Sampling temperature for agent (0.0–1.0). */
  agentTemp: number;
};

/**
 * <Summary>
 * What it does:
 *   Describes the JSON body sent as requestResponse data for non-task commands.
 *
 * Used by:
 *   - Connection.sendCommand — builds this envelope before sending.
 *
 * Produced by:
 *   - Connection.sendCommand — constructed from the type string and caller payload.
 * </Summary>
 */
type CommandRequestPayload = {
  /** Discriminator so the server knows this is a command, not a task. */
  kind: "command";

  /** Route string e.g. "models.list", "memory.get", "skills.sync". */
  type: string;

  /** Arbitrary JSON payload specific to the command type. */
  payload: unknown;
};

/**
 * Callback signature for connection status change notifications.
 */
type StatusListener = (status: ConnectionStatus) => void;

/**
 * Number of stream items requested at a time for backpressure control.
 * When half the budget is consumed, another STREAM_WINDOW is requested.
 */
const STREAM_WINDOW = 64;

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
 *   - Config — provides server address, port, password, and model settings.
 *
 * Dependants:
 *   - index.ts main() — creates a Connection instance on startup.
 *   - CommandHandler — calls listModels, syncSkills, getMemory, forgetMemory, clearMemory.
 *   - index.ts rl.on('line') — calls sendTask for plain text input.
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

  /**
   * @param {Config} config — Initial configuration with server address, port,
   *   password, model names, and timeout settings.
   */
  constructor(config: Config) {
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
   * </Summary>
   */
  onConnectionStatus = (cb: StatusListener): (() => void) => {
    this.statusListeners.add(cb);
    cb(this.status);
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
    if (this.status === next) return;
    this.status = next;
    for (const fn of this.statusListeners) {
      fn(next);
    }
  };

  /**
   * <Summary>
   * What it does:
   *   Builds the metadata Buffer containing the password, attached to every
   *   RSocket frame so the server can authenticate each request.
   *
   * How it does it (step by step):
   *   1. Reads password from this.config (defaults to empty string).
   *   2. Wraps it in a JSON object { password: "..." }.
   *   3. Serialises to a UTF-8 Buffer.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Buffer} — UTF-8 JSON Buffer e.g. {"password":"..."}.
   *
   * Dependencies:
   *   None (uses Buffer.from).
   *
   * Dependants:
   *   - Connection.sendCommand — attaches this as metadata on requestResponse.
   *   - Connection.sendTask — attaches this as metadata on requestStream.
   * </Summary>
   */
  private authMetadata = (): Buffer => {
    return Buffer.from(
      JSON.stringify({ password: this.config.password ?? "" }),
      "utf-8",
    );
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the live RSocket instance or throws if not connected.
   *
   * How it does it (step by step):
   *   1. Checks if this.rsocket is null.
   *   2. Throws an Error if null.
   *   3. Returns the RSocket instance if not null.
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
   *   None.
   *
   * Dependants:
   *   - Connection.sendCommand — calls after waitUntilConnected.
   *   - Connection.sendTask — calls after waitUntilConnected.
   * </Summary>
   */
  private requireSocket = (): RSocket => {
    if (!this.rsocket) {
      throw new Error("RSocket is not connected");
    }
    return this.rsocket;
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
    const deadline = Date.now() + this.config.timeout;
    for (;;) {
      if (this.rsocket) return;
      if (Date.now() > deadline) {
        throw new Error(
          `Not connected to ${this.config.server}:${this.config.port} (timeout ${this.config.timeout}ms)`,
        );
      }
      try {
        await this.connect();
        if (this.rsocket) return;
      } catch {
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
   *   5. Creates RSocketConnector with JSON MIME types and keep-alive settings.
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
   *   - Connection.emitStatus — broadcasts state changes.
   *   - Connection.handleSocketClosed — registered as onClose callback.
   *
   * Dependants:
   *   - index.ts main() — calls await conn.connect() on startup.
   *   - Connection.waitUntilConnected — retries this on failure.
   *   - Connection.scheduleReconnect — calls this after backoff delay.
   *   - Connection.reload — calls this after closing the old socket.
   * </Summary>
   */
  connect = async (): Promise<void> => {
    if (this.rsocket) return;
    if (this.establishing) return this.establishing;

    this.establishing = (async () => {
      this.emitStatus("connecting");
      try {
        const transport = new TcpClientTransport({
          connectionOptions: {
            host: this.config.server,
            port: this.config.port,
          },
        });
        const connector = new RSocketConnector({
          transport,
          setup: {
            dataMimeType: "application/json",
            metadataMimeType: "application/json",
            keepAlive: 30_000,
            lifetime: 120_000,
          },
        });
        const rsocket = await connector.connect();
        this.rsocket = rsocket;
        this.reconnectAttempt = 0;
        rsocket.onClose(() => {
          this.handleSocketClosed();
        });
        this.emitStatus("connected");
      } catch (err) {
        this.rsocket = null;
        this.emitStatus("disconnected");
        throw err;
      }
    })().finally(() => {
      this.establishing = null;
    });

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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
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
    this.rsocket = null;
    this.emitStatus("disconnected");
    if (this.suppressReconnect) return;
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
    if (this.reconnectTimer || this.suppressReconnect) return;
    this.emitStatus("reconnecting");
    const exp = Math.min(30_000, 500 * 2 ** this.reconnectAttempt);
    const delay = exp + Math.floor(Math.random() * 250);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect()
        .then(() => {
          this.reconnectAttempt = 0;
        })
        .catch(() => {
          this.reconnectAttempt++;
          this.scheduleReconnect();
        });
    }, delay);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Updates the internal config reference and reconnects only when server
   *   address, port, or password have changed.
   *
   * How it does it (step by step):
   *   1. Snapshots the previous server, port, and password.
   *   2. Replaces this.config with the new config.
   *   3. Compares previous vs new connection-level fields.
   *   4. If unchanged, returns immediately (no reconnect needed).
   *   5. Sets suppressReconnect to true so closing the old socket does not
   *      trigger auto-reconnect to the old server.
   *   6. Clears any pending reconnect timer.
   *   7. Nulls this.rsocket and closes the old socket.
   *   8. Resets suppressReconnect to false.
   *   9. Calls connect() to establish a new session to the updated address.
   *
   * Parameters:
   *   @param {Config} config — The updated configuration object.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when reconnect completes (or immediately
   *     if no connection-level fields changed).
   *
   * Dependencies:
   *   - Connection.clearReconnectTimer — prevents stale reconnect timers.
   *   - Connection.connect — opens the new session.
   *
   * Dependants:
   *   - CommandHandler.handleSet — reloads config after user picks a new model.
   * </Summary>
   */
  reload = async (config: Config): Promise<void> => {
    const prev = {
      server: this.config.server,
      port: this.config.port,
      password: this.config.password,
    };
    this.config = config;
    if (
      prev.server === config.server &&
      prev.port === config.port &&
      prev.password === config.password
    ) {
      return;
    }
    this.suppressReconnect = true;
    this.clearReconnectTimer();
    const old = this.rsocket;
    this.rsocket = null;
    old?.close();
    this.suppressReconnect = false;
    await this.connect();
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Sends a command envelope via RSocket requestResponse and returns the
   *   parsed response data, throwing on application-level errors.
   *
   * How it does it (step by step):
   *   1. Waits until the RSocket connection is live.
   *   2. Builds a CommandRequestPayload with kind "command", the type string,
   *      and the caller's payload.
   *   3. Serialises it to a UTF-8 JSON Buffer.
   *   4. Sends via requestResponseBuffer with password metadata attached.
   *   5. Parses the response Buffer as JSON into a CommandResponseEnvelope.
   *   6. If env.ok is false, throws an Error with env.error message.
   *   7. Returns env.data cast to the caller's expected response type.
   *
   * Parameters:
   *   @param {string} type — Command route string e.g. "models.list", "memory.get".
   *   @param {unknown} payload — JSON-serialisable payload specific to the command.
   *
   * Returns:
   *   @returns {Promise<TResponse>} — The parsed data field from the server response.
   *
   * @throws {Error} — When the server returns ok: false or the connection fails.
   *
   * Dependencies:
   *   - Connection.waitUntilConnected — ensures live socket.
   *   - Connection.requireSocket — returns the RSocket or throws.
   *   - Connection.authMetadata — builds the per-frame password metadata.
   *   - Connection.requestResponseBuffer — wraps requestResponse as a Promise.
   *
   * Dependants:
   *   - Connection.fetchModels — sends "models.list".
   *   - Connection.syncSkills — sends "skills.sync".
   *   - Connection.getMemory — sends "memory.get".
   *   - Connection.forgetMemory — sends "memory.forget".
   *   - Connection.clearMemory — sends "memory.clear".
   * </Summary>
   */
  sendCommand = async <TResponse>(
    type: string,
    payload: unknown,
  ): Promise<TResponse> => {
    await this.waitUntilConnected();
    const rsocket = this.requireSocket();
    const body: CommandRequestPayload = { kind: "command", type, payload };
    const dataBuf = Buffer.from(JSON.stringify(body), "utf-8");
    const responseBuf = await this.requestResponseBuffer(rsocket, {
      data: dataBuf,
      metadata: this.authMetadata(),
    });
    const text = responseBuf.toString("utf-8");
    const env = JSON.parse(text) as CommandResponseEnvelope;
    if (!env.ok) {
      throw new Error(env.error ?? "Command failed");
    }
    return env.data as TResponse;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Fetches the list of available Ollama models from the server so users
   *   can pick one for advisor or agent roles.
   *
   * How it does it (step by step):
   *   1. Sends a "models.list" command via sendCommand with empty payload.
   *   2. Validates that the response contains a models array.
   *   3. Returns the array of model name strings.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<string[]>} — Array of model names e.g. ["gemma3:4b", "gemma3:27b"].
   *
   * @throws {Error} — When the server returns an invalid response shape.
   *
   * Dependencies:
   *   - Connection.sendCommand — sends the requestResponse.
   *
   * Dependants:
   *   - Connection.listModels — deprecated alias that delegates here.
   *   - CommandHandler.handleSet — calls this to populate the model picker.
   * </Summary>
   */
  fetchModels = async (): Promise<string[]> => {
    const data = await this.sendCommand<{ models: string[] }>(
      "models.list",
      {},
    );
    if (!Array.isArray(data.models)) {
      throw new Error("Invalid models.list response");
    }
    return data.models;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deprecated alias for fetchModels, kept so CommandHandler does not need
   *   a rename.
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
   *   - CommandHandler.handleSet — calls this by the old name.
   * </Summary>
   */
  listModels = async (): Promise<string[]> => this.fetchModels();

  /**
   * @async
   * <Summary>
   * What it does:
   *   Streams a task to the server via RSocket requestStream and invokes a
   *   callback for each token received, creating the ChatGPT-style streaming
   *   effect in the CLI.
   *
   * How it does it (step by step):
   *   1. Waits until the RSocket connection is live.
   *   2. Builds a TaskStreamPayload with the task text, model names, and temps.
   *   3. Serialises it to a UTF-8 JSON Buffer with password metadata.
   *   4. Calls rsocket.requestStream with an initial budget of STREAM_WINDOW (64).
   *   5. On each onNext: decodes the payload data as UTF-8, calls onToken with it.
   *   6. Tracks pendingBudget; when below half, requests another STREAM_WINDOW
   *      from the server (backpressure).
   *   7. When isComplete is true or onComplete fires, resolves the Promise.
   *   8. On onError, rejects the Promise.
   *
   * Parameters:
   *   @param {string} task — The user's task description to execute.
   *   @param {(token: string) => void} onToken — Callback invoked with each
   *     streamed token string for incremental display.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when the server finishes streaming.
   *
   * @throws {Error} — When the server returns an error frame or connection fails.
   *
   * Dependencies:
   *   - Connection.waitUntilConnected — ensures live socket.
   *   - Connection.requireSocket — returns the RSocket or throws.
   *   - Connection.authMetadata — builds the per-frame password metadata.
   *
   * Dependants:
   *   - index.ts rl.on('line') — calls this for plain text task input.
   * </Summary>
   */
  sendTask = async (
    task: string,
    onToken: (token: string) => void,
  ): Promise<void> => {
    await this.waitUntilConnected();
    const rsocket = this.requireSocket();
    const taskBody: TaskStreamPayload = {
      kind: "task",
      text: task,
      advisorModel: this.config.advisorModel,
      agentModel: this.config.agentModel,
      advisorTemp: this.config.advisorTemp,
      agentTemp: this.config.agentTemp,
    };
    const dataBuf = Buffer.from(JSON.stringify(taskBody), "utf-8");
    const payload: Payload = {
      data: dataBuf,
      metadata: this.authMetadata(),
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let pendingBudget = STREAM_WINDOW;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      const requester = rsocket.requestStream(payload, STREAM_WINDOW, {
        onError: (e: Error) => finish(e),
        onNext: (p: Payload, isComplete: boolean) => {
          const chunk = p.data?.toString("utf-8") ?? "";
          if (chunk.length > 0) onToken(chunk);
          pendingBudget--;
          if (pendingBudget < STREAM_WINDOW / 2) {
            requester.request(STREAM_WINDOW);
            pendingBudget += STREAM_WINDOW;
          }
          if (isComplete) finish();
        },
        onComplete: () => finish(),
        onExtension: () => {},
      });
    });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Uploads all local skill files to the server so they are available to
   *   the advisor and agent during task execution.
   *
   * How it does it (step by step):
   *   1. Sends a "skills.sync" command via sendCommand with the skills array.
   *
   * Parameters:
   *   @param {SkillPayload[]} skills — Array of skill objects with name and content.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - Connection.sendCommand — sends the requestResponse.
   *
   * Dependants:
   *   - CommandHandler.handleSkills (sync subcommand) — calls this after reading local files.
   * </Summary>
   */
  syncSkills = async (skills: SkillPayload[]): Promise<void> => {
    await this.sendCommand("skills.sync", { skills });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Fetches all stored memory entries from the server's preference store
   *   so users can review what the system has learned about their preferences.
   *
   * How it does it (step by step):
   *   1. Sends a "memory.get" command via sendCommand with empty payload.
   *   2. Extracts the entries array from the response (defaults to empty).
   *   3. Returns the array of MemoryEntry objects.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<MemoryEntry[]>} — Array of topics with their rules.
   *
   * Dependencies:
   *   - Connection.sendCommand — sends the requestResponse.
   *
   * Dependants:
   *   - CommandHandler.handleMemory (show subcommand) — calls this to display memory.
   * </Summary>
   */
  getMemory = async (): Promise<MemoryEntry[]> => {
    const data = await this.sendCommand<{ entries: MemoryEntry[] }>(
      "memory.get",
      {},
    );
    return data.entries ?? [];
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deletes all rules for a specific topic from the server's memory store.
   *
   * How it does it (step by step):
   *   1. Sends a "memory.forget" command via sendCommand with the topic name.
   *
   * Parameters:
   *   @param {string} topic — Topic name to forget e.g. "coding-style".
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - Connection.sendCommand — sends the requestResponse.
   *
   * Dependants:
   *   - CommandHandler.handleMemory (forget subcommand) — calls this after user confirms.
   * </Summary>
   */
  forgetMemory = async (topic: string): Promise<void> => {
    await this.sendCommand("memory.forget", { topic });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Wipes all memory entries from the server's preference store for this user.
   *
   * How it does it (step by step):
   *   1. Sends a "memory.clear" command via sendCommand with empty payload.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - Connection.sendCommand — sends the requestResponse.
   *
   * Dependants:
   *   - CommandHandler.handleMemory (clear subcommand) — calls this after user confirms.
   * </Summary>
   */
  clearMemory = async (): Promise<void> => {
    await this.sendCommand("memory.clear", {});
  };

  /**
   * <Summary>
   * What it does:
   *   Wraps RSocket's callback-based requestResponse into a Promise that
   *   resolves with the raw response Buffer.
   *
   * How it does it (step by step):
   *   1. Creates a Promise and a settled guard to prevent double resolution.
   *   2. Calls rsocket.requestResponse with the given payload.
   *   3. In onNext: stores response.data in a local buffer variable.
   *   4. When isComplete fires (via onNext or onComplete): if buffer has bytes,
   *      resolves with it; otherwise rejects with "Empty response".
   *   5. In onError: rejects the Promise with the error.
   *
   * Parameters:
   *   @param {RSocket} rsocket — The live RSocket connection instance.
   *   @param {Payload} payload — The request payload with data and metadata.
   *
   * Returns:
   *   @returns {Promise<Buffer>} — The raw response bytes from the server.
   *
   * @throws {Error} — When the server returns an error frame or an empty response.
   *
   * Dependencies:
   *   - RSocket.requestResponse — the underlying RSocket API.
   *
   * Dependants:
   *   - Connection.sendCommand — uses this to get raw bytes before JSON parsing.
   * </Summary>
   */
  private requestResponseBuffer = (
    rsocket: RSocket,
    payload: Payload,
  ): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
      let buf: Buffer | undefined;
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
          return;
        }
        if (buf && buf.length > 0) {
          resolve(buf);
        } else {
          reject(new Error("Empty response from server"));
        }
      };

      rsocket.requestResponse(payload, {
        onNext: (response: Payload, isComplete: boolean) => {
          if (response.data && response.data.length > 0) {
            buf = response.data;
          }
          if (isComplete) done();
        },
        onComplete: () => done(),
        onError: (e: Error) => done(e),
        onExtension: () => {},
      });
    });
  };
}
