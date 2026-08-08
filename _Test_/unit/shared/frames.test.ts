/**
 * Unit tests — packages/shared/src/types/frames.ts
 */

import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, type TaskFrame } from "@loopycode/shared";

const roundTrip = (frame: TaskFrame): TaskFrame | null =>
  decodeFrame(encodeFrame(frame));

describe("encodeFrame / decodeFrame round-trip", () => {
  it("token frame", () => {
    expect(roundTrip({ kind: "token", text: "hello" })).toEqual({
      kind: "token",
      text: "hello",
    });
  });

  it("think-start frame (agent, no source)", () => {
    expect(roundTrip({ kind: "think-start", id: "think-1", agent: true })).toEqual({
      kind: "think-start",
      id: "think-1",
      agent: true,
    });
  });

  it("think-start frame (subagent, with source)", () => {
    const frame: TaskFrame = {
      kind: "think-start",
      id: "think-2",
      agent: false,
      source: { agentId: 2, agentLabel: "worker" },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("think-delta frame", () => {
    expect(
      roundTrip({ kind: "think-delta", id: "think-1", text: "reasoning…" }),
    ).toEqual({
      kind: "think-delta",
      id: "think-1",
      text: "reasoning…",
    });
  });

  it("think-end frame (with final text)", () => {
    expect(
      roundTrip({ kind: "think-end", id: "think-1", text: "final" }),
    ).toEqual({
      kind: "think-end",
      id: "think-1",
      text: "final",
    });
  });

  it("think-end frame (no final text)", () => {
    expect(roundTrip({ kind: "think-end", id: "think-1" })).toEqual({
      kind: "think-end",
      id: "think-1",
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

  it("status frame (agent)", () => {
    const frame: TaskFrame = {
      kind: "status",
      source: "agent",
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

  it("warning frame", () => {
    expect(
      roundTrip({ kind: "warning", message: "gemma3:27b is running 52% on GPU" }),
    ).toEqual({
      kind: "warning",
      message: "gemma3:27b is running 52% on GPU",
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

  it("decodes a frame kind unknown to this build rather than throwing (forward-compat)", () => {
    // decodeFrame only checks for a "kind" field — it doesn't validate that
    // the kind is a member of the current TaskFrame union. That's what lets
    // an old client survive a new server sending a frame kind it doesn't
    // recognize yet: it decodes fine here, and the consumer's dispatch
    // (taskStream.ts's if-chain, which has no `else`) is what actually
    // drops it silently rather than crashing.
    const decoded = decodeFrame(Buffer.from('{"kind":"future-kind","x":1}'));
    expect(decoded).toEqual({ kind: "future-kind", x: 1 });
  });
});
