/**
 * Ink smoke tests — standalone UI components (no AppProvider).
 */

import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => ({ ui: { showSpinner: true } }),
}));

vi.mock("../../../../packages/client/src/ui/terminalEnv.js", () => ({
  inTmux: () => false,
  isScreenReaderLikely: () => false,
}));

import { Banner } from "../../../../packages/client/src/ui/components/Banner.js";
import { ConnectionStatusLine } from "../../../../packages/client/src/ui/components/ConnectionStatusLine.js";
import { StatusSpinner } from "../../../../packages/client/src/ui/components/Spinner.js";
import { SubagentStatusBox } from "../../../../packages/client/src/ui/components/SubagentStatusBox.js";
import { SubagentTaskBoard } from "../../../../packages/client/src/ui/components/SubagentTaskBoard.js";
import { renderHistoryItem } from "../../../../packages/client/src/ui/components/HistoryView.js";

const frame = (tree: ReturnType<typeof render>) =>
  stripAnsi(tree.lastFrame() ?? "");

describe("Ink component smoke", () => {
  it("Banner renders version and models", () => {
    const tree = render(
      React.createElement(Banner, {
        version: "9.9.9",
        agentModel: "agent-x",
        subagentModel: "sub-y",
      }),
    );
    expect(frame(tree)).toContain("9.9.9");
    tree.unmount();
  });

  it("ConnectionStatusLine renders status label", () => {
    const tree = render(
      React.createElement(ConnectionStatusLine, { status: "Connected" }),
    );
    expect(frame(tree)).toContain("Connected");
    tree.unmount();
  });

  it("StatusSpinner renders when active", () => {
    const tree = render(
      React.createElement(StatusSpinner, {
        state: { active: true, mode: "thinking", label: "Agent" },
      }),
    );
    expect(frame(tree)).toMatch(/Agent/);
    tree.unmount();
  });

  it("SubagentStatusBox renders label", () => {
    const tree = render(
      React.createElement(SubagentStatusBox, {
        id: 2,
        label: "worker",
        icon: "◌",
        message: "Editing file",
        stage: "writing",
      }),
    );
    expect(frame(tree)).toContain("worker");
    tree.unmount();
  });

  it("SubagentTaskBoard renders task labels", () => {
    const tree = render(
      React.createElement(SubagentTaskBoard, {
        board: {
          id: 1,
          label: "planner",
          tasks: [
            { id: 1, state: "complete", text: "Step one" },
            { id: 2, state: "running", text: "Step two" },
          ],
        },
      }),
    );
    expect(frame(tree)).toContain("planner");
    tree.unmount();
  });

  it("renderHistoryItem maps text history", () => {
    const node = renderHistoryItem(
      { kind: "text", text: "hello world", variant: "success" },
      "k1",
    );
    const tree = render(React.createElement(React.Fragment, null, node));
    expect(frame(tree)).toContain("hello world");
    tree.unmount();
  });
});
