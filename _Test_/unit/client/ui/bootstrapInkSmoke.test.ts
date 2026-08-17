/**
 * Smoke test — BootstrapApp setup phase.
 */

import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";

vi.mock("../../../../packages/client/src/config/index.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../packages/client/src/config/index.js")
  >();
  return {
    ...actual,
    loadConfig: () => ({
      server: "localhost",
      port: 7000,
      password: "",
      agentModel: "a",
      subagentModel: "b",
      ui: {},
    }),
    saveConfig: vi.fn(),
  };
});

vi.mock("../../../../packages/client/src/commands/tokenSaveHandlers.js", () => ({
  printTokenSaveInitTip: vi.fn(),
  syncTokenSaveTools: vi.fn(async () => []),
}));

vi.mock("../../../../packages/client/src/ui/bootstrap/historyPersist.js", () => ({
  loadHistory: () => [],
}));

import { BootstrapApp } from "../../../../packages/client/src/ui/bootstrap/BootstrapApp.js";

describe("BootstrapApp smoke", () => {
  it("renders setup wizard when needsSetup is true", () => {
    const tree = render(
      React.createElement(BootstrapApp, {
        cliOverrides: {},
        needsSetup: true,
        onSaveHistory: vi.fn(),
      }),
    );
    expect(stripAnsi(tree.lastFrame() ?? "")).toContain("Welcome to AtlasAgents");
    tree.unmount();
  });
});
