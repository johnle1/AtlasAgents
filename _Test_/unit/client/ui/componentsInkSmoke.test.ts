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
  colorDisabled: () => false,
  colorForced: () => false,
  supportsOsc9Notifications: () => false,
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

  it("SubagentTaskBoard renders a bordered card with a progress header and no dropped words", () => {
    const originalColumns = process.stdout.columns;
    // ink-testing-library's fake stdout hardcodes its OWN columns getter to
    // 100 (see its Stdout class) independent of this stub — Ink's internal
    // layout always measures against that fixed 100, while our app code
    // reads this real (stubbed) process.stdout.columns directly. Keep this
    // value comfortably below 100 so the two stay consistent in this test;
    // in the real CLI both read the same real terminal width. See
    // taskBoardInnerWidth's reservedColumns param for the width budget this
    // guards.
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 50,
    });

    try {
      const longTaskText =
        "Configure the continuous integration pipeline to run linting and unit tests on every pull request";

      const tree = render(
        React.createElement(SubagentTaskBoard, {
          board: {
            id: 3,
            label: "ci-setup",
            tasks: [
              {
                id: 1,
                state: "complete",
                text: "Read existing workflow files",
              },
              { id: 2, state: "running", text: longTaskText },
            ],
            activity: {
              stage: "running",
              message: "Running: npm test -- --watch=false",
            },
          },
        }),
      );

      try {
        const rendered = frame(tree);

        // Round border chrome from Ink's native borderStyle="round".
        expect(rendered).toContain("╭");
        expect(rendered).toContain("╰");

        // Progress summary header ("1/2 [bar] NN.N%").
        expect(rendered).toContain("1/2");
        expect(rendered).toMatch(/%/);

        // Every word of the long task description survives wrapping inside
        // the border, even on a narrow terminal — this is the exact
        // regression a bordered card without a properly reserved wrap width
        // would produce.
        const flattened = rendered.replace(/\n/g, " ");
        for (const word of longTaskText.split(" ")) {
          expect(flattened).toContain(word);
        }
      } finally {
        tree.unmount();
      }
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: originalColumns,
      });
    }
  });

  it("SubagentTaskBoard progress reaches 100% once every task is complete or failed", () => {
    const tree = render(
      React.createElement(SubagentTaskBoard, {
        board: {
          id: 5,
          label: "runner",
          tasks: [
            { id: 1, state: "complete", text: "Build" },
            { id: 2, state: "failed", text: "Deploy" },
          ],
        },
      }),
    );
    try {
      const rendered = frame(tree);
      expect(rendered).toContain("2/2");
      expect(rendered).toContain("100.0%");
    } finally {
      tree.unmount();
    }
  });

  it("SubagentTaskBoard hugs its content width instead of stretching to fill the terminal", () => {
    // Ink's implicit root container is flexDirection="column" with the
    // flexbox default alignItems="stretch", which would otherwise stretch
    // this bordered Box to the full parent width regardless of content —
    // alignSelf="flex-start" on the board's outer Box opts out of that.
    // A near-empty board is the clearest way to catch a regression here:
    // a stretched box would render a border spanning the whole (fake,
    // 100-column) test terminal instead of hugging the short title text.
    const tree = render(
      React.createElement(SubagentTaskBoard, {
        board: { id: 9, label: "idle", tasks: [] },
      }),
    );

    const borderLines = frame(tree)
      .split("\n")
      .filter((line) => line.includes("─"));

    expect(borderLines.length).toBeGreaterThan(0);
    for (const line of borderLines) {
      expect(line.length).toBeLessThan(40);
    }

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
