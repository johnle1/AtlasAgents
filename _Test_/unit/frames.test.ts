/**
 * Unit tests — packages/shared/src/frames.ts
 */

import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  type TaskFrame,
} from "@loopycode/shared";

const roundTrip = (frame: TaskFrame): TaskFrame | null =>
  decodeFrame(encodeFrame(frame));

describe("encodeFrame / decodeFrame round-trip", () => {
  it("token frame", () => {
    expect(roundTrip({ kind: "token", text: "hello" })).toEqual({
      kind: "token",
      text: "hello",
    });
  });

  it("think frame (advisor)", () => {
    expect(
      roundTrip({ kind: "think", text: "hmm", advisor: true }),
    ).toEqual({ kind: "think", text: "hmm", advisor: true });
  });

  it("think frame (non-advisor)", () => {
    expect(roundTrip({ kind: "think", text: "hmm" })).toEqual({
      kind: "think",
      text: "hmm",
    });
  });

  it("confirm-plan frame", () => {
    const frame: TaskFrame = {
      kind: "confirm-plan",
      id: "plan-1",
      task: "build feature",
      steps: ["step 1"],
      risks: ["risk"],
      agents: [{ id: 1, label: "A", steps: ["s"], dependsOn: [] }],
      agentCount: 1,
      execution: "sequential",
      modeLabel: "focus",
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("status frame (advisor)", () => {
    const frame: TaskFrame = {
      kind: "status",
      source: "advisor",
      stage: "understanding",
      icon: "◌",
      message: "thinking",
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("status frame (agent)", () => {
    const frame: TaskFrame = {
      kind: "status",
      source: { agentId: 1, agentLabel: "worker" },
      stage: "running",
      icon: "◌",
      message: "",
      activity: { stage: "reading", message: "Reading file" },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("progress frame", () => {
    const frame: TaskFrame = {
      kind: "progress",
      data: { status: "pulling", completed: 1, total: 3 },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("error frame", () => {
    expect(roundTrip({ kind: "error", message: "boom" })).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("done frame", () => {
    expect(roundTrip({ kind: "done" })).toEqual({ kind: "done" });
  });
});

describe("decodeFrame edge cases", () => {
  it("returns null for empty buffer", () => {
    expect(decodeFrame(Buffer.from(""))).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(decodeFrame(undefined)).toBeNull();
  });

  it("falls back to token frame for malformed JSON with text", () => {
    expect(decodeFrame(Buffer.from("not-json"))).toEqual({
      kind: "token",
      text: "not-json",
    });
  });

  it("returns null for valid JSON without kind field", () => {
    expect(decodeFrame(Buffer.from('{"foo":1}'))).toBeNull();
  });
});
