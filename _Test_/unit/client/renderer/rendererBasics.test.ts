/**
 * Unit tests — renderer sink + messages + agentThink display.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appendHistory = vi.fn();
const appendLog = vi.fn();

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
  appendHistory: (...args: unknown[]) => appendHistory(...args),
  appendLog: (...args: unknown[]) => appendLog(...args),
}));

vi.mock("../../../../packages/client/src/theme/themeManager.js", () => ({
  getTheme: () => ({
    error: "E",
    success: "S",
    reset: "R",
  }),
}));

import { formatAgentThinkForDisplay } from "../../../../packages/client/src/renderer/agentThink.js";
import {
  printError,
  printLine,
  printSuccess,
} from "../../../../packages/client/src/renderer/messages.js";
import {
  appendBlock,
  appendDiff,
  appendStyledLines,
  appendText,
} from "../../../../packages/client/src/renderer/sink.js";

describe("formatAgentThinkForDisplay", () => {
  it("trims non-empty think text", () => {
    expect(formatAgentThinkForDisplay("  PLAN:\nx  ")).toBe("PLAN:\nx");
  });

  it("returns a placeholder for blank input", () => {
    expect(formatAgentThinkForDisplay("   ")).toBe("Planning...");
  });
});

describe("sink", () => {
  beforeEach(() => {
    appendHistory.mockClear();
    appendLog.mockClear();
  });

  it("appendBlock writes a history block", () => {
    appendBlock(["a", "b"]);
    expect(appendHistory).toHaveBeenCalledWith({
      kind: "block",
      lines: ["a", "b"],
    });
  });

  it("appendBlock rejects non-arrays", () => {
    expect(() => appendBlock("nope" as never)).toThrow(/array/i);
  });

  it("appendText forwards to appendLog", () => {
    appendText("hi", "error");
    expect(appendLog).toHaveBeenCalledWith("hi", "error");
  });

  it("appendDiff / appendStyledLines write history entries", () => {
    appendDiff("Write a.ts", "+x\n");
    expect(appendHistory).toHaveBeenCalledWith({
      kind: "diff",
      path: "Write a.ts",
      body: "+x\n",
    });
    appendStyledLines(["x"]);
    expect(appendHistory).toHaveBeenCalled();
  });
});

describe("messages", () => {
  beforeEach(() => {
    appendHistory.mockClear();
    appendLog.mockClear();
  });

  it("printLine / printError / printSuccess use the sinks", () => {
    printLine("hello");
    expect(appendLog).toHaveBeenCalled();
    printError("boom");
    expect(appendHistory).toHaveBeenCalled();
    printSuccess("ok");
    expect(appendHistory).toHaveBeenCalled();
  });
});
