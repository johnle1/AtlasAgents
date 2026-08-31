/**
 * Unit tests — shared tool handler formatters.
 */

import { describe, expect, it } from "vitest";
import { AbortError } from "../../../../packages/server/src/errors/abortError.js";
import {
  formatObservation,
  toolExecutionErrorResult,
  truncateObservationBody,
  userReviseMessage,
} from "../../../../packages/server/src/orchestration/tools/toolHandler.js";

describe("userReviseMessage", () => {
  it("quotes feedback and appends the repeat warning", () => {
    const msg = userReviseMessage(
      "accepting this edit",
      "Do not repeat the same edit",
      "wrong file",
    );
    expect(msg).toContain('User requested changes instead of accepting this edit: "wrong file"');
    expect(msg).toContain(
      "Do not repeat the same edit — revise your approach based on this feedback.",
    );
  });
});

describe("formatObservation", () => {
  it("prefixes the tool name and echoes args", () => {
    const text = formatObservation("read_file", { path: "a.ts" }, "hello");
    expect(text.startsWith("[read_file] ")).toBe(true);
    expect(text).toContain('"path":"a.ts"');
    expect(text).toContain("hello");
  });

  it("truncates an oversized body instead of putting it entirely into the conversation", () => {
    const huge = "x".repeat(10_000);
    const text = formatObservation("run_command", { command: "cat big.log" }, huge);
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain("chars elided");
  });
});

describe("truncateObservationBody", () => {
  it("leaves a body within budget untouched (normal)", () => {
    const body = "short output\nexit 0";
    expect(truncateObservationBody(body)).toBe(body);
  });

  it("keeps both the head and the tail of an oversized body (boundary)", () => {
    // The head carries an identifying marker, the tail carries the part that
    // usually matters most for a command result — the exit status/error.
    const body = `HEAD_MARKER${"x".repeat(6000)}TAIL_MARKER_exit_1`;
    const result = truncateObservationBody(body);
    expect(result).toContain("HEAD_MARKER");
    expect(result).toContain("TAIL_MARKER_exit_1");
    expect(result).toContain("chars elided");
    expect(result.length).toBeLessThan(body.length);
  });
});

describe("toolExecutionErrorResult", () => {
  it("converts ordinary errors into feedback", () => {
    const result = toolExecutionErrorResult(
      "write_file",
      { path: "x" },
      new Error("disk full"),
      2,
    );
    expect(result.done).toBe(false);
    expect(result.escalationCount).toBe(2);
    expect(result.feedback).toContain("disk full");
  });

  it("re-throws AbortError", () => {
    expect(() =>
      toolExecutionErrorResult("run_command", {}, new AbortError(), 0),
    ).toThrow(AbortError);
  });
});
