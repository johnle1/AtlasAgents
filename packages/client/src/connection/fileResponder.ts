import type { Payload } from "@rsocket/core";
import type { LocalFileProxy } from "../localFileProxy.js";

/**
 * <Summary>
 * What it does:
 *   Describes the RSocket responder stream interface used to send responses
 *   back to the server for requestResponse calls.
 *
 * Used by:
 *   - RequestResponseResponder — callback signature for incoming requests.
 *
 * Produced by:
 *   - RSocket runtime — passed into the responder callback.
 * </Summary>
 */
type ResponderStream = {
  /** Sends one response payload; isComplete=true marks the final frame. */
  onNext: (payload: Payload, isComplete: boolean) => void;
};

/**
 * <Summary>
 * What it does:
 *   Function signature for handling a single server-initiated requestResponse.
 *
 * Used by:
 *   - createFileResponder — returned as the requestResponse handler.
 *
 * Produced by:
 *   - createFileResponder — factory function.
 * </Summary>
 */
type RequestResponseResponder = (
  payload: Payload,
  responderStream: ResponderStream,
) => { cancel: () => void; onExtension: () => void };

/**
 * <Summary>
 * What it does:
 *   Builds the RSocket responder object that handles server-initiated file
 *   operations by delegating to LocalFileProxy.
 *
 * How it does it (step by step):
 *   1. Returns a responder config with a requestResponse handler.
 *   2. On each incoming request: decode JSON route and payload.
 *   3. Call fileProxy.handle(route, payload) and serialise the result.
 *   4. On missing proxy or errors: respond with { ok: false, error } JSON.
 *
 * Parameters:
 *   @param {LocalFileProxy | null} fileProxy — File proxy instance, or null if
 *     not yet initialised via Connection.setFileProxy.
 *
 * Returns:
 *   @returns {{ requestResponse: RequestResponseResponder }} — RSocket responder
 *     config passed to RSocketConnector.
 *
 * Dependencies:
 *   - LocalFileProxy.handle — executes file operations on the client filesystem.
 *
 * Dependants:
 *   - Connection.connect — passes this to RSocketConnector.responder.
 * </Summary>
 */
export function createFileResponder(
  fileProxy: LocalFileProxy | null,
): { requestResponse: RequestResponseResponder } {
  return {
    requestResponse: (payload, responderStream) => {
      // ===== STEP 1: Handle Request Asynchronously =====
      // Step 1a: Use async IIFE so the RSocket callback returns immediately
      // Step 1b: Response is sent via responderStream.onNext when processing completes
      void (async () => {
        try {
          // ===== STEP 2: Validate File Proxy =====
          // Step 2a: If setFileProxy was never called, return an error response
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

          // ===== STEP 3: Decode Incoming Payload =====
          // Step 3a: Extract UTF-8 string from payload data buffer
          const raw = payload.data?.toString("utf-8") ?? "{}";

          // Step 3b: Parse JSON to extract route and payload fields
          const body = JSON.parse(raw) as {
            route?: string;
            payload?: unknown;
          };

          // ===== STEP 4: Dispatch to File Proxy =====
          // Step 4a: Extract route string (default to empty if missing)
          const route = String(body.route ?? "");

          // Step 4b: Call file proxy to handle the operation on local filesystem
          const result = await fileProxy.handle(route, body.payload);

          // ===== STEP 5: Send Success Response =====
          // Step 5a: Serialize result to JSON and send as response with COMPLETE flag
          responderStream.onNext(
            { data: Buffer.from(JSON.stringify(result)) },
            true,
          );
        } catch (err) {
          // ===== STEP 6: Send Error Response =====
          // Step 6a: Extract error message from Error object or stringify unknown values
          const message = err instanceof Error ? err.message : String(err);

          // Step 6b: Send error envelope back to server with COMPLETE flag
          responderStream.onNext(
            {
              data: Buffer.from(
                JSON.stringify({ ok: false, error: message }),
              ),
            },
            true,
          );
        }
      })();

      // ===== STEP 7: Return Cancellation Handle =====
      // Step 7a: RSocket requires cancel/onExtension handlers; no-op for file ops
      return {
        cancel: () => {},
        onExtension: () => {},
      };
    },
  };
}
