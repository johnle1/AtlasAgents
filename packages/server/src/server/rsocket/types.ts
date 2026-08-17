/**
 * Shared types and framing helpers used by the RSocket transport.
 *
 * @remarks
 * These are the small, reusable building blocks that
 * {@link RSocketServer} depends on: the responder/sink shapes it must return
 * to the RSocket core, the per-connection bookkeeping record, and the two pure
 * functions that translate between AtlasAgents's wire envelopes and raw
 * `Buffer`s.
 */

import type {
  OnExtensionSubscriber,
  OnNextSubscriber,
  OnTerminalSubscriber,
  RSocket,
} from "@rsocket/core";

/**
 * The subscriber a `requestResponse` handler pushes its single reply into.
 *
 * @remarks
 * Combines the three RSocket subscriber capabilities needed to answer a
 * one-shot request: `onNext` to send the payload, `onComplete`/`onError`
 * (from `OnTerminalSubscriber`) to close the interaction, and `onExtension`
 * for protocol extension frames. Call `onNext(payload, true)` to send the reply
 * and terminate in one step.
 */
export type RequestResponseResponder = OnTerminalSubscriber &
  OnNextSubscriber &
  OnExtensionSubscriber;

/**
 * The subscriber a `requestStream` handler pushes streamed frames into.
 *
 * @remarks
 * Structurally identical to {@link RequestResponseResponder}, but named
 * separately to signal intent: here `onNext(payload, false)` is called many
 * times for progressive frames, and the stream is ended once with either
 * `onComplete` (success) or `onError` (failure).
 */
export type RequestStreamSink = OnTerminalSubscriber &
  OnNextSubscriber &
  OnExtensionSubscriber;

/**
 * Per-connection state the server tracks for the lifetime of one session.
 *
 * @remarks
 * One record exists per accepted connection. When the connection closes, the
 * server iterates {@link SessionRecord.abortControllers} to cancel every
 * in-flight stream, preventing orphaned orchestration work.
 */
export type SessionRecord = {
  /**
   * The still-running streams for this connection.
   *
   * @remarks
   * A controller is added when a stream starts and removed when it settles.
   * All remaining controllers are aborted when the connection closes.
   */
  abortControllers: Set<AbortController>;

  /** The peer socket, used for lifecycle hooks and server→client frames. */
  remotePeer: RSocket;
};

/**
 * Encodes a command result into the JSON envelope the CLI client expects.
 *
 * @remarks
 * Produces the bytes for a single requestResponse PAYLOAD frame. The shape is
 * a discriminated union on `ok`:
 * - success → `{ ok: true, data }`
 * - failure → `{ ok: false, error }`
 *
 * On failure with no `error` supplied, the message defaults to
 * `"Command failed"`. `data` is ignored on the failure path and `error` is
 * ignored on the success path.
 *
 * @param ok - Whether the command succeeded. Selects which envelope shape is
 *   produced.
 * @param data - The success payload. Must be JSON-serializable. Only included
 *   when `ok` is `true`; omit it (or pass `undefined`) for failures.
 * @param error - Human-readable failure message. Only used when `ok` is
 *   `false`; defaults to `"Command failed"` if omitted.
 * @returns UTF-8 JSON bytes ready to send as one PAYLOAD frame.
 *
 * @example
 * ```ts
 * // Success
 * stream.onNext({ data: commandResponseBuffer(true, { models: [] }) }, true);
 *
 * // Failure
 * stream.onNext(
 *   { data: commandResponseBuffer(false, undefined, "Unauthorized") },
 *   true,
 * );
 * ```
 */
export const commandResponseBuffer = (
  ok: boolean,
  data?: unknown,
  error?: string,
): Buffer => {
  if (ok) {
    return Buffer.from(JSON.stringify({ ok: true, data }), "utf-8");
  }
  return Buffer.from(
    JSON.stringify({ ok: false, error: error ?? "Command failed" }),
    "utf-8",
  );
};

/**
 * Extracts the auth password from an RSocket frame's metadata.
 *
 * @remarks
 * Metadata is expected to be UTF-8 JSON of the form `{ "password": "..." }`.
 * This function is deliberately forgiving: any problem — missing metadata,
 * empty buffer, invalid JSON, or a non-string `password` — yields an empty
 * string rather than throwing. Callers pass the result to
 * {@link AuthMiddleware.validate}, which is responsible for treating an empty
 * password as unauthenticated.
 *
 * @param metadata - The frame metadata bytes, or `null`/`undefined` when the
 *   client sent none.
 * @returns The password string, or `""` when it cannot be read.
 *
 * @example
 * ```ts
 * const password = parsePasswordFromMetadata(payload.metadata);
 * const userId = auth.validate(password); // null when unauthorized
 * ```
 */
export const parsePasswordFromMetadata = (
  metadata: Buffer | null | undefined,
): string => {
  if (!metadata || metadata.length === 0) {
    return "";
  }
  try {
    const parsed = JSON.parse(metadata.toString("utf-8")) as {
      password?: unknown;
    };
    return typeof parsed.password === "string" ? parsed.password : "";
  } catch {
    return "";
  }
};

/**
 * Strategy the server uses to authenticate each incoming frame.
 *
 * @remarks
 * Authentication is per-frame: the server calls `validate` with the password
 * pulled from every command and stream frame's metadata (see
 * {@link parsePasswordFromMetadata}). Returning `null` rejects the request;
 * returning a user id accepts it and that id is threaded through to handlers as
 * `session.userId`.
 *
 * @example
 * ```ts
 * const auth: AuthMiddleware = {
 *   validate: (password) => (password === serverSecret ? "user_1" : null),
 * };
 * ```
 */
export type AuthMiddleware = {
  /**
   * Validates a password and resolves it to a user identity.
   *
   * @param password - The raw password from frame metadata; `""` when none was
   *   provided.
   * @returns The authenticated user id, or `null` to reject the request as
   *   unauthorized.
   */
  validate: (password: string) => string | null;
};
