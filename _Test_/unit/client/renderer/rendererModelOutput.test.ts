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
    textAccent: "A",
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
  formatStorageBytes,
  printInstalledModels,
  printModelFind,
  printModelStorage,
  printProgress,
  resetPullProgress,
} from "../../../../packages/client/src/renderer/modelOutput.js";
import type { ModelStorageReport } from "@loopycode/shared";

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

describe("formatStorageBytes", () => {
  it("renders an exact zero as '0 B' rather than '0.00 GB' (normal — the 'frees nothing' case)", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
  });

  it("renders a non-zero byte count as a 2-decimal GB figure (normal)", () => {
    expect(formatStorageBytes(8_100_000_000)).toBe("7.54 GB");
  });
});

describe("printModelStorage", () => {
  it("prints the unavailable reason and returns without a models section (boundary)", () => {
    const report: ModelStorageReport = {
      available: false,
      reason: "Ollama is running on a remote host.",
    };
    printModelStorage(report);
    expect(appendBlock).toHaveBeenCalledTimes(1);
    const lines = appendBlock.mock.calls[0]![0] as string[];
    expect(lines.some((l) => l.includes("remote host"))).toBe(true);
    expect(lines.some((l) => l.includes("Installed models"))).toBe(false);
  });

  it("marks a tag whose deletion frees nothing, and lists its sharedWith (normal)", () => {
    const report: ModelStorageReport = {
      available: true,
      dir: "/home/user/.ollama/models",
      dirSource: "default:~/.ollama/models",
      models: [
        {
          tag: "gemma3:latest",
          totalBytes: 8_100_000_000,
          uniqueBytes: 0,
          sharedBytes: 8_100_000_000,
          sharedWith: ["gemma3:12b"],
        },
      ],
      orphans: [],
      totals: { onDiskBytes: 8_100_000_000, referencedBytes: 8_100_000_000, orphanedBytes: 0 },
    };
    printModelStorage(report);
    const lines = appendBlock.mock.calls[0]![0] as string[];
    expect(lines.some((l) => l.includes("frees nothing"))).toBe(true);
    expect(lines.some((l) => l.includes("shared with gemma3:12b"))).toBe(true);
  });

  it("lists orphaned blobs with an rm -rf line each (normal — the headline scenario)", () => {
    const report: ModelStorageReport = {
      available: true,
      dir: "/home/user/.ollama/models",
      dirSource: "default:~/.ollama/models",
      models: [],
      orphans: [
        { path: "/home/user/.ollama/models/blobs/sha256-abc-partial", bytes: 6_100_000_000 },
      ],
      totals: { onDiskBytes: 6_100_000_000, referencedBytes: 0, orphanedBytes: 6_100_000_000 },
    };
    printModelStorage(report);
    const lines = appendBlock.mock.calls[0]![0] as string[];
    expect(
      lines.some((l) => l.includes("rm -rf") && l.includes("sha256-abc-partial")),
    ).toBe(true);
  });
});
