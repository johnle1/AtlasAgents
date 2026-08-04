/**
 * Unit tests — RSocket request/response and stream handlers
 */

import { describe, expect, it, vi } from "vitest";
import {
  createRequestResponseHandler,
  runRequestResponse,
} from "../../../../packages/server/src/server/rsocket/handlers/requestResponse.js";
import { createRequestStreamHandler } from "../../../../packages/server/src/server/rsocket/handlers/requestStream.js";
import { noopStreamSubscriber } from "../../../../packages/server/src/server/rsocket/handlers/utils.js";
import type {
  AuthMiddleware,
  SessionRecord,
} from "../../../../packages/server/src/server/rsocket/types.js";

const authOk: AuthMiddleware = {
  validate: (password) => (password === "secret" ? "user-1" : null),
};

/** A responder stub with every subscriber method RSocket requires. */
const fakeResponder = () => ({
  onNext: vi.fn(),
  onError: vi.fn(),
  onComplete: vi.fn(),
  onExtension: vi.fn(),
});

describe("noopStreamSubscriber", () => {
  it("returns no-op request, cancel, and onExtension", () => {
    const sub = noopStreamSubscriber();
    expect(() => sub.request(1)).not.toThrow();
    expect(() => sub.cancel()).not.toThrow();
    expect(() => sub.onExtension(0, null, true)).not.toThrow();
  });
});

describe("runRequestResponse", () => {
  it("rejects unauthorized requests with a terminal error frame", async () => {
    const stream = fakeResponder();
    const router = { routeCommand: vi.fn() };

    await runRequestResponse(
      authOk,
      router as never,
      "req-1",
      {
        data: Buffer.from(JSON.stringify({ kind: "command", type: "ping" })),
        metadata: Buffer.from(JSON.stringify({ password: "wrong" })),
      },
      stream,
    );

    expect(stream.onNext).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(stream.onNext.mock.calls[0]![0].data.toString("utf8"));
    expect(payload).toEqual({ ok: false, error: "Unauthorized" });
    expect(router.routeCommand).not.toHaveBeenCalled();
  });

  it("routes a valid command and returns ok data", async () => {
    const stream = fakeResponder();
    const router = {
      routeCommand: vi.fn().mockResolvedValue({ pong: true }),
    };

    await runRequestResponse(
      authOk,
      router as never,
      "req-1",
      {
        data: Buffer.from(
          JSON.stringify({ kind: "command", type: "models.list", payload: {} }),
        ),
        metadata: Buffer.from(JSON.stringify({ password: "secret" })),
      },
      stream,
    );

    const payload = JSON.parse(stream.onNext.mock.calls[0]![0].data.toString("utf8"));
    expect(payload).toEqual({ ok: true, data: { pong: true } });
    expect(router.routeCommand).toHaveBeenCalledWith(
      { userId: "user-1", requesterId: "req-1" },
      "models.list",
      {},
    );
  });
});

describe("createRequestResponseHandler", () => {
  it("returns a cancellable handle", () => {
    const handler = createRequestResponseHandler(authOk, { routeCommand: vi.fn() } as never);
    const handle = handler(
      "req-1",
      {
        data: Buffer.from("{}"),
        metadata: Buffer.from(JSON.stringify({ password: "secret" })),
      },
      fakeResponder(),
    );
    expect(typeof handle.cancel).toBe("function");
    expect(typeof handle.onExtension).toBe("function");
  });
});

describe("createRequestStreamHandler", () => {
  it("errors on failed auth and returns noop subscriber", () => {
    const handler = createRequestStreamHandler(authOk, { routeStream: vi.fn() } as never);
    const stream = fakeResponder();
    // The auth-failure path never reaches remotePeer, so a bare stub is enough.
    const record: SessionRecord = {
      abortControllers: new Set<AbortController>(),
      remotePeer: {} as SessionRecord["remotePeer"],
    };

    const sub = handler(
      "req-1",
      record,
      {
        data: Buffer.from(JSON.stringify({ kind: "task", text: "hi" })),
        metadata: Buffer.from(JSON.stringify({ password: "nope" })),
      },
      stream,
    );

    expect(stream.onError).toHaveBeenCalledWith(expect.any(Error));
    expect(() => sub.cancel()).not.toThrow();
  });
});
