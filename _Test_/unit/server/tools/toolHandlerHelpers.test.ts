/**
 * Unit tests — shared tool handler formatters.
 */

import { describe, expect, it } from "vitest";
import { AbortError } from "../../../../packages/server/src/errors/abortError.js";
import {
  formatObservation,
  toolExecutionErrorResult,
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
