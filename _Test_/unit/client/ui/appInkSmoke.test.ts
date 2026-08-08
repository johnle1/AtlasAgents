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
}));

vi.mock("../../../../packages/client/src/renderer/banner.js", () => ({
  buildBannerLines: () => ["LoopyCode banner"],
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
});
