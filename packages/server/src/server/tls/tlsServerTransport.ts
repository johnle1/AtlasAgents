/**
 * TLS 1.3 server transport for RSocket, built on `@rsocket/tcp-server`.
 *
 * @remarks
 * `@rsocket/tcp-server`'s `TcpServerTransport` accepts a `socketCreator`
 * factory typed to return a `net.Server`, so a `tls.Server` — which extends
 * `net.Server` — can be substituted with no fork of the transport itself.
 *
 * The one incompatibility: `TcpServerTransport.bind()` listens for the
 * `"connection"` event (the raw, not-yet-decrypted socket, fired immediately
 * on TCP accept), but `tls.Server` never fires that — it only fires
 * `"secureConnection"`, once the TLS handshake completes, with the decrypted
 * socket. `createTlsServerShim` bridges this: it wraps the real `tls.Server`
 * and remaps `"connection"` registrations to `"secureConnection"`, so the
 * transport receives a working per-connection socket, and only receives it
 * after our TLS 1.3 handshake has actually succeeded.
 *
 * This shim wraps the *server* object only — each individual accepted
 * connection's socket is handed to the transport unmodified, exactly as
 * `tls.Server` produced it. Validated end-to-end against the real
 * `@rsocket/core` + `@rsocket/tcp-server` packages (request/response over a
 * live TLS 1.3 socket, and confirmed a TLS 1.2 client is rejected) before
 * this file was written.
 */

import * as tls from "node:tls";
import type * as net from "node:net";
import { TcpServerTransport } from "@rsocket/tcp-server";
import type { ServerCertificate } from "./certificateStore.js";

/** The subset of `net.Server`'s surface that `TcpServerTransport` actually calls. */
type ServerLike = {
  listen: (...args: unknown[]) => unknown;
  addListener: (event: string, listener: (...args: unknown[]) => void) => ServerLike;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => ServerLike;
  close: (...args: unknown[]) => unknown;
};

const remapConnectionEvent = (event: string): string =>
  event === "connection" ? "secureConnection" : event;

/**
 * Wraps a `tls.Server` so `TcpServerTransport` can drive it exactly like a
 * plain `net.Server`.
 *
 * @remarks
 * Only implements the four methods `TcpServerTransport.bind()` actually
 * calls (`listen`, `addListener`, `removeListener`, `close`) — see the
 * module doc for why a full `net.Server` surface isn't needed. Each accepted
 * socket passed to `"connection"`-mapped listeners is the real, decrypted
 * `tls.TLSSocket` — no further wrapping happens per-connection.
 */
const createTlsServerShim = (cert: ServerCertificate): ServerLike => {
  const server = tls.createServer({
    cert: cert.cert,
    key: cert.key,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
  });

  const shim: ServerLike = {
    listen: (...args) => server.listen(...(args as Parameters<typeof server.listen>)),
    addListener: (event, listener) => {
      server.addListener(remapConnectionEvent(event), listener);
      return shim;
    },
    removeListener: (event, listener) => {
      server.removeListener(remapConnectionEvent(event), listener);
      return shim;
    },
    close: (...args) => server.close(...(args as Parameters<typeof server.close>)),
  };

  return shim;
};

/**
 * Builds a TLS 1.3 RSocket server transport bound to the given host/port.
 *
 * @param listenOptions - Host and port to listen on (host is typically
 *   `"0.0.0.0"` to accept connections on every interface).
 * @param cert - The server's TLS certificate and private key, from
 *   {@link loadOrCreateServerCert}.
 * @returns A `TcpServerTransport` that only accepts TLS 1.3 connections.
 *
 * @example
 * ```ts
 * const cert = await loadOrCreateServerCert(dataRoot);
 * const transport = createTlsServerTransport({ host: "0.0.0.0", port: 7000 }, cert);
 * ```
 */
export const createTlsServerTransport = (
  listenOptions: { host: string; port: number },
  cert: ServerCertificate,
): TcpServerTransport =>
  new TcpServerTransport({
    listenOptions,
    socketCreator: () => createTlsServerShim(cert) as unknown as net.Server,
  });
