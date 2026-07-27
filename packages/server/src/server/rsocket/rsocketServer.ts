/**
 * RSocket TCP transport for the LoopyCode server.
 *
 * @remarks
 * This module is the network entry point for every LoopyCode CLI connection.
 * It owns the raw RSocket/TCP socket, manages connection lifecycle, and
 * hands validated requests off to handlers for the actual work. It does
 * not implement any business logic itself — think of it as the door, not the
 * building.
 *
 * The transport speaks two RSocket interaction models:
 * - **requestResponse** for one-shot commands (list models, read config, ...),
 *   which return a single JSON payload.
 * - **requestStream** for long-running work (running a task, pulling a model,
 *   exploring a codebase), which streams many frames until completion.
 *
 * @see {@link RSocketServer} for the public class exported from this module.
 */

import * as crypto from "node:crypto";

import {
  RSocketServer as RSocketServerCore,
  type Closeable,
  type RSocket,
  type SetupPayload,
} from "@rsocket/core";

import type { Router } from "../../routing/router.js";
import type { AuthMiddleware, SessionRecord } from "./types.js";
import {
  createRequestResponseHandler,
  createRequestStreamHandler,
} from "./handlers/index.js";
import { createTlsServerTransport } from "../tls/tlsServerTransport.js";
import type { ServerCertificate } from "../tls/certificateStore.js";

/**
 * An RSocket/TCP server that authenticates, routes, and cancels LoopyCode CLI
 * traffic.
 *
 * @remarks
 * A single instance owns one listening TCP socket. For each connection it
 * creates a logical session, validates the password carried in every frame's
 * metadata, and forwards the request to the injected {@link Router}. When a
 * client disconnects, all of that connection's in-flight streams are aborted so
 * no orchestration work is left running.
 *
 * **Authentication is per-frame, not per-connection.** The RSocket SETUP
 * payload is ignored; instead every command and stream frame must carry
 * `{ "password": "..." }` metadata, which is checked against the supplied
 * {@link AuthMiddleware}. This keeps the server stateless with respect to auth.
 *
 * **Lifecycle:** construct → {@link RSocketServer.start | start} → serve
 * traffic → {@link RSocketServer.stop | stop}. `start` must resolve before the
 * server accepts connections, and `stop` releases the socket.
 *
 * @example
 * ```ts
 * const server = new RSocketServer(
 *   4000,
 *   { validate: (pw) => (pw === secret ? "user_1" : null) },
 *   router,
 *   (requesterId) => console.log(`${requesterId} disconnected`),
 * );
 *
 * await server.start(); // now listening on 0.0.0.0:4000
 * // ... serve traffic ...
 * server.stop();        // release the socket
 * ```
 *
 * @see {@link Router} for how validated requests are dispatched to handlers.
 */
export class RSocketServer {
  /** Handle to the bound TCP server; `null` before `start` and after `stop`. */
  private closeable: Closeable | null = null;

  /**
   * Live sessions keyed by `requesterId`.
   *
   * @remarks
   * Each entry holds the peer socket plus the set of `AbortController`s for that
   * connection's in-flight streams, so they can all be aborted on disconnect.
   */
  private readonly activeSessions = new Map<string, SessionRecord>();

  /**
   * Fallback peer registry used when no shared `clientPeers` map is injected.
   *
   * @remarks
   * The server needs a way to look up a client's socket by `requesterId` (for
   * server→client requests). When the caller does not provide a shared map, the
   * server keeps its own private one here.
   */
  private readonly internalClientPeers = new Map<string, RSocket>();

  /**
   * Creates a server bound to a port, auth strategy, and router.
   *
   * @param port - TCP port to listen on. Bound to all interfaces (`0.0.0.0`)
   *   once {@link RSocketServer.start | start} is called.
   * @param auth - Validates the per-frame metadata password. `validate` returns
   *   the resolved user id on success, or `null` to reject the request.
   * @param router - Stateless dispatcher that turns a `(type, payload)` pair
   *   into command or stream work. See {@link Router}.
   * @param onConnectionClosed - Optional callback fired with the `requesterId`
   *   after a connection closes and its session has been torn down. Use it to
   *   clean up any external per-connection state you track.
   * @param clientPeers - Optional shared map of `requesterId → RSocket`. Pass
   *   this when another component needs to send frames to connected clients;
   *   otherwise the server falls back to an internal map.
   * @param cert - The server's TLS certificate and private key (see
   *   {@link loadOrCreateServerCert}). Every connection is TLS 1.3; there is
   *   no plaintext fallback.
   */
  constructor(
    private readonly port: number,
    private readonly auth: AuthMiddleware,
    private readonly router: Router,
    private readonly onConnectionClosed: ((requesterId: string) => void) | undefined,
    private readonly clientPeers: Map<string, RSocket> | undefined,
    private readonly cert: ServerCertificate,
  ) {}

  /**
   * Binds the TCP socket and begins accepting RSocket connections.
   *
   * @remarks
   * Must be awaited before the server can serve traffic. Listens on all
   * interfaces (`0.0.0.0`) on the port passed to the constructor. Call
   * {@link RSocketServer.stop | stop} to release the socket. Calling `start`
   * more than once replaces the internal handle and leaks the previous socket,
   * so pair each `start` with a `stop`.
   *
   * @returns A promise that resolves once the socket is listening and ready to
   *   accept connections.
   *
   * @example
   * ```ts
   * const server = new RSocketServer(4000, auth, router);
   * await server.start();
   * console.log("Listening on :4000");
   * ```
   */
  start = async (): Promise<void> => {
    const transport = createTlsServerTransport(
      { host: "0.0.0.0", port: this.port },
      this.cert,
    );
    const core = new RSocketServerCore({
      transport,
      acceptor: { accept: this.onAccept },
    });
    this.closeable = await core.bind();
  };

  /**
   * Stops listening and releases the TCP socket.
   *
   * @remarks
   * Safe to call when the server was never started or is already stopped — it
   * is a no-op in those cases. Closing the socket triggers each peer's
   * `onClose` hook, which aborts that connection's in-flight streams. Existing
   * sessions are not drained gracefully; treat this as an immediate shutdown.
   */
  stop = (): void => {
    this.closeable?.close();
    this.closeable = null;
  };

  /**
   * Accepts a new RSocket connection and wires up its session and handlers.
   *
   * @remarks
   * Invoked by the RSocket core once per connection, immediately after SETUP.
   * It:
   * 1. Allocates a random `requesterId` and an empty set of `AbortController`s.
   * 2. Records the session in `activeSessions` and the peer in the peers map.
   * 3. Registers an `onClose` hook that aborts every in-flight stream, removes
   *    the session, and fires the `onConnectionClosed` callback.
   * 4. Returns the `requestResponse` and `requestStream` handlers for this peer.
   *
   * The SETUP payload is intentionally ignored: authentication happens
   * per-frame inside the returned handlers, not at connection time.
   *
   * @param _setup - The RSocket SETUP payload. Unused — kept only to satisfy
   *   the acceptor signature.
   * @param remotePeer - The peer socket, used to register the disconnect hook
   *   and to send server→client frames.
   * @returns A partial RSocket exposing `requestResponse` and `requestStream`
   *   for this connection.
   */
  private onAccept = async (
    _setup: SetupPayload,
    remotePeer: RSocket,
  ): Promise<Partial<RSocket>> => {
    const requesterId = crypto.randomUUID();

    const record: SessionRecord = {
      abortControllers: new Set(),
      remotePeer,
    };

    this.activeSessions.set(requesterId, record);
    const peers = this.clientPeers ?? this.internalClientPeers;
    peers.set(requesterId, remotePeer);

    remotePeer.onClose(() => {
      for (const ac of record.abortControllers) {
        ac.abort();
      }
      this.activeSessions.delete(requesterId);
      peers.delete(requesterId);
      this.onConnectionClosed?.(requesterId);
    });

    const handleRequestResponse = createRequestResponseHandler(
      this.auth,
      this.router,
    );
    const handleRequestStream = createRequestStreamHandler(
      this.auth,
      this.router,
    );

    return {
      requestResponse: (payload, responderStream) =>
        handleRequestResponse(requesterId, payload, responderStream),
      requestStream: (payload, _initialN, responderStream) =>
        handleRequestStream(requesterId, record, payload, responderStream),
    };
  };

  /**
   * Looks up the live peer socket for a connection so the server can push
   * frames to that client.
   *
   * @remarks
   * Reads from the shared `clientPeers` map when one was injected at
   * construction, otherwise from the server's internal map. Entries are added
   * on connect and removed on disconnect, so a `requesterId` for a closed
   * connection returns `undefined`.
   *
   * @param requesterId - The connection id (as seen on `session.requesterId`).
   * @returns The peer's {@link RSocket}, or `undefined` if no such connection
   *   is currently active.
   *
   * @example
   * ```ts
   * const peer = server.getClientPeer(session.requesterId);
   * if (peer) {
   *   peer.requestResponse({ data: encodeFrame(frame) }, responder);
   * }
   * ```
   */
  getClientPeer = (requesterId: string): RSocket | undefined => {
    const peers = this.clientPeers ?? this.internalClientPeers;
    return peers.get(requesterId);
  };
}
