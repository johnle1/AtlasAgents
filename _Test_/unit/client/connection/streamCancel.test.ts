/**
 * Unit tests — connection/streaming.ts cancel handle
 *
 * `streamRequest` returns `{ done, cancel }` instead of a bare Promise so the
 * UI can abort an in-flight task without treating the abort as an error.
 *
 * Category checklist:
 * - Normal: cancel() invokes the RSocket requester's cancel and done resolves
 * - Boundary: cancel after the stream already completed is a no-op
 * - Error: onError still rejects done when the user did not cancel
 */

import { describe, expect, it, vi } from "vitest";
import type { Payload, RSocket } from "@rsocket/core";
import {
  STREAM_WINDOW,
  streamRequest,
} from "../../../../packages/client/src/connection/streaming.js";

const meta = Buffer.from("{}");

type StreamCallbacks = {
  onNext: (p: Payload, isComplete: boolean) => void;
  onComplete: () => void;
  onError: (e: Error) => void;
};

const mockStreamRsocket = (
  setup: (callbacks: StreamCallbacks, requester: { cancel: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> }) => void,
): RSocket => {
  const request = vi.fn();
  const cancel = vi.fn();
  return {
    requestStream: (
      _payload: Payload,
      initialRequestN: number,
      callbacks: Omit<StreamCallbacks, "request">,
    ) => {
      expect(initialRequestN).toBe(STREAM_WINDOW);
      const requester = { request, cancel };
      setup(callbacks, requester);
      return requester;
    },
  } as unknown as RSocket;
};

describe("streamRequest — cancel handle", () => {
  it("returns { done, cancel }; cancel() calls requester.cancel and done resolves (normal)", async () => {
    let capturedCancel: ReturnType<typeof vi.fn> | undefined;
    const rsocket = mockStreamRsocket((_callbacks, requester) => {
      capturedCancel = requester.cancel;
      // Stream stays open — the test cancels it.
    });

    const handle = streamRequest(rsocket, { kind: "task" }, meta, () => {});

    expect(typeof handle.cancel).toBe("function");
    expect(handle.done).toBeInstanceOf(Promise);

    handle.cancel();

    await expect(handle.done).resolves.toBeUndefined();
    expect(capturedCancel).toHaveBeenCalledOnce();
  });

  it("does not reject done when the user cancels (normal — cancelled is not an error)", async () => {
    const rsocket = mockStreamRsocket(() => {});
    const handle = streamRequest(rsocket, { kind: "explore" }, meta, () => {});

    handle.cancel();

    await expect(handle.done).resolves.toBeUndefined();
  });

  it("ignores a second cancel after the stream already completed (boundary)", async () => {
    const rsocket = mockStreamRsocket(({ onComplete }, requester) => {
      onComplete();
      // Capture so we can assert cancel is still callable after settle.
      void requester;
    });

    const handle = streamRequest(rsocket, { kind: "explore" }, meta, () => {});
    await handle.done;

    expect(() => handle.cancel()).not.toThrow();
    await expect(handle.done).resolves.toBeUndefined();
  });

  it("still rejects done when onError fires and the user did not cancel (error)", async () => {
    const rsocket = mockStreamRsocket(({ onError }) => {
      onError(new Error("stream failed"));
    });

    const handle = streamRequest(rsocket, { kind: "explore" }, meta, () => {});
    await expect(handle.done).rejects.toThrow("stream failed");
  });
});
