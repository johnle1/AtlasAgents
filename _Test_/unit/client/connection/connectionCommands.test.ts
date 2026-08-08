/**
 * Unit tests — connection/commands.ts request/response helpers.
 */

import { describe, expect, it, vi } from "vitest";
import type { Payload, RSocket } from "@rsocket/core";
import {
  clearMemory,
  fetchModels,
  fetchModelsDetailed,
  forgetMemory,
  getMemory,
  requestResponseBuffer,
  respondPlan,
  sendCommand,
  syncSkills,
} from "../../../../packages/client/src/connection/commands.js";

const meta = Buffer.from(JSON.stringify({ password: "p" }));

const mockRsocket = (
  handler: (payload: Payload, callbacks: {
    onNext: (p: Payload, isComplete: boolean) => void;
    onComplete: () => void;
    onError: (e: Error) => void;
  }) => void,
): RSocket =>
  ({
    requestResponse: (payload: Payload, callbacks: {
      onNext: (p: Payload, isComplete: boolean) => void;
      onComplete: () => void;
      onError: (e: Error) => void;
    }) => {
      handler(payload, callbacks);
    },
  }) as unknown as RSocket;

describe("requestResponseBuffer", () => {
  it("concatenates chunks and resolves on isComplete", async () => {
    const rsocket = mockRsocket((_payload, { onNext }) => {
      onNext({ data: Buffer.from('{"part":1') }, false);
      onNext({ data: Buffer.from(',"ok":true}') }, true);
    });
    const buf = await requestResponseBuffer(rsocket, { data: Buffer.from("{}") });
    expect(buf.toString("utf8")).toBe('{"part":1,"ok":true}');
  });

  it("rejects empty responses", async () => {
    const rsocket = mockRsocket((_payload, { onComplete }) => {
      onComplete();
    });
    await expect(
      requestResponseBuffer(rsocket, { data: Buffer.from("{}") }),
    ).rejects.toThrow("Empty response from server");
  });

  it("rejects on onError", async () => {
    const rsocket = mockRsocket((_payload, { onError }) => {
      onError(new Error("peer reset"));
    });
    await expect(
      requestResponseBuffer(rsocket, { data: Buffer.from("{}") }),
    ).rejects.toThrow("peer reset");
  });
});

describe("sendCommand", () => {
  it("returns data when ok is true", async () => {
    const body = JSON.stringify({ ok: true, data: { value: 42 } });
    const rsocket = mockRsocket((_payload, { onNext }) => {
      onNext({ data: Buffer.from(body) }, true);
    });
    const data = await sendCommand<{ value: number }>(
      rsocket,
      "session.exists",
      {},
      meta,
    );
    expect(data).toEqual({ value: 42 });
  });

  it("throws when ok is false", async () => {
    const body = JSON.stringify({ ok: false, error: "nope" });
    const rsocket = mockRsocket((_payload, { onNext }) => {
      onNext({ data: Buffer.from(body) }, true);
    });
    await expect(
      sendCommand(rsocket, "memory.get", {}, meta),
    ).rejects.toThrow("nope");
  });

  it("throws on malformed envelope", async () => {
    const rsocket = mockRsocket((_payload, { onNext }) => {
      onNext({ data: Buffer.from('{"unexpected":true}') }, true);
    });
    await expect(
      sendCommand(rsocket, "memory.get", {}, meta),
    ).rejects.toThrow("Malformed response envelope");
  });
});

describe("fetchModelsDetailed / fetchModels", () => {
  it("filters models without names", async () => {
    const body = JSON.stringify({
      ok: true,
      data: {
        models: [
          { name: "good" },
          { name: "" },
          { size: 1 },
        ],
      },
    });
    const rsocket = mockRsocket((_payload, { onNext }) => {
      onNext({ data: Buffer.from(body) }, true);
    });
    const detailed = await fetchModelsDetailed(rsocket, meta);
    expect(detailed).toEqual([{ name: "good" }]);
    const names = await fetchModels(rsocket, meta);
    expect(names).toEqual(["good"]);
  });

  it("throws when models is not an array", async () => {
    const body = JSON.stringify({ ok: true, data: { models: null } });
    const rsocket = mockRsocket((_payload, { onNext }) => {
      onNext({ data: Buffer.from(body) }, true);
    });
    await expect(fetchModelsDetailed(rsocket, meta)).rejects.toThrow(
      "Invalid models.list response",
    );
  });
});

describe("memory and skills commands", () => {
  const okEnvelope = (data: unknown) =>
    JSON.stringify({ ok: true, data });

  it("syncSkills sends skills.sync", async () => {
    const requestResponse = vi.fn(
      (_payload: Payload, callbacks: { onNext: (p: Payload, c: boolean) => void }) => {
        callbacks.onNext(
          { data: Buffer.from(okEnvelope({})) },
          true,
        );
      },
    );
    const rsocket = { requestResponse } as unknown as RSocket;
    await syncSkills(rsocket, meta, [{ name: "x", content: "# x" }]);
    const sent = JSON.parse(
      requestResponse.mock.calls[0]![0].data!.toString("utf8"),
    );
    expect(sent).toMatchObject({
      kind: "command",
      type: "skills.sync",
      payload: { skills: [{ name: "x", content: "# x" }] },
    });
  });

  it("getMemory returns entries or empty array", async () => {
    const rsocket = mockRsocket((_payload, { onNext }) => {
      onNext(
        {
          data: Buffer.from(
            okEnvelope({ entries: [{ topic: "t", rules: ["r"] }] }),
          ),
        },
        true,
      );
    });
    const entries = await getMemory(rsocket, meta);
    expect(entries).toEqual([{ topic: "t", rules: ["r"] }]);

    const emptyRsocket = mockRsocket((_payload, { onNext }) => {
      onNext({ data: Buffer.from(okEnvelope({})) }, true);
    });
    expect(await getMemory(emptyRsocket, meta)).toEqual([]);
  });

  it("forgetMemory and clearMemory succeed", async () => {
    const rsocket = mockRsocket((_payload, { onNext }) => {
      onNext({ data: Buffer.from(okEnvelope({})) }, true);
    });
    await expect(forgetMemory(rsocket, meta, "topic-a")).resolves.toBeUndefined();
    await expect(clearMemory(rsocket, meta)).resolves.toBeUndefined();
  });

  it("respondPlan sends plan.respond payload", async () => {
    const requestResponse = vi.fn(
      (_payload: Payload, callbacks: { onNext: (p: Payload, c: boolean) => void }) => {
        callbacks.onNext({ data: Buffer.from(okEnvelope({})) }, true);
      },
    );
    const rsocket = { requestResponse } as unknown as RSocket;
    await respondPlan(rsocket, meta, "plan-1", "edit", "more tests");
    const sent = JSON.parse(
      requestResponse.mock.calls[0]![0].data!.toString("utf8"),
    );
    expect(sent.payload).toEqual({
      id: "plan-1",
      decision: "edit",
      feedback: "more tests",
    });
  });
});
