/**
 * Smoke test — App root mounts with mocked services.
 */

import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => ({
    agentModel: "agent",
    subagentModel: "sub",
    ui: { showSpinner: false, useAlternateBuffer: false },
    server: "localhost",
    port: 7000,
    password: "",
  }),
  parsePersistedApprovalMode: () => "default",
}));

vi.mock("../../../../packages/client/src/renderer/banner.js", () => ({
  buildBannerLines: () => ["AtlasAgents banner"],
}));

vi.mock("../../../../packages/client/src/utils/pathDisplay.js", () => ({
  buildPromptLabel: () => "> ",
}));

vi.mock("../../../../packages/client/src/ui/taskStream.js", () => ({
  runTaskStream: vi.fn(async () => {}),
}));

vi.mock("../../../../packages/client/src/commands/utils.js", () => ({
  formatErrorMessage: (e: unknown) => String(e),
}));

const connection = {
  onConnectionStatus: (cb: (s: string) => void) => {
    cb("Connected");
    return () => {};
  },
  getStatus: () => "Connected",
};

const fileProxy = {
  getCwd: () => "/workspace",
  clearScreen: vi.fn(),
};

import { App } from "../../../../packages/client/src/ui/App.js";

describe("App smoke", () => {
  it("renders without throwing", () => {
    const inputRef = { current: [] as string[] };
    const tree = render(
      React.createElement(App, {
        connection: connection as never,
        commandHandler: { handle: vi.fn() } as never,
        fileProxy: fileProxy as never,
        initialHistoryLines: ["prior session line"],
        onSaveHistory: vi.fn(),
        initialInputHistory: [],
        registerExit: vi.fn(),
        onInputHistoryRef: inputRef,
      }),
    );
    expect(stripAnsi(tree.lastFrame() ?? "").length).toBeGreaterThan(0);
    tree.unmount();
  });

  it("prints the startup banner exactly once (regression — no double Static remount on mount)", async () => {
    // The markdownRaw-toggle effect that remounts <Static> used to fire once
    // on mount too (useEffect always runs after the first commit, regardless
    // of its dependency array), reprinting every already-committed Static
    // row — including the banner — a second time. Wait a tick so that
    // mount-time effect has a chance to (mis)fire before asserting.
    const inputRef = { current: [] as string[] };
    const tree = render(
      React.createElement(App, {
        connection: connection as never,
        commandHandler: { handle: vi.fn() } as never,
        fileProxy: fileProxy as never,
        initialHistoryLines: [],
        onSaveHistory: vi.fn(),
        initialInputHistory: [],
        registerExit: vi.fn(),
        onInputHistoryRef: inputRef,
      }),
    );

    // Two ticks: one for the mount-time effect to (mis)fire and bump the
    // epoch, one more for <Static>'s own layout effect to commit the remount.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const occurrences = (
      stripAnsi(tree.lastFrame() ?? "").match(/AtlasAgents banner/g) ?? []
    ).length;
    expect(occurrences).toBe(1);

    tree.unmount();
  });
});
