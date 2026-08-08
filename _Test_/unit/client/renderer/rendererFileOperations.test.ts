/**
 * Unit tests — renderer fileOperations print_* helpers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appendBlock = vi.fn();
const appendDiff = vi.fn();

vi.mock("../../../../packages/client/src/state/agentStatus.js", () => ({
  beginBlockOutput: vi.fn(),
}));

vi.mock("../../../../packages/client/src/diff/diffRenderer.js", () => ({
  renderDiffFromChunks: vi.fn(async () => "+line\n"),
}));

vi.mock("../../../../packages/client/src/utils/pathDisplay.js", () => ({
  formatDisplayPath: (p: string) => p,
}));

vi.mock("../../../../packages/client/src/theme/themeManager.js", () => ({
  getTheme: () => ({
    textSecondary: "S",
    textBold: "B",
    warning: "W",
    error: "E",
    reset: "R",
  }),
}));

vi.mock("../../../../packages/client/src/renderer/sink.js", () => ({
  appendBlock: (...args: unknown[]) => appendBlock(...args),
  appendDiff: (...args: unknown[]) => appendDiff(...args),
}));

import {
  printCd,
  printCreate,
  printCreateDir,
  printDelete,
  printListDir,
  printListDirEntries,
  printRead,
  printTokenSaveOp,
  printTokenSaveResult,
  printWrite,
} from "../../../../packages/client/src/renderer/fileOperations.js";

beforeEach(() => {
  appendBlock.mockClear();
  appendDiff.mockClear();
});

describe("fileOperations printers", () => {
  it("printListDir / printRead append blocks", () => {
    printListDir("/src");
    printRead("/src/a.ts");
    expect(appendBlock).toHaveBeenCalled();
  });

  it("printTokenSaveOp / printTokenSaveResult append blocks", () => {
    printTokenSaveOp("Search", "query");
    printTokenSaveResult("path/to/file.ts");
    expect(appendBlock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("printWrite appends a diff card", async () => {
    await printWrite("/a.ts", []);
    expect(appendDiff).toHaveBeenCalledWith("Write /a.ts", "+line\n");
  });

  it("printCreate / printCreateDir / printDelete mutate ops", () => {
    printCreate("/new.ts", "body");
    printCreateDir("/dir");
    printDelete("/old.ts");
    expect(appendBlock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("printCd and printListDirEntries append blocks", () => {
    printCd("/tmp");
    printListDirEntries(
      [{ name: "a.ts", isDirectory: false, noRead: false }],
      2,
    );
    expect(appendBlock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
