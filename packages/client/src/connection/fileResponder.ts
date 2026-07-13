/**
 * RSocket responder that executes server-initiated local file proxy requests.
 *
 * @remarks
 * During the client handshake, {@link Connection} registers this responder so
 * the server can `requestResponse` into the client to read/write/delete workspace
 * files (and related proxy routes). Requests are `{ route, payload }` JSON;
 * responses are JSON result envelopes from {@link LocalFileProxy.handle}, or
 * `{ ok: false, error }` when the proxy is missing or throws.
 */

import type { Payload } from "@rsocket/core";
import type { LocalFileProxy } from "../localFileProxy.js";
import { formatErrorMessage } from "../commands/utils.js";

/**
 * Minimal responder stream used to write the single response frame.
 *
 * @remarks
 * Mirrors the subset of the RSocket responder API this module needs: one
 * `onNext` with `isComplete: true` ends the requestResponse exchange.
 */
type ResponderStream = {
  /** Sends one payload; pass `isComplete: true` for the final (only) frame. */
  onNext: (payload: Payload, isComplete: boolean) => void;
};

/**
 * Handler signature expected by `@rsocket/core` for inbound `requestResponse`.
 *
 * @remarks
 * Must return quickly with `cancel` / `onExtension` hooks; heavy work runs in
 * a fire-and-forget async IIFE so the RSocket event loop is not blocked.
 */
type RequestResponseResponder = (
  payload: Payload,
  responderStream: ResponderStream,
) => { cancel: () => void; onExtension: () => void };

/**
 * Builds the responder config object passed to `RSocketConnector`.
 *
 * @remarks
 * The proxy instance is closed over at factory call time (during
 * `Connection.connect`). Call {@link Connection.setFileProxy} before connect
 * so the handshake embeds a live proxy. If `fileProxy` is still `null`, the
 * client answers with a structured `{ ok: false }` error instead of throwing
 * into the RSocket stack.
 *
 * File-proxy cancellation is unimplemented (`cancel` is a no-op): workspace
 * ops are short-lived; long cancels would need cooperative abort inside the
 * proxy.
 *
 * @param fileProxy - Active {@link LocalFileProxy}, or `null` if not ready.
 * @returns `{ requestResponse }` suitable for `RSocketConnector`’s `responder`.
 *
 * @example
 * ```ts
 * const responder = createFileResponder(fileProxy);
 * const connector = new RSocketConnector({
 *   transport,
 *   setup: {
 *     dataMimeType: "application/json",
 *     metadataMimeType: "application/json",
 *     keepAlive: 30_000,
 *     lifetime: 120_000,
 *   },
 *   responder,
 * });
 * ```
 */
export const createFileResponder = (
  fileProxy: LocalFileProxy | null,
): { requestResponse: RequestResponseResponder } => {
  return {
    requestResponse: (payload, responderStream) => {
      // Return cancel hooks synchronously; do I/O on a microtask/async path.
      void (async () => {
        try {
          if (!fileProxy) {
            responderStream.onNext(
              {
                data: Buffer.from(
                  JSON.stringify({
                    ok: false,
                    error: "File proxy not initialized",
                  }),
                ),
              },
              true,
            );
            return;
          }

          // Empty / missing data is treated as `{}` so route parsing still runs.
          const raw = payload.data?.toString("utf-8") ?? "{}";
          const body = JSON.parse(raw) as {
            route?: string;
            payload?: unknown;
          };

          const route = String(body.route ?? "");
          const result = await fileProxy.handle(route, body.payload);

          responderStream.onNext(
            { data: Buffer.from(JSON.stringify(result)) },
            true,
          );
        } catch (err) {
          // Always complete the stream — leaving it open stalls the server.
          const message = formatErrorMessage(err);
          responderStream.onNext(
            {
              data: Buffer.from(JSON.stringify({ ok: false, error: message })),
            },
            true,
          );
        }
      })();

      // Required by the RSocket responder contract; file ops do not cancel mid-flight.
      return {
        cancel: () => {},
        onExtension: () => {},
      };
    },
  };
};
