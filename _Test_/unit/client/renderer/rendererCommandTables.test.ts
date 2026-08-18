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
    success: "G",
    reset: "R",
  }),
}));

vi.mock("../../../../packages/client/src/renderer/sink.js", () => ({
  appendStyledLines: (...args: unknown[]) => appendStyledLines(...args),
}));

import type { Config } from "../../../../packages/client/src/config/index.js";
import { COMMAND_CATALOG } from "../../../../packages/client/src/ui/commandCatalog.js";
import {
  buildConfigLines,
  buildGroupedModelsLines,
  buildHelpLines,
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

  describe("buildGroupedModelsLines — current selection markers", () => {
    const groups = [{ provider: "ollama", models: ["gemma3:12b", "gemma3:4b"] }];

    it("marks a row matching only the agent", () => {
      const { lines } = buildGroupedModelsLines(groups, "agent", {
        agent: { provider: "ollama", model: "gemma3:12b" },
      });
      const row = lines.find((l) => l.includes("gemma3:12b"))!;
      expect(row).toContain("current agent");
      expect(row).not.toContain("subagent");
    });

    it("marks a row matching both roles distinctly", () => {
      const { lines } = buildGroupedModelsLines(groups, "agent", {
        agent: { provider: "ollama", model: "gemma3:12b" },
        subagent: { provider: "ollama", model: "gemma3:12b" },
      });
      const row = lines.find((l) => l.includes("gemma3:12b"))!;
      expect(row).toContain("current agent + subagent");
    });

    it("tolerates bare-name vs :latest tag mismatch", () => {
      const { lines } = buildGroupedModelsLines(
        [{ provider: "ollama", models: ["gemma3:latest"] }],
        "agent",
        { agent: { provider: "ollama", model: "gemma3" } },
      );
      const row = lines.find((l) => l.includes("gemma3:latest"))!;
      expect(row).toContain("current agent");
    });

    it("leaves rows unmarked when nothing matches", () => {
      const { lines } = buildGroupedModelsLines(groups, "agent", {
        agent: { provider: "ollama", model: "qwen3:32b" },
      });
      expect(lines.some((l) => l.includes("current"))).toBe(false);
    });
  });
});

describe("buildHelpLines", () => {
  it("renders every catalog command with its description (normal)", () => {
    const lines = buildHelpLines(COMMAND_CATALOG);
    const joined = lines.join("\n");

    for (const entry of COMMAND_CATALOG) {
      expect(joined).toContain(entry.command);
      expect(joined).toContain(entry.description);
    }
  });

  it("never drops an entry — command-line count matches catalog length (boundary)", () => {
    const lines = buildHelpLines(COMMAND_CATALOG);
    const commandLines = lines.filter((line) =>
      COMMAND_CATALOG.some((entry) => line.includes(entry.command)),
    );
    expect(commandLines).toHaveLength(COMMAND_CATALOG.length);
  });

  it("groups commands under section headers (normal)", () => {
    const lines = buildHelpLines(COMMAND_CATALOG);
    const joined = lines.join("\n");
    expect(joined).toMatch(/Models/i);
    expect(joined).toMatch(/Providers/i);
    expect(joined).toMatch(/Session/i);
    expect(joined).toMatch(/UI/i);
  });
});
