/**
 * Unit tests — renderer fileOperations print_* helpers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appendBlock = vi.fn();
const appendDiff = vi.fn();
let diffRendererOutput = "+line\n";

vi.mock("../../../../packages/client/src/state/agentStatus.js", () => ({
  beginBlockOutput: vi.fn(),
}));

vi.mock("../../../../packages/client/src/diff/diffRenderer.js", () => ({
  renderDiffFromChunks: vi.fn(async () => diffRendererOutput),
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
    diffAdded: "DA",
    diffRemoved: "DR",
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
  printNoChange,
  printRead,
  printTokenSaveOp,
  printTokenSaveResult,
  printWrite,
} from "../../../../packages/client/src/renderer/fileOperations.js";

beforeEach(() => {
  appendBlock.mockClear();
  appendDiff.mockClear();
  diffRendererOutput = "+line\n";
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

  it("printWrite appends a diff card with stats on a └─ line when there are no changed lines", async () => {
    await printWrite("/a.ts", []);
    expect(appendDiff).toHaveBeenCalledWith(
      "* Updated(B/a.tsR)",
      "S  └─ R Sno line changesR\n\n+line\n",
    );
  });

  it("printWrite's └─ line shows the real added/removed line counts from the diff chunks", async () => {
    await printWrite("/a.ts", [
      { value: "kept\n", added: false, removed: false },
      { value: "old1\nold2\n", added: false, removed: true },
      { value: "new1\nnew2\nnew3\n", added: true, removed: false },
    ]);
    const [header, body] = appendDiff.mock.calls[0]!;
    expect(header).toBe("* Updated(B/a.tsR)");
    expect(body.startsWith("S  └─ R DAAdded 3 linesR, DRRemoved 2 linesR\n\n")).toBe(
      true,
    );
  });

  it("printWrite falls back to a '(no change)' body instead of a bare header when the rendered diff is empty", async () => {
    diffRendererOutput = "";
    await printWrite("/a.ts", []);
    const [, body] = appendDiff.mock.calls[0]!;
    expect(body).toContain("(no change)");
  });

  it("printNoChange appends a no-op write line", () => {
    printNoChange("/a.ts");
    expect(appendBlock).toHaveBeenCalled();
    const [lines] = appendBlock.mock.calls[0]!;
    expect(lines[0]).toContain("no change");
    expect(lines[0]).toContain("/a.ts");
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
