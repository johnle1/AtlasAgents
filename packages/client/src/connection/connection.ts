/**
 * Client facade for the single persistent RSocket TCP session to the server.
 *
 * @remarks
 * All interactive CLI ↔ server traffic (commands, task streams, plan replies)
 * goes through {@link Connection}. Supporting modules handle envelopes
 * (`commands.ts`), streams (`streaming.ts`), reconnect policy (`lifecycle.ts`),
 * and the inbound file responder (`fileResponder.ts`).
 */

import { RSocketConnector, type RSocket } from "@rsocket/core";
import type { RouteId, TaskApprovalMode } from "@loopycode/shared";
import type { Config } from "../config/index.js";
import { createTlsClientTransport } from "./tls/tlsClientTransport.js";
import { checkAndPinFingerprint } from "./tls/fingerprintStore.js";
import type { TaskFrame } from "../types/frames.js";
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
  type StreamHandle,
} from "./streaming.js";
import type {
  ConnectionStatus,
  SkillPayload,
  StatusListener,
} from "./types.js";
import { authMetadata, requireSocket } from "./utils.js";
import {
  CONNECT_RETRY_INTERVAL_MS,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_TIMEOUT_MS,
} from "./constants.js";
import { ConnectionLifecycle } from "./lifecycle.js";

export type { PullProgress, TaskFrame } from "../types/frames.js";

/**
 * Manages one persistent RSocket TCP connection to the LoopyCode server.
 *
 * @remarks
 * Responsibilities:
 * - TCP + RSocket handshake with JSON MIME types and a file-proxy responder
 * - Status listeners + automatic reconnect (via {@link ConnectionLifecycle})
 * - Periodic `session.exists` health probes that close a half-dead socket
 * - Session {@link AbortSignal} aborted on disconnect so UI/work can cancel
 * - Thin wrappers that `waitUntilConnected` then delegate to command/stream helpers
 *
 * **Ordering:** call {@link setFileProxy} before {@link connect} — the handshake
 * embeds the responder and refuses to start without a proxy.
 *
 * Reconnect uses exponential backoff with jitter (see `constants.ts`) unless
 * suppressed during {@link reload} so an intentional close does not race a
 * reconnect against changing host/port/password.
 *
 * @example
 * ```ts
 * const connection = new Connection(config);
 * connection.setFileProxy(fileProxy);
 * await connection.connect();
 *
 * const models = await connection.fetchModels();
 * const { done } = await connection.sendTask({
 *   task: "Explain this code",
 *   maxSubagents: 2,
 *   onFrame: (frame) => console.log(frame.kind),
 *   onToken: (token) => process.stdout.write(token),
 * });
 * await done;
 * ```
 */
export class Connection {
  /** Live client config (host, port, password, models, timeout, …). */
  private config: Config;

  /** Connected RSocket instance, or `null` when disconnected. */
  private rsocket: RSocket | null = null;

  /**
   * In-flight `connect()` promise acting as a mutex.
   * Concurrent callers share one handshake instead of opening duplicate sockets.
   */
  private establishing: Promise<void> | null = null;

  /** Status machine + reconnect scheduler for this connection. */
  private readonly lifecycle: ConnectionLifecycle;

  /**
   * Proxy handling server → client file routes.
   * Required before connect; see {@link setFileProxy}.
   */
  private fileProxy: LocalFileProxy | null = null;

  /** Interval timer for health probes; cleared on disconnect. */
  private healthCheckTimerHandle: ReturnType<typeof setInterval> | null = null;

  /** Guards against overlapping `session.exists` probes. */
  private healthCheckInFlight = false;

  /**
   * Aborted when the session ends so in-flight client work can stop promptly.
   * Replaced on each successful connect via {@link beginSession}.
   */
  private sessionAbortController: AbortController | null = null;

  /**
   * Creates a disconnected connection bound to `config`.
   *
   * @remarks
   * Does not open a socket. Injects lifecycle deps that call back into
   * {@link connect} and clear `this.rsocket` on close.
   *
   * @param config - Initial server address, auth, models, and timeout.
   */
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
   * Registers a connection-status listener and returns an unsubscribe function.
   *
   * @remarks
   * The callback runs immediately with the current status, then on every
   * distinct transition (`Disconnected` / `Connecting` / `Connected` /
   * `Reconnecting`).
   *
   * @param statusListenerCallback - Invoked with the latest {@link ConnectionStatus}.
   * @returns Unsubscribe function (safe to call more than once).
   *
   * @example
   * ```ts
   * const unsubscribe = connection.onConnectionStatus((status) => {
   *   console.log("Status:", status);
   * });
   * unsubscribe();
   * ```
   */
  onConnectionStatus = (statusListenerCallback: StatusListener): (() => void) =>
    this.lifecycle.onConnectionStatus(statusListenerCallback);

  private emitStatus = (nextStatus: ConnectionStatus): void => {
    this.lifecycle.emitStatus(nextStatus);
  };

  /**
   * Shared close path: stop probes, abort session work, then lifecycle teardown.
   */
  private handleSocketClosed = (): void => {
    this.stopHealthMonitor();
    this.endSession();
    this.lifecycle.handleSocketClosed();
  };

  /** Starts a fresh AbortController for the newly connected session. */
  private beginSession = (): void => {
    // Abort any leftover controller first so listeners never see two live sessions.
    this.endSession();
    this.sessionAbortController = new AbortController();
  };

  /** Aborts and drops the current session controller, if any. */
  private endSession = (): void => {
    if (this.sessionAbortController) {
      this.sessionAbortController.abort();
      this.sessionAbortController = null;
    }
  };

  /**
   * Abort signal for the current RSocket session, if one is active.
   *
   * @remarks
   * Abort fires when the session ends from disconnect, intentional reload, or
   * network loss. Subscribe so long-running UI/work can cancel instead of
   * hanging on a dead socket.
   *
   * @returns Session `AbortSignal`, or `undefined` when disconnected.
   *
   * @example
   * ```ts
   * const signal = connection.getSessionAbortSignal();
   * signal?.addEventListener("abort", () => cancelLocalWork());
   * ```
   */
  getSessionAbortSignal = (): AbortSignal | undefined =>
    this.sessionAbortController?.signal;

  private stopHealthMonitor = (): void => {
    if (this.healthCheckTimerHandle) {
      clearInterval(this.healthCheckTimerHandle);
      this.healthCheckTimerHandle = null;
    }
  };

  private startHealthMonitor = (): void => {
    // Always clear first so reload/reconnect never stacks intervals.
    this.stopHealthMonitor();
    this.healthCheckTimerHandle = setInterval(() => {
      void this.runHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
  };

  /**
   * Probes `session.exists`; closes the socket on timeout/failure to force reconnect.
   */
  private runHealthCheck = async (): Promise<void> => {
    if (this.lifecycle.getStatus() !== "Connected") return;
    const rsocket = this.rsocket;
    if (!rsocket) return;
    // Skip if a previous probe is still racing the timeout Promise.
    if (this.healthCheckInFlight) return;

    this.healthCheckInFlight = true;
    let healthCheckTimeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sendCommandFn(rsocket, "session.exists", {}, this.meta()),
        new Promise<never>((_, reject) => {
          healthCheckTimeoutId = setTimeout(
            () => reject(new Error("Health check timeout")),
            HEALTH_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      // Socket swapped mid-probe (reload) — do not act on the stale instance.
      if (this.rsocket !== rsocket) return;
    } catch {
      // Only close if this is still the active socket; closing a new one would drop a healthy session.
      if (this.rsocket === rsocket) {
        rsocket.close();
      }
    } finally {
      if (healthCheckTimeoutId !== undefined) {
        clearTimeout(healthCheckTimeoutId);
      }
      this.healthCheckInFlight = false;
    }
  };

  /** @internal Test hook: whether lifecycle is suppressing auto-reconnect. */
  get suppressReconnect(): boolean {
    return this.lifecycle.isReconnectSuppressed();
  }

  /** @internal Test hook: exposes the health-check runner for timer tests. */
  get healthCheckRunner(): () => Promise<void> {
    return this.runHealthCheck;
  }

  /**
   * Blocks until `this.rsocket` is set, retrying connect until `config.timeout`.
   *
   * @remarks
   * Used by public APIs so callers need not call {@link connect} explicitly.
   * Failed attempts wait {@link CONNECT_RETRY_INTERVAL_MS} before retrying.
   *
   * @throws {@link Error} When the deadline passes without a live socket,
   *   including host/port and timeout in the message.
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
        // Soft-fail: keep retrying until the deadline for transient startup races.
        await new Promise((resolve) =>
          setTimeout(resolve, CONNECT_RETRY_INTERVAL_MS),
        );
      }
    }
  };

  /**
   * Opens TCP and completes the RSocket handshake (idempotent).
   *
   * @remarks
   * - Already connected → resolves immediately.
   * - Handshake in flight → returns the same `establishing` Promise (mutex).
   * - Requires {@link setFileProxy} first or throws.
   *
   * On success: resets reconnect backoff, registers `onClose`, emits
   * `"Connected"`, begins a session abort controller, and starts health checks.
   * On failure: clears the socket, emits `"Disconnected"`, and rethrows.
   *
   * @returns Resolves when connected (or already connected).
   * @throws {@link Error} When `fileProxy` is missing, or TCP/handshake fails.
   *
   * @example
   * ```ts
   * connection.setFileProxy(fileProxy);
   * await connection.connect();
   * ```
   */
  connect = async (): Promise<void> => {
    if (this.rsocket) return;
    // Coalesce concurrent connect() callers onto one handshake Promise.
    if (this.establishing) return this.establishing;

    this.establishing = (async () => {
      this.emitStatus("Connecting");

      try {
        if (!this.fileProxy) {
          throw new Error(
            "fileProxy not set. Call setFileProxy() before connect().",
          );
        }

        const transport = createTlsClientTransport({
          host: this.config.server,
          port: this.config.port,
          onCertificate: (fingerprint256) => {
            const decision = checkAndPinFingerprint(
              this.config.server,
              this.config.port,
              fingerprint256,
            );
            if (!decision.trust) {
              process.stderr.write(
                `\nWARNING: server certificate fingerprint changed for ${this.config.server}:${this.config.port}\n` +
                  `  expected: ${decision.pinnedFingerprint}\n` +
                  `  received: ${fingerprint256}\n` +
                  "Refusing to connect. If the server certificate was legitimately " +
                  "regenerated, clear the pin and reconnect to trust it again.\n\n",
              );
              return "reject";
            }
            if (decision.firstConnection) {
              process.stderr.write(
                `Trusting new server certificate for ${this.config.server}:${this.config.port} ` +
                  `(fingerprint: ${fingerprint256}). Verify this out-of-band if possible.\n`,
              );
            }
            return "trust";
          },
        });

        const connector = new RSocketConnector({
          transport,
          setup: {
            dataMimeType: "application/json",
            metadataMimeType: "application/json",
            // keepAlive/lifetime are RSocket heartbeats (ms), separate from our JSON health probe.
            keepAlive: 30_000,
            lifetime: 120_000,
          },
          responder: createFileResponder(this.fileProxy),
        });

        const rsocket = await connector.connect();
        this.rsocket = rsocket;
        this.lifecycle.resetReconnectAttempt();

        rsocket.onClose(() => {
          // Ignore close events from a socket that is no longer current (reload race).
          if (this.rsocket !== rsocket) return;
          this.handleSocketClosed();
        });

        this.emitStatus("Connected");
        this.beginSession();
        this.startHealthMonitor();
      } catch (err) {
        this.rsocket = null;
        this.emitStatus("Disconnected");
        throw err;
      }
    })().finally(() => {
      this.establishing = null;
    });

    return this.establishing;
  };

  /**
   * Cancels a pending reconnect timer via the lifecycle manager.
   */
  private clearReconnectTimer = (): void => {
    this.lifecycle.cancelReconnect();
  };

  /**
   * Replaces config in memory without reconnecting.
   *
   * @remarks
   * Safe for model/temperature tweaks. For host/port/password changes use
   * {@link reload}, which reconnects when those fields differ.
   *
   * @param config - New configuration object to store.
   */
  updateConfig = (config: Config): void => {
    this.config = config;
  };

  /**
   * Stores the local file proxy used by the inbound RSocket responder.
   *
   * @remarks
   * Must run before {@link connect}; otherwise connect throws. The proxy is
   * captured into the responder at handshake time.
   *
   * @param proxy - Workspace file proxy implementation.
   *
   * @example
   * ```ts
   * connection.setFileProxy(fileProxy);
   * await connection.connect();
   * ```
   */
  setFileProxy = (proxy: LocalFileProxy): void => {
    this.fileProxy = proxy;
  };

  /**
   * Applies new config and reconnects only if connection settings changed.
   *
   * @remarks
   * Compares `server`, `port`, and `password`. Unchanged → updates the stored
   * config and returns without touching the socket. Changed → suppresses
   * auto-reconnect, cancels timers, stops health checks, closes the old
   * socket, then {@link connect}s with the new settings. Suppression is always
   * cleared in `finally` so later unexpected closes can reconnect again.
   *
   * @param config - Full replacement configuration.
   * @returns Resolves when reconnect finishes, or immediately if transport
   *   settings were unchanged.
   * @throws {@link Error} When reconnect `connect()` fails (suppression still cleared).
   *
   * @example
   * ```ts
   * Host changed → reconnect
   * await connection.reload({ ...config, server: "new-host", port: 8080 });
   *
   * Models only → no reconnect
   * await connection.reload({ ...config, subagentModel: "gemma3:27b" });
   * ```
   */
  reload = async (config: Config): Promise<void> => {
    const previousConnectionSettings = {
      server: this.config.server,
      port: this.config.port,
      password: this.config.password,
    };

    this.config = config;

    if (
      previousConnectionSettings.server === config.server &&
      previousConnectionSettings.port === config.port &&
      previousConnectionSettings.password === config.password
    ) {
      return;
    }

    // Prevent the old socket's onClose from scheduling reconnect mid-reload.
    this.lifecycle.setSuppressReconnect(true);
    this.clearReconnectTimer();
    this.stopHealthMonitor();

    const oldRSocket = this.rsocket;
    this.rsocket = null;
    oldRSocket?.close();
    // The onClose guard (`this.rsocket !== rsocket`) skips handleSocketClosed
    // when we null the reference before closing. Call endSession directly so
    // the session AbortController is always aborted, regardless of that guard.
    this.endSession();

    let connectFailed = false;
    try {
      this.lifecycle.resetReconnectAttempt();
      await this.connect();
    } catch (err) {
      // Track that connect() threw so we can schedule a reconnect below.
      connectFailed = true;
      throw err;
    } finally {
      this.lifecycle.setSuppressReconnect(false);
      // If connect() failed, no onClose callback will fire to kick off the
      // backoff loop. Schedule reconnect now that suppression is cleared so
      // the connection can recover instead of staying stuck in Disconnected.
      if (connectFailed) {
        this.lifecycle.scheduleReconnect();
      }
    }
  };

  /**
   * Auth metadata for the current password in `this.config`.
   *
   * @returns UTF-8 JSON `{ password }` Buffer for RSocket frames.
   */
  private meta = (): Buffer => authMetadata(this.config);

  /**
   * Live socket accessor for command/stream helpers.
   *
   * @returns Connected {@link RSocket}.
   * @throws {@link Error} When disconnected (`"RSocket is not connected"`).
   */
  private socket = (): RSocket => requireSocket(this.rsocket);

  /**
   * Sends a `requestResponse` command and returns parsed `data`.
   *
   * @remarks
   * Waits for a live connection, then delegates to `sendCommand` in `commands.ts`.
   *
   * @typeParam TResponse - Expected `data` shape for this route.
   * @param type - Route such as `"models.list"` or `"memory.get"`.
   * @param payload - Command-specific JSON body.
   * @returns Parsed `data` from a successful envelope.
   * @throws {@link Error} On connect timeout, transport failure, or `ok: false`.
   */
  sendCommand = async <TResponse>(
    type: RouteId,
    payload: unknown,
  ): Promise<TResponse> => {
    await this.waitUntilConnected();
    return sendCommandFn(this.socket(), type, payload, this.meta());
  };

  /**
   * Fetches installed Ollama models with full metadata.
   *
   * @returns Array of model metadata objects from the server.
   * @throws {@link Error} On connect failure or invalid `models.list` response.
   */
  fetchModelsDetailed = async () => {
    await this.waitUntilConnected();
    return fetchModelsDetailedFn(this.socket(), this.meta());
  };

  /**
   * Fetches installed Ollama model names.
   *
   * @returns Model name strings suitable for selection UIs.
   * @throws {@link Error} On connect failure or invalid list response.
   *
   * @example
   * ```ts
   * const names = await connection.fetchModels();
   * ```
   */
  fetchModels = async (): Promise<string[]> => {
    await this.waitUntilConnected();
    return fetchModelsFn(this.socket(), this.meta());
  };

  /**
   * Alias of {@link fetchModels} retained for older call sites.
   *
   * @deprecated Use {@link fetchModels} instead.
   * @returns Model name strings.
   */
  listModels = async (): Promise<string[]> => this.fetchModels();

  /**
   * Uploads local skill markdown files for agent/subagent use.
   *
   * @param skills - Skill name + content payloads to sync.
   * @throws {@link Error} On connect or command failure.
   */
  syncSkills = async (skills: SkillPayload[]): Promise<void> => {
    await this.waitUntilConnected();
    await syncSkillsFn(this.socket(), this.meta(), skills);
  };

  /**
   * Loads all memory preference entries from the server.
   *
   * @returns Topics with their rules; empty when none stored.
   * @throws {@link Error} On connect or command failure.
   */
  getMemory = async () => {
    await this.waitUntilConnected();
    return getMemoryFn(this.socket(), this.meta());
  };

  /**
   * Deletes memory rules for a single topic.
   *
   * @param topic - Exact topic key to forget.
   * @throws {@link Error} On connect or command failure.
   */
  forgetMemory = async (topic: string): Promise<void> => {
    await this.waitUntilConnected();
    await forgetMemoryFn(this.socket(), this.meta(), topic);
  };

  /**
   * Wipes the entire server-side memory store for this user/session.
   *
   * @throws {@link Error} On connect or command failure.
   */
  clearMemory = async (): Promise<void> => {
    await this.waitUntilConnected();
    await clearMemoryFn(this.socket(), this.meta());
  };

  /**
   * Streams a user task and dispatches frames / tokens to callbacks.
   *
   * @remarks
   * Uses models and temperatures from the current config. `onToken` enables
   * token-by-token CLI output; `onFrame` receives the full task event stream.
   *
   * @param taskOptions - Task text, optional `maxSubagents` / `approvalMode`, and stream callbacks.
   * @returns A {@link StreamHandle} whose `done` promise settles when the
   *   server completes the task stream. Call `cancel()` to abort without
   *   treating the abort as an error.
   * @throws {@link Error} On connect failure or mid-stream RSocket / handler errors.
   *
   * @example
   * ```ts
   * const { done, cancel } = await connection.sendTask({
   *   task: "Explain this code",
   *   maxSubagents: 2,
   *   onFrame: (frame) => console.log(frame.kind),
   *   onToken: (token) => process.stdout.write(token),
   * });
   * await done;
   * ```
   */
  sendTask = async (taskOptions: {
    task: string;
    maxSubagents?: 1 | 2 | "max" | number;
    approvalMode?: TaskApprovalMode;
    onFrame: (frame: TaskFrame) => void | Promise<void>;
    onToken?: (token: string) => void;
  }): Promise<StreamHandle> => {
    await this.waitUntilConnected();
    return sendTaskFn(
      taskOptions.task,
      this.config,
      this.meta(),
      this.socket(),
      taskOptions.onFrame,
      taskOptions.onToken,
      taskOptions.maxSubagents,
      taskOptions.approvalMode,
    );
  };

  /**
   * Streams long-running operations such as model pull or explore.
   *
   * @param streamOptions - Discriminated operation kind, payload, and `onFrame`.
   * @returns A {@link StreamHandle} whose `done` promise settles when the
   *   server completes the stream.
   * @throws {@link Error} On connect failure or stream errors.
   *
   * @example
   * ```ts
   * const { done } = await connection.sendStream({
   *   kind: "models.pull",
   *   payload: { name: "gemma3:27b" },
   *   onFrame: (frame) => console.log(frame),
   * });
   * await done;
   * ```
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
  ): Promise<StreamHandle> => {
    await this.waitUntilConnected();
    return sendStreamFn(streamOptions, this.meta(), this.socket());
  };

  /**
   * Answers a pending plan-review prompt from the server.
   *
   * @param id - Plan id from the server’s plan frame.
   * @param decision - `"implement"`, `"skip"`, or `"edit"`.
   * @param feedback - Free-text feedback when `decision` is `"edit"`; the
   *   agent re-plans using this feedback.
   * @returns Resolves when the server acknowledges the decision.
   * @throws {@link Error} On connect or command failure.
   *
   * @example
   * ```ts
   * await connection.respondPlan(planId, "implement");
   * await connection.respondPlan(planId, "edit", "Add tests for the edge cases");
   * ```
   */
  respondPlan = async (
    id: string,
    decision: "implement" | "skip" | "edit",
    feedback?: string,
  ): Promise<void> => {
    await this.waitUntilConnected();
    await respondPlanFn(this.socket(), this.meta(), id, decision, feedback);
  };
}
