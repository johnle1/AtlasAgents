/**
 * Small helpers shared by Connection and command/stream senders.
 *
 * @remarks
 * Keeps auth serialization and “must have a live socket” checks in one place
 * so every RSocket call attaches the same metadata and fails the same way when
 * disconnected.
 */

import type { RSocket } from "@rsocket/core";
import type { Config } from "../config/index.js";

/**
 * Builds the authentication metadata Buffer attached to RSocket payloads.
 *
 * @remarks
 * The server expects a UTF-8 JSON object `{ password: string }` in the
 * metadata of requestResponse / requestStream frames. An unset password
 * becomes `""` so the JSON shape stays stable (the server can still reject
 * empty credentials).
 *
 * @param config - Client config; only `password` is read.
 * @returns UTF-8 Buffer of `JSON.stringify({ password })`.
 *
 * @example
 * ```ts
 * const metadata = authMetadata({ password: "secret123" } as Config);
 * // metadata.toString("utf-8") === '{"password":"secret123"}'
 * ```
 */
export const authMetadata = (config: Config): Buffer => {
  // Always emit a string field so server JSON schemas do not see `null`/`undefined`.
  const password = config.password ?? "";
  return Buffer.from(JSON.stringify({ password }), "utf-8");
};

/**
 * Narrows a nullable RSocket to a live instance or throws.
 *
 * @remarks
 * Prefer calling this immediately before issuing RSocket APIs so TypeScript
 * and runtime agree the socket exists. Does not attempt reconnect — callers
 * that need auto-connect should use `Connection` public methods (which call
 * `waitUntilConnected` first).
 *
 * @param rsocket - Live connection, or `null` when disconnected.
 * @returns The same non-null `RSocket`.
 * @throws {@link Error} With message `"RSocket is not connected"` when `rsocket` is `null`.
 *
 * @example
 * ```ts
 * const live = requireSocket(connectionSocketOrNull);
 * live.requestResponse(payload, handlers);
 * ```
 */
export const requireSocket = (rsocket: RSocket | null): RSocket => {
  if (!rsocket) {
    throw new Error("RSocket is not connected");
  }
  return rsocket;
};
