/**
 * Handler for RSocket requestResponse frames (one-shot commands).
 */

import type { Cancellable, OnExtensionSubscriber, Payload } from "@rsocket/core";

import type { Router } from "../../../routing/router.js";
import type {
  AuthMiddleware,
  RequestResponseResponder,
} from "../types.js";
import {
  commandResponseBuffer,
  parsePasswordFromMetadata,
} from "../types.js";

/**
 * Creates a handler for a single requestResponse frame.
 *
 * @remarks
 * This handler authenticates the frame, parses the JSON envelope, routes the
 * command to the Router, and sends back a single terminal response frame.
 * It never rejects — all errors are converted to `{ ok: false, error }` responses.
 *
 * @param requesterId - Session id, forwarded to the router
 * @param payload - The incoming frame (JSON body plus auth metadata)
 * @param responderStream - Sink for the one JSON response frame
 * @param auth - Authentication middleware
 * @param router - Request router
 * @returns A cancellable handle (cancellation is a no-op for requestResponse)
 */
export const createRequestResponseHandler =
  (auth: AuthMiddleware, router: Router) =>
  (
    requesterId: string,
    payload: Payload,
    responderStream: RequestResponseResponder,
  ): Cancellable & OnExtensionSubscriber => {
    void runRequestResponse(
      auth,
      router,
      requesterId,
      payload,
      responderStream,
    );
    return {
      cancel: () => {},
      onExtension: () => {},
    };
  };

/**
 * Authenticates, parses, routes, and answers one command frame.
 *
 * @remarks
 * This is the async body behind {@link createRequestResponseHandler}.
 * It never rejects: every failure path (unauthorized, non-JSON body, wrong
 * envelope kind, or a handler that throws) is converted into a
 * `{ ok: false, error }` response frame via {@link commandResponseBuffer},
 * so the client always receives exactly one terminal PAYLOAD.
 *
 * The client envelope must be a JSON object of the shape
 * `{ kind: "command", type: string, payload?: unknown }`. The `type` is
 * routed through {@link Router.routeCommand}.
 *
 * @param auth - Authentication middleware
 * @param router - Request router
 * @param requesterId - Session id, forwarded to the router as `session.requesterId`
 * @param payload - The incoming frame (JSON body plus auth metadata)
 * @param stream - Sink for the one JSON response frame
 * @returns A promise that resolves after the terminal frame is emitted
 */
export const runRequestResponse = async (
  auth: AuthMiddleware,
  router: Router,
  requesterId: string,
  payload: Payload,
  stream: RequestResponseResponder,
): Promise<void> => {
  const incoming = parsePasswordFromMetadata(payload.metadata);
  const userId = auth.validate(incoming);
  if (userId === null) {
    // The second `onNext` argument is RSocket's "isComplete" flag: `true`
    // makes this the single terminal frame for a requestResponse.
    stream.onNext(
      { data: commandResponseBuffer(false, undefined, "Unauthorized") },
      true,
    );
    return;
  }
  try {
    let parsed: {
      kind?: string;
      type?: string;
      payload?: unknown;
    };
    try {
      const parsedBody: unknown = JSON.parse(
        payload.data?.toString("utf-8") ?? "{}",
      );
      if (typeof parsedBody !== "object" || parsedBody === null) {
        stream.onNext(
          {
            data: commandResponseBuffer(
              false,
              undefined,
              "Expected a JSON object body",
            ),
          },
          true,
        );
        return;
      }
      parsed = parsedBody as typeof parsed;
    } catch {
      stream.onNext(
        {
          data: commandResponseBuffer(false, undefined, "Invalid command JSON"),
        },
        true,
      );
      return;
    }

    if (parsed.kind !== "command") {
      stream.onNext(
        { data: commandResponseBuffer(false, undefined, "Expected kind=command") },
        true,
      );
      return;
    }
    if (typeof parsed.type !== "string") {
      stream.onNext(
        { data: commandResponseBuffer(false, undefined, "Expected type string") },
        true,
      );
      return;
    }

    const session = { userId, requesterId };
    const result = await router.routeCommand(
      session,
      parsed.type,
      parsed.payload,
    );
    stream.onNext(
      { data: commandResponseBuffer(true, result, undefined) },
      true,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stream.onNext(
      { data: commandResponseBuffer(false, undefined, message) },
      true,
    );
  }
};
