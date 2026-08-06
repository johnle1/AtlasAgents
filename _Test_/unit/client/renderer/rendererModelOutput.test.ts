/**
 * Unit tests — renderer modelOutput print_* helpers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appendBlock = vi.fn();
const appendText = vi.fn();
const setStreamingText = vi.fn();

vi.mock("../../../../packages/client/src/theme/themeManager.js", () => ({
  getTheme: () => ({
    textBold: "B",
    textSecondary: "S",
    warning: "W",
    success: "OK",
    error: "E",
    reset: "R",
  }),
}));

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
  setStreamingText: (...args: unknown[]) => setStreamingText(...args),
}));

vi.mock("../../../../packages/client/src/renderer/sink.js", () => ({
  appendBlock: (...args: unknown[]) => appendBlock(...args),
  appendText: (...args: unknown[]) => appendText(...args),
}));

import {
  finishPullProgress,
  printInstalledModels,
  printModelFind,
  printProgress,
  resetPullProgress,
} from "../../../../packages/client/src/renderer/modelOutput.js";

beforeEach(() => {
  appendBlock.mockClear();
  appendText.mockClear();
  setStreamingText.mockClear();
});

describe("modelOutput printers", () => {
  it("printInstalledModels empty and populated", () => {
    printInstalledModels([]);
    printInstalledModels([
      { name: "gemma:2b", size: 2_000_000_000, details: { family: "gemma" } },
    ]);
    expect(appendBlock.mock.calls.length).toBe(2);
  });

  it("printModelFind appends styled output", () => {
    printModelFind("gemma", { name: "gemma:2b" }, [{ name: "gemma:2b" }]);
    expect(appendBlock).toHaveBeenCalled();
  });

  it("pull progress lifecycle uses streaming + appendText", () => {
    resetPullProgress("gemma");
    expect(setStreamingText).toHaveBeenCalledWith(null);

    const failed = printProgress({ error: "network" }, "gemma");
    expect(failed).toBe(true);
    expect(appendText).toHaveBeenCalled();

    printProgress({ status: "pulling", completed: 1, total: 10 }, "gemma");
    expect(setStreamingText).toHaveBeenCalled();

    finishPullProgress("gemma");
    expect(setStreamingText).toHaveBeenCalledWith(null);
  });

  it("printProgress does not throw and clamps to 100% when completed exceeds total (boundary — regression for RangeError)", () => {
    expect(() =>
      printProgress({ status: "pulling", completed: 15, total: 10 }, "gemma"),
    ).not.toThrow();
    expect(setStreamingText).toHaveBeenCalledWith(
      expect.stringContaining("100.0%"),
    );
  });
});
