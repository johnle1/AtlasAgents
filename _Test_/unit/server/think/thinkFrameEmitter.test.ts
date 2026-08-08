/**
 * Unit tests — packages/server/src/orchestration/thinkStream.ts (createThinkFrameEmitter)
 *
 * Covers coalescing, per-turn id assignment/reuse, and the fallback that
 * opens then immediately closes a stream when finish() has final text but no
 * delta() call ever opened one this turn (e.g. a think block found only by
 * the whole-response regex extraction, not the incremental scanner).
 */

import { describe, expect, it } from "vitest";
import { createThinkFrameEmitter } from "../../../../packages/server/src/orchestration/thinkStream.js";
import type { TaskFrame } from "../../../../packages/shared/src/frames/frames.js";

describe("createThinkFrameEmitter", () => {
  it("emits nothing when finish(null) is called with no deltas", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
    });

    emitter.finish(null);

    expect(frames).toEqual([]);
  });

  it("opens then immediately closes a stream when finish() has final text but nothing streamed", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: true,
    });

    emitter.finish("the complete block");

    expect(frames.map((frame) => frame.kind)).toEqual([
      "think-start",
      "think-end",
    ]);
    const [start, end] = frames as [
      Extract<TaskFrame, { kind: "think-start" }>,
      Extract<TaskFrame, { kind: "think-end" }>,
    ];
    expect(start.agent).toBe(true);
    expect(end).toMatchObject({ id: start.id, text: "the complete block" });
  });

  it("emits think-start exactly once on the first delta, regardless of how many deltas follow", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
      coalesceChars: 1000, // avoid intermediate flushes complicating this count
    });

    emitter.delta("a");
    emitter.delta("b");
    emitter.delta("c");
    emitter.finish("abc");

    const starts = frames.filter((frame) => frame.kind === "think-start");
    expect(starts).toHaveLength(1);
  });

  it("emits think-end once any delta has streamed", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
    });

    emitter.delta("partial reasoning");
    emitter.finish("partial reasoning, cleaned up");

    const kinds = frames.map((frame) => frame.kind);
    expect(kinds[kinds.length - 1]).toBe("think-end");
    const endFrame = frames.find((frame) => frame.kind === "think-end");
    expect(endFrame).toMatchObject({ text: "partial reasoning, cleaned up" });
  });

  it("think-end omits text when finish(null) is called after streaming (client falls back to its own accumulation)", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
    });

    emitter.delta("some reasoning");
    emitter.finish(null);

    const endFrame = frames.find((frame) => frame.kind === "think-end");
    expect(endFrame).toEqual({
      kind: "think-end",
      id: expect.any(String),
    });
  });

  it("start and delta/end frames share the same id", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
    });

    emitter.delta("x");
    emitter.finish("x");

    const ids = new Set(
      frames
        .filter(
          (frame): frame is Extract<TaskFrame, { id: string }> =>
            "id" in frame,
        )
        .map((frame) => frame.id),
    );
    expect(ids.size).toBe(1);
  });

  it("is idempotent: calling finish() again after a normal close does nothing", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
    });

    emitter.delta("reasoning");
    emitter.finish("reasoning");
    const countAfterFirstFinish = frames.length;

    // Safety-net call, as taskStream/subagent make from a finally block.
    emitter.finish(null);

    expect(frames).toHaveLength(countAfterFirstFinish);
  });

  it("reuses across turns, assigning a distinct id each time", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: true,
    });

    emitter.delta("turn one");
    emitter.finish("turn one");
    emitter.delta("turn two");
    emitter.finish("turn two");

    const startIds = frames
      .filter((frame) => frame.kind === "think-start")
      .map((frame) => (frame as { id: string }).id);
    expect(startIds).toHaveLength(2);
    expect(startIds[0]).not.toBe(startIds[1]);
  });

  it("coalesces multiple sub-threshold deltas into a single think-delta frame", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
      coalesceChars: 100,
    });

    // None of these individually (nor their sum) reach the threshold or
    // contain a newline, so nothing flushes until finish() forces it —
    // proving three delta() calls produced one frame, not three.
    emitter.delta("a");
    emitter.delta("b");
    emitter.delta("c");
    emitter.finish("abc");

    const deltaFrames = frames.filter((frame) => frame.kind === "think-delta");
    expect(deltaFrames).toEqual([
      { kind: "think-delta", id: expect.any(String), text: "abc" },
    ]);
  });

  it("flushes a delta frame as soon as pending text reaches the character threshold", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
      coalesceChars: 3,
    });

    emitter.delta("ab");
    expect(frames.filter((frame) => frame.kind === "think-delta")).toEqual([]);

    emitter.delta("c"); // pending "abc" reaches the threshold
    expect(frames.filter((frame) => frame.kind === "think-delta")).toEqual([
      { kind: "think-delta", id: expect.any(String), text: "abc" },
    ]);
  });

  it("flushes a delta frame early on a newline, even under the character threshold", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
      coalesceChars: 1000,
    });

    emitter.delta("line one\n");

    expect(frames.filter((frame) => frame.kind === "think-delta")).toEqual([
      { kind: "think-delta", id: expect.any(String), text: "line one\n" },
    ]);
  });

  it("carries the subagent source through to think-start", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
      source: { agentId: 2, agentLabel: "tester" },
    });

    emitter.delta("x");
    emitter.finish("x");

    expect(frames[0]).toMatchObject({
      kind: "think-start",
      agent: false,
      source: { agentId: 2, agentLabel: "tester" },
    });
  });

  it("ignores empty-string deltas", () => {
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
    });

    emitter.delta("");
    emitter.finish(null);

    expect(frames).toEqual([]);
  });

  it("finish(null) is a true no-op the second time, whether the turn streamed or opened only inside finish()", () => {
    const streamedFrames: TaskFrame[] = [];
    const streamedEmitter = createThinkFrameEmitter({
      emit: (frame) => streamedFrames.push(frame),
      agent: false,
    });
    streamedEmitter.delta("reasoning");
    streamedEmitter.finish("reasoning");
    streamedEmitter.finish(null); // safety-net repeat
    expect(
      streamedFrames.filter((frame) => frame.kind === "think-end"),
    ).toHaveLength(1);

    const noDeltaFrames: TaskFrame[] = [];
    const noDeltaEmitter = createThinkFrameEmitter({
      emit: (frame) => noDeltaFrames.push(frame),
      agent: true,
    });
    noDeltaEmitter.finish("whole block");
    noDeltaEmitter.finish(null); // safety-net repeat
    expect(
      noDeltaFrames.filter((frame) => frame.kind === "think-end"),
    ).toHaveLength(1);
  });

  it("calling finish() twice with the SAME non-null text after a close emits a duplicate open/close pair (known limitation, not currently reachable)", () => {
    // Distinguishing "a repeat close of this turn" from "a new turn that
    // happens to have zero deltas" is impossible from this function's
    // internal state alone — both produce the identical id-reset sequence.
    // No caller in this codebase repeats finish() with non-null text — every
    // finally-block safety net passes null — so this test documents the
    // known gap rather than asserting a fix. See finish()'s doc comment for
    // the full reasoning.
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
    });

    emitter.delta("reasoning");
    emitter.finish("reasoning");
    emitter.finish("reasoning");

    expect(frames.filter((frame) => frame.kind === "think-start")).toHaveLength(2);
    expect(frames.filter((frame) => frame.kind === "think-end")).toHaveLength(2);
  });

  it("a genuinely new turn after a streamed close is not swallowed", () => {
    // A turn that streams real content always gets its own id via delta(),
    // regardless of what the previous turn did.
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: false,
    });

    emitter.delta("turn one");
    emitter.finish("turn one");
    emitter.delta("turn two");
    emitter.finish("turn two");

    const endFrames = frames.filter((frame) => frame.kind === "think-end");
    expect(endFrames).toHaveLength(2);
  });

  it("a zero-delta turn immediately after a streamed turn still gets its own start/end pair (regression guard)", () => {
    // runPlanningWithRevisions shares one emitter across agent.plan()'s
    // internal loop iterations, and an iteration with no reasoning content
    // (e.g. a pure tool call) can immediately follow one that streamed. That
    // later iteration's finish(realText) must not be swallowed just because
    // the previous iteration closed via the streamed path.
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: true,
    });

    emitter.delta("first iteration reasoning");
    emitter.finish("first iteration reasoning");
    // Second iteration: zero deltas, but still has fallback text to report.
    emitter.finish("second iteration, no incremental deltas");

    expect(frames.filter((frame) => frame.kind === "think-start")).toHaveLength(2);
    const ends = frames.filter((frame) => frame.kind === "think-end");
    expect(ends).toHaveLength(2);
    expect(ends.at(-1)).toMatchObject({
      text: "second iteration, no incremental deltas",
    });
  });

  it("repeated zero-delta finish() calls each get their own start/end pair, none swallowed", () => {
    // Every turn here has real reasoning but no delta() calls — this must
    // never collapse to only the first turn's text.
    const frames: TaskFrame[] = [];
    const emitter = createThinkFrameEmitter({
      emit: (frame) => frames.push(frame),
      agent: true,
    });

    emitter.finish("turn one, no deltas");
    emitter.finish("turn two, no deltas");

    const ends = frames.filter((frame) => frame.kind === "think-end");
    expect(ends.map((frame) => (frame as { text?: string }).text)).toEqual([
      "turn one, no deltas",
      "turn two, no deltas",
    ]);
  });
});
