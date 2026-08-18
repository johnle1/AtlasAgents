/**
 * Integration tests — RSocket requestStream cancel → AbortSignal
 *
 * Wires the real `createRequestStreamHandler` to a stub Router whose
 * `routeStream` never settles. Calling the returned handle's `cancel()`
 * must abort the signal passed into `routeStream` and must not emit an
 * error frame for the abort itself (a cancelled stream is not a failure).
 *
 * Category checklist:
 * - Happy path: cancel aborts the signal the router received
 * - Failure propagation: abort does not emit a kind:"error" frame
 * - State integrity: abortControllers set is cleaned up after cancel
 */

import { describe, expect, it, vi } from "vitest";
import { createRequestStreamHandler } from "../../../packages/server/src/server/rsocket/handlers/requestStream.js";
import type {
  AuthMiddleware,
  SessionRecord,
} from "../../../packages/server/src/server/rsocket/types.js";

const authOk: AuthMiddleware = {
  validate: (password) => (password === "secret" ? "user-1" : null),
};

const fakeResponder = () => ({
  onNext: vi.fn(),
  onError: vi.fn(),
  onComplete: vi.fn(),
  onExtension: vi.fn(),
});

const waitMicrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe("requestStream cancel → AbortSignal (integration)", () => {
  it("aborts the signal passed to routeStream when the handle is cancelled (happy path)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const routeStream = vi.fn(
      (
        _session: unknown,
        _kind: unknown,
        _payload: unknown,
        _emit: unknown,
        signal: AbortSignal,
      ) => {
        capturedSignal = signal;
        return new Promise<void>(() => {
          // Never settles — the test cancels instead.
        });
      },
    );

    const handler = createRequestStreamHandler(authOk, {
      routeStream,
    } as never);
    const stream = fakeResponder();
    const record: SessionRecord = {
      abortControllers: new Set<AbortController>(),
      remotePeer: {} as SessionRecord["remotePeer"],
    };

    const handle = handler(
      "req-1",
      record,
      {
        data: Buffer.from(JSON.stringify({ kind: "task", text: "hi" })),
        metadata: Buffer.from(JSON.stringify({ password: "secret" })),
      },
      stream,
    );

    await waitMicrotask();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    handle.cancel();

    expect(capturedSignal!.aborted).toBe(true);
  });

  it("does not emit an error frame for the abort itself (failure-propagation contract)", async () => {
    const routeStream = vi.fn(
      async (
        _session: unknown,
        _kind: unknown,
        _payload: unknown,
        _emit: unknown,
        signal: AbortSignal,
      ) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      },
    );

    const handler = createRequestStreamHandler(authOk, {
      routeStream,
    } as never);
    const stream = fakeResponder();
    const record: SessionRecord = {
      abortControllers: new Set<AbortController>(),
      remotePeer: {} as SessionRecord["remotePeer"],
    };

    const handle = handler(
      "req-1",
      record,
      {
        data: Buffer.from(JSON.stringify({ kind: "task", text: "hi" })),
        metadata: Buffer.from(JSON.stringify({ password: "secret" })),
      },
      stream,
    );

    await waitMicrotask();
    handle.cancel();
    await waitMicrotask();

    expect(stream.onError).not.toHaveBeenCalled();
    const errorFrames = stream.onNext.mock.calls.filter((call) => {
      const payload = JSON.parse(call[0].data.toString("utf8")) as {
        kind?: string;
      };
      return payload.kind === "error";
    });
    expect(errorFrames).toEqual([]);
  });

  it("releases the AbortController from the session record after cancel (state integrity)", async () => {
    const routeStream = vi.fn(
      async (
        _session: unknown,
        _kind: unknown,
        _payload: unknown,
        _emit: unknown,
        signal: AbortSignal,
      ) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      },
    );

    const handler = createRequestStreamHandler(authOk, {
      routeStream,
    } as never);
    const stream = fakeResponder();
    const record: SessionRecord = {
      abortControllers: new Set<AbortController>(),
      remotePeer: {} as SessionRecord["remotePeer"],
    };

    const handle = handler(
      "req-1",
      record,
      {
        data: Buffer.from(JSON.stringify({ kind: "task", text: "hi" })),
        metadata: Buffer.from(JSON.stringify({ password: "secret" })),
      },
      stream,
    );

    await waitMicrotask();
    expect(record.abortControllers.size).toBe(1);

    handle.cancel();
    await waitMicrotask();

    expect(record.abortControllers.size).toBe(0);
  });
});
