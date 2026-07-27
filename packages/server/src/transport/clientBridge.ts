/**
 * Bidirectional RSocket bridge between server and connected clients.
 *
 * @remarks
 * Enables the server to send file operations (read, write, search) and other
 * commands to connected clients, receiving JSON responses with automatic timeout
 * and error handling. Abstracts RSocket protocol details behind a simple
 * request/response API.
 */

import type { Payload, RSocket } from "@rsocket/core";
import type { ClientOpResponse, ClientRoute } from "@loopycode/shared";

const DEFAULT_TIMEOUT_MS = 120_000;

const ERRORS = {
  NOT_CONNECTED: "Client not connected for this session",
  MALFORMED_RESPONSE: (route: string) => `Malformed response envelope from client: ${route}`,
  OPERATION_FAILED: (route: string) => `Client operation failed: ${route}`,
  TIMEOUT: "Client file operation timed out",
  EMPTY_RESPONSE: "Empty response from client",
};

/**
 * Sends operations to connected clients and awaits responses with timeout protection.
 *
 * @remarks
 * One instance per server session. Clients are identified by requesterId (session ID).
 * Abstracts JSON serialization and RSocket protocol handling from callers.
 */
export class ClientBridge {
  /**
   * Initializes the bridge with a peer lookup callback.
   *
   * @param getPeer - Called to retrieve RSocket for a session id.
   */
  constructor(
    private readonly getPeer: (requesterId: string) => RSocket | undefined,
  ) {}

  /**
   * Sends an operation request to a client and awaits the response.
   *
   * @remarks
   * Serializes the request as JSON, sends via RSocket with timeout protection,
   * deserializes the response, and extracts the result. Throws on timeout,
   * disconnection, or client error.
   *
   * @param requesterId - Session ID identifying the target client.
   * @param route - Operation name (e.g., "file.read").
   * @param payload - Operation parameters (route-specific shape).
   * @param timeoutMs - Timeout in milliseconds (default 120s).
   * @returns The operation result from the client response.
   * @throws When client is disconnected, response invalid, or timeout occurs.
   */
  request = async <T>(
    requesterId: string,
    route: ClientRoute,
    payload: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> => {
    const peer = this.getPeer(requesterId);
    if (!peer) {
      throw new Error(ERRORS.NOT_CONNECTED);
    }

    const body = Buffer.from(JSON.stringify({ route, payload }), "utf-8");
    const responseBuf = await this.requestResponseBuffer(
      peer,
      { data: body },
      timeoutMs,
    );

    return this.parseClientResponse<T>(responseBuf, route);
  };

  private parseClientResponse = <T>(buf: Buffer, route: ClientRoute): T => {
    const text = buf.toString("utf-8");
    const envelope = this.validateEnvelope(JSON.parse(text), route);
    if (!envelope.ok) {
      throw new Error(envelope.error ?? ERRORS.OPERATION_FAILED(route));
    }
    return envelope.data as T;
  };

  private validateEnvelope = (
    envelope: unknown,
    route: ClientRoute,
  ): ClientOpResponse<unknown> => {
    if (
      typeof envelope === "object" &&
      envelope !== null &&
      typeof (envelope as { ok?: unknown }).ok === "boolean"
    ) {
      return envelope as ClientOpResponse<unknown>;
    }
    throw new Error(ERRORS.MALFORMED_RESPONSE(route));
  };

  /**
   * Low-level RSocket request/response with timeout and settlement protection.
   *
   * @remarks
   * Wraps RSocket.requestResponse() with: timeout guard (rejects if no response),
   * buffer accumulation, and single-settlement guarantee (prevents race conditions
   * between onNext/onComplete/onError/timeout).
   *
   * @param rsocket - Active RSocket connection.
   * @param payload - Request payload (JSON encoded buffer).
   * @param timeoutMs - Timeout in milliseconds.
   * @returns Response data buffer.
   * @throws On timeout, peer error, or empty response.
   */
  private requestResponseBuffer = (
    rsocket: RSocket,
    payload: Payload,
    timeoutMs: number,
  ): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
      let buf: Buffer | undefined;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(ERRORS.TIMEOUT));
        }
      }, timeoutMs);

      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
          return;
        }
        if (buf && buf.length > 0) {
          resolve(buf);
        } else {
          reject(new Error(ERRORS.EMPTY_RESPONSE));
        }
      };

      rsocket.requestResponse(payload, {
        onNext: (response: Payload, isComplete: boolean) => {
          if (response.data && response.data.length > 0) {
            buf = response.data;
          }
          if (isComplete) {
            done();
          }
        },
        onComplete: () => done(),
        onError: (e: Error) => done(e),
        onExtension: () => {},
      });
    });
  };
}
