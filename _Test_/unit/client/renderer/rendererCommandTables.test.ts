/**
 * Unit tests — renderer commandTables print_* helpers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appendStyledLines = vi.fn();

vi.mock("../../../../packages/client/src/theme/themeManager.js", () => ({
  getTheme: () => ({
    textBold: "B",
    textSecondary: "S",
    textAccent: "A",
    warning: "W",
    reset: "R",
  }),
}));

vi.mock("../../../../packages/client/src/renderer/sink.js", () => ({
  appendStyledLines: (...args: unknown[]) => appendStyledLines(...args),
}));

import type { Config } from "../../../../packages/client/src/config/index.js";
import {
  buildConfigLines,
  buildGroupedModelsLines,
  printConfig,
  printGroupedModels,
  printMemory,
  printModels,
  printProviders,
  printSkills,
} from "../../../../packages/client/src/renderer/commandTables.js";

const minimalConfig = {
  server: "localhost",
  port: 7000,
  password: "",
  ui: { theme: "default", showSpinner: true },
} as Config;

beforeEach(() => {
  appendStyledLines.mockClear();
});

describe("commandTables printers", () => {
  it("printConfig / printModels / printSkills call appendStyledLines", () => {
    printConfig(minimalConfig);
    printModels(["m1", "m2"], "agent");
    printSkills(["skill-a"]);
    expect(appendStyledLines.mock.calls.length).toBe(3);
  });

  it("printProviders and printGroupedModels call appendStyledLines", () => {
    printProviders({ ollama: { baseUrl: "http://x" } }, "ollama", "ollama");
    printGroupedModels([], "agent");
    expect(appendStyledLines.mock.calls.length).toBe(2);
  });

  it("printMemory handles empty and non-empty entries", () => {
    printMemory([]);
    printMemory([{ topic: "style", rules: ["use tabs"] }]);
    expect(appendStyledLines.mock.calls.length).toBe(2);
  });

  it("buildConfigLines and buildGroupedModelsLines return styled rows", () => {
    const lines = buildConfigLines(minimalConfig);
    expect(lines.some((l) => l.includes("localhost"))).toBe(true);
    const grouped = buildGroupedModelsLines([], "agent");
    expect(grouped.lines.length).toBeGreaterThan(0);
  });
});
