/**
 * Unit tests — renderer shellOperations print_* helpers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appendBlock = vi.fn();

vi.mock("../../../../packages/client/src/state/agentStatus.js", () => ({
  beginBlockOutput: vi.fn(),
}));

vi.mock("../../../../packages/client/src/theme/themeManager.js", () => ({
  getTheme: () => ({
    textAccent: "A",
    textSecondary: "S",
    success: "OK",
    error: "E",
    reset: "R",
  }),
}));

vi.mock("../../../../packages/client/src/renderer/sink.js", () => ({
  appendBlock: (...args: unknown[]) => appendBlock(...args),
}));

import {
  printBash,
  printBashApproved,
  printBashRan,
  printBashResult,
  printReviseRequested,
  printSkipped,
  printSuccessOp,
} from "../../../../packages/client/src/renderer/shellOperations.js";

beforeEach(() => {
  appendBlock.mockClear();
});

describe("shellOperations printers", () => {
  it("printBash / printBashResult append blocks", () => {
    printBash("git status", "safe");
    printBashResult(0, 1500);
    expect(appendBlock.mock.calls.length).toBe(2);
  });

  it("printSkipped / printReviseRequested / printBashApproved", () => {
    printSkipped();
    printReviseRequested();
    printBashApproved();
    expect(appendBlock.mock.calls.length).toBe(3);
  });

  it("printBashRan and printSuccessOp append blocks", () => {
    printBashRan(0, "out", "");
    printSuccessOp("done");
    expect(appendBlock.mock.calls.length).toBe(2);
  });
});
