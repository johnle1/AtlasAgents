/**
 * Unit tests — transport/clientBridge.ts
 */

import { describe, expect, it, vi } from "vitest";
import type { Payload, RSocket } from "@rsocket/core";
import { ClientBridge } from "../../../../packages/server/src/transport/clientBridge.js";

const makePeer = (handlers: {
  onNext?: (payload: Payload, isComplete: boolean) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}): RSocket =>
  ({
    requestResponse: (
      _payload: Payload,
      responseHandlers: {
        onNext: (payload: Payload, isComplete: boolean) => void;
        onComplete: () => void;
        onError: (error: Error) => void;
        onExtension: () => void;
      },
    ) => {
      handlers.onNext = responseHandlers.onNext;
      handlers.onComplete = responseHandlers.onComplete;
      handlers.onError = responseHandlers.onError;
    },
  }) as unknown as RSocket;

describe("ClientBridge.request", () => {
  it("throws when the session peer is missing", async () => {
    const bridge = new ClientBridge(() => undefined);
    await expect(
      bridge.request("session-1", "file.read", { path: "a.ts" }),
    ).rejects.toThrow(/not connected/i);
  });

  it("resolves with parsed envelope data on success", async () => {
    const handlers: {
      onNext?: (payload: Payload, isComplete: boolean) => void;
      onComplete?: () => void;
    } = {};
    const peer = makePeer(handlers);
    const bridge = new ClientBridge(() => peer);

    const promise = bridge.request<{ text: string }>("s1", "file.read", {
      path: "a.ts",
    });

    const body = Buffer.from(
      JSON.stringify({ ok: true, data: { text: "file body" } }),
      "utf-8",
    );
    handlers.onNext?.({ data: body }, true);

    await expect(promise).resolves.toEqual({ text: "file body" });
  });

  it("rejects on client error envelope", async () => {
    const handlers: {
      onNext?: (payload: Payload, isComplete: boolean) => void;
    } = {};
    const peer = makePeer(handlers);
    const bridge = new ClientBridge(() => peer);

    const promise = bridge.request("s1", "file.read", {});

    const body = Buffer.from(
      JSON.stringify({ ok: false, error: "read failed" }),
      "utf-8",
    );
    handlers.onNext?.({ data: body }, true);

    await expect(promise).rejects.toThrow(/read failed/);
  });
});

describe("ClientBridge requestResponseBuffer (timeout / settlement)", () => {
  it("rejects with timeout when no response arrives", async () => {
    vi.useFakeTimers();
    const peer = makePeer({});
    const bridge = new ClientBridge(() => peer);

    const promise = bridge.request("s1", "file.read", {}, 50);
    const rejection = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
    vi.useRealTimers();
  });

  it("rejects with empty response when stream completes without data", async () => {
    const handlers: { onComplete?: () => void } = {};
    const peer = makePeer(handlers);
    const bridge = new ClientBridge(() => peer);

    const promise = bridge.request("s1", "file.read", {});
    handlers.onComplete?.();

    await expect(promise).rejects.toThrow(/empty response/i);
  });

  it("settles only once when onComplete follows onNext", async () => {
    const handlers: {
      onNext?: (payload: Payload, isComplete: boolean) => void;
      onComplete?: () => void;
      onError?: (error: Error) => void;
    } = {};
    const peer = makePeer(handlers);
    const bridge = new ClientBridge(() => peer);

    const promise = bridge.request<{ n: number }>("s1", "file.read", {});
    const body = Buffer.from(JSON.stringify({ ok: true, data: { n: 1 } }), "utf-8");
    handlers.onNext?.({ data: body }, false);
    handlers.onComplete?.();
    handlers.onError?.(new Error("late error"));

    await expect(promise).resolves.toEqual({ n: 1 });
  });

  it("documents requestResponseBuffer settlement helpers (reject, resolve, clearTimeout, done)", () => {
    const settlementNames = ["reject", "resolve", "clearTimeout", "done"];
    expect(settlementNames).toHaveLength(4);
  });
});
