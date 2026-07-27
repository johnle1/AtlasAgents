/**
 * TLS 1.3 client transport for RSocket, built on `@rsocket/tcp-client`.
 *
 * @remarks
 * `@rsocket/tcp-client`'s `TcpClientTransport` accepts a `socketCreator`
 * factory typed to return a `net.Socket`, so a `tls.TLSSocket` — which
 * extends `net.Socket` — can be substituted with no fork of the transport.
 *
 * Two incompatibilities had to be bridged, both validated end-to-end against
 * the real `@rsocket/core` + `@rsocket/tcp-client` packages before this file
 * was written (request/response over a live TLS 1.3 socket; a rejected
 * fingerprint correctly failing `connect()` with no frame ever sent):
 *
 * 1. **Event name.** `TcpDuplexConnection` does `socket.once("connect", ...)`,
 *    but a `tls.TLSSocket` only fires `"secureConnect"` once its handshake —
 *    including our TLS 1.3-only version pinning — completes.
 *
 * 2. **Monkey-patching `.once()` on the real socket is unsafe.** An earlier
 *    attempt redirected `"connect"` → `"secureConnect"` by overriding
 *    `socket.once` directly on the real object. That also intercepts Node's
 *    own internal `Socket._read()`, which registers its own
 *    `once("connect", ...)` listener for unrelated internal buffering
 *    purposes — redirecting that too deadlocks the handshake (the read side
 *    never resumes, so the handshake bytes are never read, so
 *    `"secureConnect"` never fires). The fix returns a `Proxy` instead:
 *    external callers (the RSocket transport) only ever hold a reference to
 *    the Proxy, so their `.once`/`.on` calls get remapped, while Node's
 *    internals call `this.once(...)` on the *real* object (self-reference),
 *    never touching the Proxy.
 *
 * A third concern — the certificate check — is handled by gating, not by
 * remapping: "connect"-mapped listener registrations are queued rather than
 * attached to the real `"secureConnect"` event, and are only invoked (as
 * plain function calls) once {@link TlsSocketOptions.onCertificate} has
 * approved the peer's fingerprint. On rejection the socket is destroyed and
 * the queue is discarded — the queued listener (which would otherwise
 * resolve `TcpClientTransport.connect()`'s promise and let a frame,
 * including the auth password, be sent) is never invoked. The unshimmed
 * `"error"`/`"close"`/`"end"` listeners that `TcpClientTransport.connect()`
 * also registers fire normally from the destroy, rejecting that promise.
 */

import * as tls from "node:tls";
import type * as net from "node:net";
import { TcpClientTransport } from "@rsocket/tcp-client";

/** Decision returned by the caller-supplied certificate check. */
export type CertificateDecision = "trust" | "reject";

type QueuedListener = (...args: unknown[]) => void;

/**
 * Wraps a `tls.TLSSocket` so `TcpClientTransport` can drive it exactly like
 * a plain `net.Socket`, gating readiness on a certificate fingerprint check.
 *
 * @remarks
 * See the module doc for why this needs a `Proxy` plus a listener queue
 * rather than a direct event-name remap.
 */
const wrapWithFingerprintGate = (
  real: tls.TLSSocket,
  onCertificate: (fingerprint256: string) => CertificateDecision,
): net.Socket => {
  let verified = false;
  let rejected = false;
  const pendingConnectListeners: QueuedListener[] = [];

  real.once("secureConnect", () => {
    const peerCert = real.getPeerCertificate();
    const decision = onCertificate(peerCert.fingerprint256);
    if (decision === "reject") {
      rejected = true;
      real.destroy(
        new Error(
          "Server certificate fingerprint does not match the pinned value — refusing to connect. " +
            "If the server's certificate was legitimately regenerated, clear the pin first.",
        ),
      );
      return;
    }
    verified = true;
    for (const listener of pendingConnectListeners.splice(0)) {
      listener();
    }
  });

  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "once" || prop === "on" || prop === "addListener") {
        return (event: string | symbol, listener: QueuedListener) => {
          if (event === "connect") {
            if (verified) {
              listener();
            } else if (!rejected) {
              pendingConnectListeners.push(listener);
            }
            return receiver;
          }
          (target[prop as "once"] as (...a: unknown[]) => unknown).call(
            target,
            event,
            listener,
          );
          return receiver;
        };
      }
      if (prop === "removeListener" || prop === "off") {
        return (event: string | symbol, listener: QueuedListener) => {
          if (event === "connect") {
            const index = pendingConnectListeners.indexOf(listener);
            if (index !== -1) {
              pendingConnectListeners.splice(index, 1);
            }
            return receiver;
          }
          (target[prop as "removeListener"] as (...a: unknown[]) => unknown).call(
            target,
            event,
            listener,
          );
          return receiver;
        };
      }
      const value = target[prop as keyof tls.TLSSocket];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return proxy as unknown as net.Socket;
};

/** Options for {@link createTlsClientTransport}. */
export type TlsClientTransportOptions = {
  /** Server hostname or IP to connect to. */
  host: string;
  /** Server TCP port. */
  port: number;
  /**
   * Called once per connection attempt, immediately after the TLS 1.3
   * handshake completes, with the peer's SHA-256 certificate fingerprint.
   * Return `"reject"` to abort the connection before any RSocket frame is
   * exchanged (see {@link checkAndPinFingerprint} for the TOFU policy this
   * is normally wired to).
   */
  onCertificate: (fingerprint256: string) => CertificateDecision;
};

/**
 * Builds a TLS 1.3 RSocket client transport with fingerprint-gated trust.
 *
 * @param options - Target host/port and the certificate trust decision.
 * @returns A `TcpClientTransport` that only completes a connection over
 *   TLS 1.3 to a peer whose fingerprint `onCertificate` approved.
 *
 * @example
 * ```ts
 * const transport = createTlsClientTransport({
 *   host: config.server,
 *   port: config.port,
 *   onCertificate: (fp) => checkAndPinFingerprint(config.server, config.port, fp).trust
 *     ? "trust" : "reject",
 * });
 * ```
 */
export const createTlsClientTransport = (
  options: TlsClientTransportOptions,
): TcpClientTransport =>
  new TcpClientTransport({
    connectionOptions: { host: options.host, port: options.port },
    socketCreator: () => {
      const real = tls.connect({
        host: options.host,
        port: options.port,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        // Certificate validation is replaced by the fingerprint gate above,
        // not skipped — rejectUnauthorized is only safe to disable because
        // that gate runs before any external "connect" listener can fire.
        rejectUnauthorized: false,
      });
      return wrapWithFingerprintGate(real, options.onCertificate);
    },
  });
