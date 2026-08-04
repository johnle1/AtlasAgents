/**
 * Unit tests — banner helpers and task board inner width.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => ({
    agentModel: "agent-model",
    subagentModel: "sub-model",
    ui: { theme: "default" },
  }),
}));

vi.mock("../../../../packages/client/src/theme/themeManager.js", () => ({
  getTheme: () => ({
    textBold: "",
    textSecondary: "",
    textAccent: "",
    textDim: "",
    success: "",
    warning: "",
    error: "",
    reset: "",
  }),
}));

import { buildBannerLines } from "../../../../packages/client/src/renderer/banner.js";
import { bannerCenterPad } from "../../../../packages/client/src/ui/banner/logoArt.js";
import {
  taskBoardInnerWidth,
  TASK_BOARD_MIN_INNER_WIDTH,
} from "../../../../packages/client/src/ui/taskBoardLayout.js";

describe("bannerCenterPad", () => {
  it("centers content within banner inner width", () => {
    const pad = bannerCenterPad(10);
    expect(pad.left).toBeGreaterThanOrEqual(0);
    expect(pad.right).toBeGreaterThanOrEqual(0);
  });
});

describe("buildBannerLines", () => {
  it("returns multiple ANSI banner rows", () => {
    const lines = buildBannerLines({
      agentModel: "a",
      subagentModel: "b",
      server: "localhost",
      port: 7000,
      password: "",
      ui: { theme: "default" },
    } as unknown as import("../../../../packages/client/src/config/index.js").Config);
    expect(lines.length).toBeGreaterThan(3);
  });
});

describe("taskBoardInnerWidth", () => {
  it("respects minimum inner width", () => {
    const original = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 40,
    });
    expect(taskBoardInnerWidth()).toBe(TASK_BOARD_MIN_INNER_WIDTH);
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: original,
    });
  });
});
