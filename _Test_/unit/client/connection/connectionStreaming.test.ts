/**
 * Unit tests — connection/streaming.ts
 */

import { describe, expect, it, vi } from "vitest";
import type { Payload, RSocket } from "@rsocket/core";
import {
  sendStream,
  sendTask,
  streamRequest,
  STREAM_WINDOW,
} from "../../../../packages/client/src/connection/streaming.js";
import type { Config } from "../../../../packages/client/src/config/index.js";

const meta = Buffer.from("{}");

const encodeFrame = (obj: Record<string, unknown>): Buffer =>
  Buffer.from(JSON.stringify(obj), "utf8");

type StreamCallbacks = {
  onNext: (p: Payload, isComplete: boolean) => void;
  onComplete: () => void;
  onError: (e: Error) => void;
  request: ReturnType<typeof vi.fn>;
};

const mockStreamRsocket = (
  setup: (callbacks: StreamCallbacks) => void,
): RSocket => {
  const request = vi.fn();
  return {
    requestStream: (
      _payload: Payload,
      initialRequestN: number,
      callbacks: Omit<StreamCallbacks, "request">,
    ) => {
      expect(initialRequestN).toBe(STREAM_WINDOW);
      setup({ ...callbacks, request });
      return { request };
    },
  } as unknown as RSocket;
};

describe("streamRequest", () => {
  it("invokes onFrame and onToken in order", async () => {
    const frames: string[] = [];
    const tokens: string[] = [];
    const rsocket = mockStreamRsocket(({ onNext, onComplete }) => {
      onNext({ data: encodeFrame({ kind: "token", text: "hi" }) }, false);
      onNext({ data: encodeFrame({ kind: "done" }) }, true);
      onComplete();
    });

    await streamRequest(
      rsocket,
      { kind: "explore" },
      meta,
      async (frame) => {
        frames.push(frame.kind);
      },
      (token) => tokens.push(token),
    ).done;

    expect(tokens).toEqual(["hi"]);
    expect(frames).toEqual(["token", "done"]);
  });

  it("rejects when onError fires", async () => {
    const rsocket = mockStreamRsocket(({ onError }) => {
      onError(new Error("stream failed"));
    });
    await expect(
      streamRequest(rsocket, { kind: "explore" }, meta, () => {}).done,
    ).rejects.toThrow("stream failed");
  });
});

const minimalConfig = {
  server: "localhost",
  port: 7000,
  password: "",
  subagentModel: "m1",
  subsubagentModel: "m2",
  subagentCap: 3,
  agentProvider: "ollama",
  subagentProvider: "ollama",
  agentTemp: 0,
  subagentTemp: 0.4,
  retries: 3,
  timeout: 5000,
  workspace: "",
  ui: { theme: "default" },
} as Config;

describe("sendTask", () => {
  it("builds a task body from config", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const rsocket = {
      requestStream: (payload: Payload, initialRequestN: number, callbacks: {
        onComplete: () => void;
      }) => {
        expect(initialRequestN).toBe(STREAM_WINDOW);
        capturedBody = JSON.parse(payload.data!.toString("utf8"));
        callbacks.onComplete();
        return { request: vi.fn() };
      },
    } as unknown as RSocket;

    await sendTask(
      "do work",
      minimalConfig,
      meta,
      rsocket,
      () => {},
      undefined,
      2,
    ).done;

    expect(capturedBody).toMatchObject({
      kind: "task",
      text: "do work",
      maxSubagents: 2,
      subagentModel: "m1",
    });
  });

  it("includes approvalMode on the task payload when provided (normal)", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const rsocket = {
      requestStream: (payload: Payload, _n: number, callbacks: {
        onComplete: () => void;
      }) => {
        capturedBody = JSON.parse(payload.data!.toString("utf8"));
        callbacks.onComplete();
        return { request: vi.fn() };
      },
    } as unknown as RSocket;

    await sendTask(
      "do work",
      minimalConfig,
      meta,
      rsocket,
      () => {},
      undefined,
      2,
      "plan",
    ).done;

    expect(capturedBody).toMatchObject({
      kind: "task",
      approvalMode: "plan",
    });
  });
});

describe("sendStream", () => {
  it("flattens models.pull name into the body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const rsocket = {
      requestStream: (payload: Payload, _n: number, callbacks: { onComplete: () => void }) => {
        capturedBody = JSON.parse(payload.data!.toString("utf8"));
        callbacks.onComplete();
        return { request: vi.fn() };
      },
    } as unknown as RSocket;

    await sendStream(
      {
        kind: "models.pull",
        payload: { name: "gemma:4b" },
        onFrame: () => {},
      },
      meta,
      rsocket,
    ).done;
    expect(capturedBody).toEqual({ kind: "models.pull", name: "gemma:4b" });
  });

  it("sends explore kind for explore streams", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const rsocket = {
      requestStream: (payload: Payload, _n: number, callbacks: { onComplete: () => void }) => {
        capturedBody = JSON.parse(payload.data!.toString("utf8"));
        callbacks.onComplete();
        return { request: vi.fn() };
      },
    } as unknown as RSocket;

    await sendStream(
      { kind: "explore", onFrame: () => {} },
      meta,
      rsocket,
    ).done;
    expect(capturedBody).toEqual({ kind: "explore" });
  });
});
