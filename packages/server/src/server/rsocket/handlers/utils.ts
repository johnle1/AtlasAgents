/**
 * Shared utilities for RSocket request/stream handlers.
 */

import type { Cancellable, OnExtensionSubscriber, Requestable } from "@rsocket/core";

/**
 * Builds an inert requestStream subscriber that ignores all client signals.
 *
 * @remarks
 * RSocket requires every `requestStream` handler to return a subscriber, even
 * when the request is rejected before any work begins (failed auth, malformed
 * JSON body, or an unrecognized stream kind). In those cases the error has
 * already been delivered via `onError`, so there is nothing left to
 * `request`, `cancel`, or extend — this stub satisfies the interface without
 * side effects.
 *
 * @returns A subscriber whose `request`, `cancel`, and `onExtension` methods
 *   are all no-ops.
 */
export const noopStreamSubscriber = (): Requestable &
  Cancellable &
  OnExtensionSubscriber => ({
  request: () => {},
  cancel: () => {},
  onExtension: () => {},
});
